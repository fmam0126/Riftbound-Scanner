/**
 * Auto-scan loop for the scanner screen.
 *
 * Repeatedly runs a scan and reports what it found, so the user can hold a card
 * under the camera instead of tapping a button. Two rules keep this from
 * misbehaving:
 *
 *  - **One scan at a time.** A capture plus OCR pass takes a few hundred
 *    milliseconds, so a naive interval would stack overlapping scans and thrash
 *    the camera. The next tick is only scheduled after the previous pass has
 *    finished, and skipped entirely while one is in flight.
 *  - **The same card is not counted twice in a row.** A card held in frame is
 *    seen on every tick, so without this a single card would be added several
 *    times a second. A repeat of one of the last few cards seen is reported as
 *    `duplicate` and left to the caller to ignore.
 *
 * The repeat window is measured in *cards*, not seconds. To scan several copies
 * of the same card, show a different card in between: moving it out of the last
 * few sightings is what makes it countable again.
 *
 * The loop stops while the screen is not focused (navigating away), while a
 * confirmation sheet is open, or when the user turns it off.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { CardRecord, MatchResult } from '../types.ts';

/** How often to attempt a scan, in milliseconds. */
export const AUTO_SCAN_INTERVAL_MS = 1800;

/**
 * How many of the most recent *distinct* cards count as repeats.
 *
 * The window advances when a different card is seen, not on every tick, so a
 * card held under the camera stays inside it and is never re-added. Scanning
 * another copy of the same card means showing this many other cards in between.
 */
export const DUPLICATE_HISTORY_SIZE = 3;

export interface AutoScanDetection {
  /**
   * The card the loop resolved.
   *
   * Never null: `runOnce` returns early when nothing matched, so a detection only
   * exists for a real card.
   */
  card: CardRecord;
  /** Full match, for diagnostics and the confidence reading. */
  result: MatchResult;
  /** True when this repeats one of the last {@link DUPLICATE_HISTORY_SIZE} cards. */
  duplicate: boolean;
  at: number;
}

/**
 * Whether a card repeats one of the most recently seen cards.
 *
 * Pure so the rule can be tested directly. A card held under the camera is seen
 * on every tick, so without this it would be added several times a second.
 *
 * `recent` is ordered oldest-first and holds the last few *distinct* cards. It
 * holds more than the single most recent card because a card being swept past
 * the camera can flicker between two readings, and if only the last card were
 * remembered that flicker would make the real card count twice.
 */
export function isDuplicateSighting(recent: readonly string[], key: string): boolean {
  return recent.includes(key);
}

/**
 * Adds a sighting to the recent list, keeping the most recent
 * {@link DUPLICATE_HISTORY_SIZE} distinct cards.
 *
 * A card already in the list keeps its place rather than being moved to the
 * front. That is what makes the window count *other cards seen*, not ticks: a
 * card sitting under the camera refreshes nothing, so it stays inside the window
 * and cannot be re-added, while showing a different card pushes it towards the
 * edge. After enough other cards, the same card can be scanned again for another
 * copy.
 *
 * Returns a new array so callers can hold it in a ref without aliasing.
 */
export function recordSighting(
  recent: readonly string[],
  key: string,
  historySize: number = DUPLICATE_HISTORY_SIZE,
): string[] {
  if (recent.includes(key)) return [...recent];
  const next = [...recent, key];
  return next.length > historySize ? next.slice(next.length - historySize) : next;
}

export interface AutoScanOptions {
  /**
   * Performs one scan. Should resolve with a match; the hook decides what to do
   * with it. Resolving `null` means the attempt produced nothing usable.
   */
  scan: () => Promise<MatchResult | null>;
  /** Called for every detection the caller should act on. */
  onDetected: (detection: AutoScanDetection) => void;
  /** Master switch; also gates the interval entirely. */
  enabled: boolean;
  /** Pause without disabling, e.g. while a confirmation sheet is open. */
  paused?: boolean;
  intervalMs?: number;
  /** How many recent cards count as repeats. Defaults to 3. */
  historySize?: number;
}

export interface AutoScanControls {
  /** True while a scan pass is running. */
  busy: boolean;
  /**
   * Runs a scan immediately, on the same lock as the loop.
   *
   * The manual button must use this rather than calling its own scan, otherwise a
   * tap and a timer tick can overlap and issue two camera captures at once. It
   * also never treats the result as a repeat, since a press is an explicit
   * request, and it works while the loop is switched off.
   */
  runScan: () => Promise<void>;
  /**
   * Forgets recent sightings.
   *
   * The screen calls this after an undo, so the user can immediately re-scan the
   * card they just removed.
   */
  resetDuplicateTracking: () => void;
}

/**
 * Runs the scan loop and reports detections.
 *
 * `scan` and `onDetected` are held in refs rather than read from the closure.
 * Both are naturally re-created on every render (the caller's handler depends on
 * collection state that changes after every scan), so depending on their
 * identity would restart the timer — and reset the recent-sightings window —
 * every time a card was saved, which is exactly when it must keep running.
 */
export function useAutoScan(options: AutoScanOptions): AutoScanControls {
  const {
    scan,
    onDetected,
    enabled,
    paused = false,
    intervalMs = AUTO_SCAN_INTERVAL_MS,
    historySize = DUPLICATE_HISTORY_SIZE,
  } = options;

  const [busy, setBusy] = useState(false);

  // Refs so the loop reads current values without being re-created by them.
  const scanRef = useRef(scan);
  const onDetectedRef = useRef(onDetected);
  const busyRef = useRef(false);
  /** Most recently seen card keys, oldest first. */
  const recentRef = useRef<string[]>([]);
  const mountedRef = useRef(true);
  /** Lets an in-flight pass tell that the loop was switched off under it. */
  const enabledRef = useRef(enabled);

  scanRef.current = scan;
  onDetectedRef.current = onDetected;
  enabledRef.current = enabled;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * Runs one scan pass.
   *
   * `busyRef` is the only *synchronous* re-entrancy lock, which is why both the
   * timer and the manual button must go through here. Guarding the manual path on
   * the `busy` state alone would let a tap and a timer tick overlap, putting two
   * camera captures in flight at once.
   *
   * `source` controls two things: a manual press is never treated as a repeat
   * (it is an explicit request), and a manual press still works when the loop is
   * switched off.
   */
  const runOnce = useCallback(
    async (source: 'auto' | 'manual'): Promise<void> => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);

      try {
        const result = await scanRef.current();
        if (!mountedRef.current) return;
        if (result === null || result.best === null || result.kind === 'none') return;

        // The loop may have been switched off, or the tab left, while this pass
        // was running. Reporting the result anyway would act on the user's
        // request to stop.
        if (source === 'auto' && !enabledRef.current) return;

        const card = result.best.card;
        const now = Date.now();
        const duplicate =
          source === 'auto' && isDuplicateSighting(recentRef.current, card.key);

        // Record every sighting, including repeats. `recordSighting` leaves a
        // repeated card where it is rather than refreshing it, so the window
        // advances only when a *different* card is seen — which is what keeps a
        // card sitting under the camera inside the window and suppresses it.
        recentRef.current = recordSighting(recentRef.current, card.key, historySize);

        onDetectedRef.current({ card, result, duplicate, at: now });
      } catch (error) {
        // A failed pass is not fatal; the next tick tries again.
        console.warn('Auto-scan pass failed:', error);
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
    },
    [historySize],
  );

  /** Runs a pass on demand, e.g. from the Scan button. */
  const runScan = useCallback((): Promise<void> => runOnce('manual'), [runOnce]);

  useEffect(() => {
    if (!enabled || paused) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Self-scheduling rather than setInterval: the gap starts after each pass
    // finishes, so a slow OCR pass cannot cause overlapping captures.
    const tick = async (): Promise<void> => {
      if (cancelled) return;
      await runOnce('auto');
      if (cancelled) return;
      timer = setTimeout(() => void tick(), intervalMs);
    };

    timer = setTimeout(() => void tick(), intervalMs);

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [enabled, paused, intervalMs, runOnce]);

  /** Forgets recent sightings, e.g. after an undo so the card can be re-scanned. */
  const resetDuplicateTracking = useCallback(() => {
    recentRef.current = [];
  }, []);

  return { busy, runScan, resetDuplicateTracking };
}
