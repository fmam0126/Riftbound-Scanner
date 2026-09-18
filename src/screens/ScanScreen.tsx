/**
 * Scanner screen: hold a card under the camera and it is added to the collection.
 *
 * Flow
 * ----
 * 1. The user frames the whole card in the outline.
 * 2. A scan runs on a timer when Auto is on (see `useAutoScan`). OpenCV finds the
 *    card in the frame and rectifies it (see `scan/cardDetect.ts`), and the
 *    collector number is read from a strip of *that* card — so the outline is a
 *    hint for aiming rather than a measurement the crop depends on.
 * 3. A confident match is recorded immediately. Anything the matcher is unsure
 *    about opens a confirm sheet listing the alternatives.
 * 4. A card **already in the collection is still recorded**, adding another copy.
 *    The only thing suppressed is the same card being seen again immediately,
 *    which the loop's recent-sightings window decides.
 *
 * Auto is **off at startup**; the Scan button runs a single pass on demand. Both
 * paths share one lock in `useAutoScan`, so they can never issue overlapping
 * camera captures.
 *
 * An undo action is offered after a save, and it also clears the sightings
 * window so the same card can be scanned again straight away.
 *
 * The rectified card is shown as a thumbnail next to the diagnostics: it is the
 * clearest possible answer to "did the scanner find the card?", and it is the
 * same image that a future recogniser working from card art rather than from text
 * would be handed.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { CameraView, useCameraPermissions, type CameraCapturedPicture } from 'expo-camera';
import { useIsFocused } from '@react-navigation/native';
import * as Haptics from 'expo-haptics';
import type { CardRecord, MatchResult } from '../types.ts';
import { AUTO_ACCEPT_CONFIDENCE, describeMatchKind } from '../logic/match.ts';
import {
  CARD_ASPECT,
  createScanner,
  guideForViewport,
  regionWithinGuide,
  NUMBER_LABEL_IN_GUIDE,
  type CropRegion,
  type Scanner,
} from '../scan/ocr.ts';
import type { CardCrop } from '../scan/cardDetect.ts';
import { AUTO_SCAN_INTERVAL_MS, useAutoScan } from '../scan/useAutoScan.ts';
import { getDatabase } from '../data/cards.ts';
import { useCollection } from '../state/CollectionProvider.tsx';
import { Button, CardRow } from '../components/ui.tsx';
import { colors, fontSize, radius, spacing } from '../theme.ts';

type Phase = 'idle' | 'scanning' | 'confirm' | 'error';

export function ScanScreen(): React.JSX.Element {
  const { collection, recordScan, lastAdd, lastCopies, undoLastAdd } = useCollection();
  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<MatchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<string | null>(null);

  /**
   * The card as the last scan found and straightened it.
   *
   * Kept so it can be shown: a failed scan is far easier to understand when the
   * crop is visible next to it, and a *successful* one is only trustworthy
   * because the crop can be checked by eye.
   */
  const [lastCrop, setLastCrop] = useState<CardCrop | null>(null);

  /**
   * Whether the last crop is being looked at full size.
   *
   * A thumbnail says *whether* detection found the card; this says what it
   * actually cropped, which is what tuning the detector needs — and the corners
   * it was found at are printed alongside, since those are the numbers to compare
   * against the frame.
   */
  const [showCrop, setShowCrop] = useState(false);

  const [viewSize, setViewSize] = useState<{ width: number; height: number } | null>(null);

  /**
   * Continuous scanning.
   *
   * Off on startup: the loop captures and reads continuously, so it is opt-in
   * rather than something that begins the moment the app opens. The setting is
   * deliberately not persisted — every launch starts quiet.
   */
  const [autoScanEnabled, setAutoScanEnabled] = useState(false);

  /**
   * The most recent card the scanner recognised, and what happened to it.
   *
   * Shown as a live banner so it is always clear what the loop is seeing — with
   * a continuous scanner it would otherwise be hard to tell whether a card was
   * added, seen again too soon, or not recognised at all.
   */
  const [lastSeen, setLastSeen] = useState<{
    card: CardRecord;
    outcome: 'saved' | 'repeat';
    /** Copies owned after the change. */
    copies: number;
    /** True when this was an extra copy of a card already in the collection. */
    wasOwned?: boolean;
  } | null>(null);

  /**
   * Whether this tab is on screen.
   *
   * Tab screens stay mounted when you switch away, and a `CameraView` that is
   * left mounted while backgrounded comes back as a black preview — the session
   * is torn down but the component never re-initialises. Unmounting on blur and
   * mounting again on focus forces a clean camera start, which is what makes
   * returning to this tab work reliably.
   */
  const isFocused = useIsFocused();

  const cameraRef = useRef<CameraView>(null);

  /**
   * Whether the pass currently running was started by the Scan button.
   *
   * Both paths run through the same hook lock, so the handler cannot tell them
   * apart from its arguments. A ref is used rather than state because the value
   * must be readable synchronously by the detection callback.
   */
  const manualPassRef = useRef(false);

  // Built once: compiling the index on every scan would be wasteful, and the
  // database never changes while the app is running.
  const scanner: Scanner = useMemo(() => createScanner(getDatabase()), []);

  // `busy` comes from the auto-scan loop, which owns whether a pass is running;
  // it covers both the timer and the manual button.

  /**
   * The guide rectangle in layout pixels.
   *
   * Derived from the shared geometry so the outline the user aligns to is
   * exactly the rectangle the crop is computed from. Sizing it to the card's
   * true aspect ratio matters: the label strip is taken as a fraction of this
   * rectangle, so a differently-proportioned guide would crop the wrong band.
   */
  const guide = useMemo(() => {
    if (viewSize === null) return null;
    return guideForViewport(viewSize.width, viewSize.height);
  }, [viewSize]);

  /**
   * The same guide as fractions of the frame, which is what the crop needs.
   *
   * The preview and the captured photo share the same aspect ratio in portrait,
   * so fractional coordinates transfer directly. If a device ever disagrees, the
   * whole-card and full-frame fallback passes recover the read.
   *
   * `undefined` until the view has been measured, which tells `ocr.ts` to derive
   * the guide from the captured photo's own dimensions. Inventing a placeholder
   * guide here would override that correct value.
   */
  const guideFractions = useMemo<CropRegion | undefined>(() => {
    if (guide === null || viewSize === null || viewSize.width === 0 || viewSize.height === 0) {
      return undefined;
    }
    return {
      x: guide.x / viewSize.width,
      y: guide.y / viewSize.height,
      width: guide.width / viewSize.width,
      height: guide.height / viewSize.height,
    };
  }, [guide, viewSize]);

  /** Where the collector number sits inside the guide, drawn as a small hint. */
  const labelHint = useMemo(() => {
    if (guide === null) return null;
    const region = regionWithinGuide(
      { x: 0, y: 0, width: guide.width, height: guide.height },
      { ...NUMBER_LABEL_IN_GUIDE },
    );
    return {
      left: region.x,
      top: region.y,
      width: region.width,
      height: region.height,
    };
  }, [guide]);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setViewSize((current) =>
      current !== null && current.width === width && current.height === height
        ? current
        : { width, height },
    );
  }, []);

  /**
   * Captures one frame and resolves it to a match.
   *
   * Deliberately does not touch collection state or the phase: this is the input
   * to both the auto-scan loop and the manual button, and each decides separately
   * what to do with the result.
   */
  const captureOnce = useCallback(async (): Promise<MatchResult | null> => {
    if (cameraRef.current === null) return null;

    const photo: CameraCapturedPicture | undefined = await cameraRef.current.takePictureAsync({
      // Full quality: the collector number is small, so throwing away detail
      // with compression directly costs recognition accuracy.
      quality: 1,
      // Base64 is not needed; skipping it avoids a large string copy.
      base64: false,
    });

    if (photo === undefined) {
      throw new Error('Camera returned no image.');
    }

    const outcome = await scanner.scan(
      { uri: photo.uri, width: photo.width, height: photo.height },
      { guide: guideFractions },
    );

    const read = outcome.text.replace(/\s+/g, ' ').trim().slice(0, 60);
    // How the card was found, not just what it read: "no card in frame" and "a
    // card was found but the number was unreadable" need different fixes from the
    // user, and without this the two are indistinguishable.
    const found =
      outcome.card !== null
        ? `card ${outcome.card.width}×${outcome.card.height} ` +
        `(score ${outcome.card.score.toFixed(2)}, ${outcome.detection.durationMs}ms)`
        : `card ${outcome.detection.status}: ${outcome.detection.detail}`;

    setLastCrop(outcome.card);
    setDiagnostics(
      `${found} · ${outcome.pass} pass · ${outcome.durationMs}ms · ` +
      `${outcome.attempts.length} crop${outcome.attempts.length === 1 ? '' : 's'} · ` +
      `read ${JSON.stringify(read)}`,
    );

    return outcome.match;
  }, [guideFractions, scanner]);

  /**
   * Whether a match is good enough to save without asking.
   *
   * Deliberately does *not* consider whether the card is already owned. Owning a
   * card must not stop you scanning another copy of it — the only thing that
   * prevents a double-add is the auto-scan loop's recent-sightings window, which
   * catches a card being seen repeatedly while it sits under the camera.
   */
  const isConfidentMatch = useCallback((match: MatchResult): boolean => {
    if (match.best === null) return false;
    return (
      match.kind === 'exact' ||
      (match.kind === 'fuzzy' && match.best.confidence >= AUTO_ACCEPT_CONFIDENCE)
    );
  }, []);

  /** Handles a finished scan pass, from either the timer or the manual button. */
  const handleMatch = useCallback(
    (match: MatchResult | null, duplicate: boolean): void => {
      const manual = manualPassRef.current;
      setResult(match);

      if (match === null || match.kind === 'none' || match.best === null) {
        // The manual button reports a miss; the auto loop stays quiet, since it
        // retries every couple of seconds and would otherwise flash an error
        // continuously while the user lines the card up.
        if (manual) setPhase('error');
        return;
      }

      const card = match.best.card;
      const owned = collection.owned[card.key] !== undefined;

      // Seen a moment ago: the scanner is looking at the same card it just
      // handled, so acknowledge it and leave the collection alone.
      if (duplicate) {
        setLastSeen({ card, outcome: 'repeat', copies: collection.owned[card.key]?.copies ?? 0 });
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        setPhase('idle');
        return;
      }

      if (isConfidentMatch(match)) {
        // Another copy of a card already owned is expected and allowed; the
        // collection increments rather than creating a new entry.
        recordScan(card);
        setLastSeen({
          card,
          outcome: 'saved',
          copies: (collection.owned[card.key]?.copies ?? 0) + 1,
          wasOwned: owned,
        });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setPhase('idle');
        return;
      }

      // New card, but the read was not confident enough to save silently.
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      setPhase('confirm');
    },
    [collection.owned, isConfidentMatch, recordScan],
  );

  const { busy, runScan, resetDuplicateTracking } = useAutoScan({
    scan: captureOnce,
    enabled: autoScanEnabled && isFocused && permission?.granted === true,
    // Do not scan underneath the confirmation sheet; the user is mid-decision.
    paused: phase === 'confirm',
    onDetected: ({ result: match, duplicate }) => handleMatch(match, duplicate),
  });

  /**
   * Runs a single pass on demand.
   *
   * Goes through the hook's `runScan` so the manual button shares the loop's
   * re-entrancy lock — otherwise a tap and a timer tick could overlap and issue
   * two camera captures at once. The hook reports the result back through
   * `onDetected`, and marks it as manual so a miss is surfaced.
   */
  const handleCapture = useCallback(async () => {
    if (busy) return;
    if (cameraRef.current === null) {
      setError('Camera is not ready yet.');
      setPhase('error');
      return;
    }

    setPhase('scanning');
    setError(null);
    manualPassRef.current = true;

    try {
      await runScan();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Scan failed.');
      setPhase('error');
    } finally {
      manualPassRef.current = false;
    }
  }, [busy, runScan]);

  const confirmCard = useCallback(
    (card: CardRecord) => {
      recordScan(card);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setResult(null);
      setPhase('idle');
    },
    [recordScan],
  );

  const dismiss = useCallback(() => {
    setResult(null);
    setError(null);
    setPhase('idle');
  }, []);

  if (permission === null) {
    return <View style={styles.fill} />;
  }

  if (!permission.granted) {
    return (
      <View style={[styles.fill, styles.permission]}>
        <Text style={styles.permissionTitle}>Camera access needed</Text>
        <Text style={styles.permissionBody}>
          Riftbound Scanner reads the collector number printed on your cards. Everything is
          processed on this device and never uploaded.
        </Text>
        <Button
          label={permission.canAskAgain ? 'Allow camera' : 'Open settings'}
          onPress={() => void requestPermission()}
        />
      </View>
    );
  }

  return (
    <View style={styles.fill} onLayout={onLayout}>
      {/* The camera fills the screen as a background layer; every piece of UI is
          a sibling on top of it. `CameraView` ignores children — the overlay must
          not be nested inside it. The overlay is absolute for the same reason:
          as a plain sibling in a flex column it would be pushed below the
          full-height camera and never be seen.

          The camera is mounted only while this tab is focused, so returning to
          it always starts a fresh preview instead of showing a stale black
          frame. The overlay stays mounted either way, so the outline is already
          in place before the preview appears. */}
      {isFocused && (
        <CameraView
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          facing="back"
          animateShutter={false}
        />
      )}

      <View style={[StyleSheet.absoluteFill, styles.overlay]} pointerEvents="box-none">
        <View style={styles.topBar} pointerEvents="box-none">
          <Text style={styles.guideLabel}>
            {autoScanEnabled
              ? 'Hold the card inside the outline'
              : 'Fit the whole card inside the outline'}
          </Text>

          {/* With the loop off, say so explicitly — otherwise the screen looks
              broken rather than waiting for a tap. */}
          {!autoScanEnabled && (
            <View style={styles.liveBanner}>
              <Text style={styles.liveWaiting}>Tap Scan, or turn Auto on</Text>
            </View>
          )}

          {/* Live feedback for the scanning loop. Without it a continuous
              scanner gives no clue whether a card was added, seen again, or
              simply not recognised. */}
          {autoScanEnabled && (
            <View style={styles.liveBanner}>
              {lastSeen === null ? (
                <Text style={styles.liveWaiting}>
                  {busy ? 'Scanning…' : 'Waiting for a card…'}
                </Text>
              ) : (
                <Text
                  style={[
                    styles.liveText,
                    lastSeen.outcome === 'saved' ? styles.liveSaved : styles.liveRepeat,
                  ]}
                  numberOfLines={1}
                >
                  {lastSeen.outcome === 'saved'
                    ? lastSeen.wasOwned
                      ? `Added copy ${lastSeen.copies} · `
                      : 'Added '
                    : 'Seen again · '}
                  {lastSeen.card.id} {lastSeen.card.name}
                </Text>
              )}
            </View>
          )}
        </View>

        {guide !== null && (
          <View
            style={[
              styles.guideBox,
              {
                left: guide.x,
                top: guide.y,
                width: guide.width,
                height: guide.height,
              },
            ]}
            pointerEvents="none"
          >
            {/* Corner brackets read as a framing outline without boxing in
                the card, so the art underneath stays visible. */}
            <View style={[styles.corner, styles.cornerTL]} />
            <View style={[styles.corner, styles.cornerTR]} />
            <View style={[styles.corner, styles.cornerBL]} />
            <View style={[styles.corner, styles.cornerBR]} />

            {/* Shows which part of the card is read, so a failure is
                understandable rather than mysterious. */}
            {labelHint !== null && (
              <View
                style={[
                  styles.labelHint,
                  {
                    left: labelHint.left,
                    top: labelHint.top,
                    width: labelHint.width,
                    height: labelHint.height,
                  },
                ]}
              >
                <Text style={styles.labelHintText}>OGN-160/298</Text>
              </View>
            )}
          </View>
        )}

        <View style={styles.controls} pointerEvents="box-none">
          {lastAdd !== null && (
            <View style={styles.undoBanner}>
              <Text style={styles.undoText} numberOfLines={2}>
                {lastAdd.wasNew ? 'Added ' : 'Another copy of '}
                {lastAdd.cardName}
                {lastCopies !== null && lastCopies > 1 ? ` · ${lastCopies} copies` : ''}
              </Text>
              <Button
                label="Undo"
                variant="ghost"
                onPress={() => {
                  undoLastAdd();
                  // Let the same card be scanned again immediately rather than
                  // making the user wait out the duplicate cooldown.
                  resetDuplicateTracking();
                  setLastSeen(null);
                }}
              />
            </View>
          )}

          <View style={styles.controlRow}>
            {/* Manual fallback. The loop does the work, but an immediate retry
                is useful when the card is awkward to hold steady. */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Scan now"
              disabled={busy}
              onPress={() => void handleCapture()}
              style={({ pressed }) => [
                styles.shutter,
                { opacity: busy ? 0.6 : pressed ? 0.8 : 1 },
              ]}
            >
              {busy ? (
                <ActivityIndicator color="#04150E" />
              ) : (
                <Text style={styles.shutterText}>Scan</Text>
              )}
            </Pressable>

            <Pressable
              accessibilityRole="switch"
              accessibilityState={{ checked: autoScanEnabled }}
              accessibilityLabel="Continuous scanning"
              onPress={() => {
                setAutoScanEnabled((on) => !on);
                setLastSeen(null);
                resetDuplicateTracking();
              }}
              style={[styles.autoToggle, autoScanEnabled && styles.autoToggleOn]}
            >
              <Text
                style={[styles.autoToggleLabel, autoScanEnabled && styles.autoToggleLabelOn]}
              >
                Auto
              </Text>
              <Text style={[styles.autoToggleState, autoScanEnabled && styles.autoToggleLabelOn]}>
                {autoScanEnabled ? `every ${(AUTO_SCAN_INTERVAL_MS / 1000).toFixed(1)}s` : 'off'}
              </Text>
            </Pressable>
          </View>

          {lastCrop !== null || diagnostics !== null ? (
            <View style={styles.statusRow}>
              {/* The card OpenCV found, as read. Both a check that detection is
                  working and a preview of what an art-based recogniser would
                  have to work with. */}
              {lastCrop !== null && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Show the card as the scanner cropped it"
                  onPress={() => setShowCrop(true)}
                >
                  <Image source={{ uri: lastCrop.uri }} style={styles.cropPreview} />
                </Pressable>
              )}
              {diagnostics !== null && (
                <Text style={[styles.diagnostics, styles.diagnosticsInline]}>
                  {diagnostics}
                </Text>
              )}
            </View>
          ) : null}
        </View>
      </View>

      {phase === 'confirm' && result !== null && (
        <ConfirmSheet result={result} onPick={confirmCard} onCancel={dismiss} />
      )}

      {showCrop && lastCrop !== null && (
        <View style={styles.cropSheet}>
          <View style={styles.cropHeader}>
            <Text style={styles.sheetTitle}>Detected card</Text>
            <Text style={styles.sheetSubtitle}>
              {lastCrop.width}×{lastCrop.height} · score {lastCrop.score.toFixed(2)} · corners{' '}
              {lastCrop.corners
                .map(
                  (corner) =>
                    `${Math.round(corner.x * 100)}%,${Math.round(corner.y * 100)}%`,
                )
                .join(' ')}
            </Text>
          </View>
          {/* Contained rather than stretched: the point of looking at this is to
              see the crop's proportions and where the number sits on it. */}
          <Image
            source={{ uri: lastCrop.uri }}
            style={styles.cropFull}
            resizeMode="contain"
            accessibilityLabel="The card as the scanner cropped it"
          />
          <Button label="Close" variant="secondary" onPress={() => setShowCrop(false)} />
        </View>
      )}

      {phase === 'error' && (
        <View style={styles.errorSheet}>
          <Text style={styles.errorTitle}>No card recognised</Text>
          <Text style={styles.errorBody}>
            {error ?? result?.reason ?? 'Set the whole card inside the outline and try again.'}
          </Text>
          {diagnostics !== null && <Text style={styles.diagnostics}>{diagnostics}</Text>}
          <Button label="Try again" onPress={dismiss} />
        </View>
      )}
    </View>
  );
}

/**
 * Confirmation sheet for low-confidence or ambiguous reads.
 *
 * Shows every candidate the matcher considered, best first, so the user can
 * pick the right printing rather than re-scanning.
 */
function ConfirmSheet({
  result,
  onPick,
  onCancel,
}: {
  result: MatchResult;
  onPick: (card: MatchResult['candidates'][number]['card']) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const parsed = result.parsed;
  const confidence = result.best?.confidence ?? 0;

  return (
    <View style={styles.sheet}>
      <View style={styles.sheetHeader}>
        <Text style={styles.sheetTitle}>
          {result.kind === 'ambiguous' ? 'Which printing?' : 'Is this right?'}
        </Text>
        <Text style={styles.sheetSubtitle}>
          {parsed !== null ? `Read as ${parsed.setCodeRaw} ${parsed.number} · ` : ''}
          {describeMatchKind(result.kind)}
          {result.best !== null ? ` · ${Math.round(confidence * 100)}% sure` : ''}
        </Text>
      </View>

      <Text style={styles.sheetReason}>{result.reason}</Text>

      <ScrollView style={styles.sheetList} contentContainerStyle={styles.sheetListContent}>
        {result.candidates.map((candidate) => (
          <CardRow
            key={candidate.card.key}
            card={candidate.card}
            onPress={() => onPick(candidate.card)}
          />
        ))}
      </ScrollView>

      <Button label="Cancel" variant="secondary" onPress={onCancel} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.background,
  },
  permission: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.md,
  },
  permissionTitle: {
    color: colors.text,
    fontSize: fontSize.xl,
    fontWeight: '800',
    textAlign: 'center',
  },
  permissionBody: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    textAlign: 'center',
    lineHeight: 21,
    marginBottom: spacing.sm,
  },
  overlay: {
    justifyContent: 'space-between',
    padding: spacing.lg,
  },
  guideLabel: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '700',
    textAlign: 'center',
    textShadowColor: 'rgba(0, 0, 0, 0.8)',
    textShadowRadius: 4,
    marginTop: spacing.sm,
  },
  guideBox: {
    position: 'absolute',
    borderRadius: radius.sm,
  },
  corner: {
    position: 'absolute',
    width: 34,
    height: 34,
    borderColor: colors.accent,
  },
  cornerTL: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: radius.sm },
  cornerTR: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: radius.sm },
  cornerBL: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 3,
    borderLeftWidth: 3,
    borderBottomLeftRadius: radius.sm,
  },
  cornerBR: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 3,
    borderRightWidth: 3,
    borderBottomRightRadius: radius.sm,
  },
  labelHint: {
    position: 'absolute',
    borderWidth: 1,
    borderColor: 'rgba(61, 220, 151, 0.5)',
    borderStyle: 'dashed',
    borderRadius: radius.sm,
    alignItems: 'flex-start',
    justifyContent: 'flex-end',
    paddingLeft: 4,
    paddingBottom: 2,
  },
  labelHintText: {
    color: 'rgba(61, 220, 151, 0.75)',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  topBar: {
    gap: spacing.sm,
    alignItems: 'center',
  },
  liveBanner: {
    backgroundColor: colors.overlay,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  liveWaiting: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
  },
  liveText: {
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  liveSaved: {
    color: colors.accent,
  },
  liveRepeat: {
    color: colors.warn,
  },
  controls: {
    gap: spacing.md,
    alignItems: 'center',
  },
  controlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
  },
  autoToggle: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.overlay,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    minWidth: 84,
  },
  autoToggleOn: {
    borderColor: colors.accent,
    backgroundColor: colors.accentDark,
  },
  autoToggleLabel: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  autoToggleLabelOn: {
    color: colors.accent,
  },
  autoToggleState: {
    color: colors.textFaint,
    fontSize: fontSize.xs,
  },
  undoBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.overlay,
    borderRadius: radius.md,
    paddingLeft: spacing.md,
    paddingRight: spacing.xs,
    paddingVertical: spacing.xs,
    alignSelf: 'stretch',
  },
  undoText: {
    color: colors.text,
    fontSize: fontSize.sm,
    flex: 1,
  },
  shutter: {
    width: 96,
    height: 96,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 5,
    borderColor: 'rgba(255, 255, 255, 0.25)',
  },
  shutterText: {
    color: '#04150E',
    fontSize: fontSize.lg,
    fontWeight: '900',
    letterSpacing: 1,
  },
  diagnostics: {
    color: colors.textFaint,
    fontSize: fontSize.xs,
    alignSelf: 'stretch',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    alignSelf: 'stretch',
  },
  diagnosticsInline: {
    flex: 1,
  },
  cropPreview: {
    width: 54,
    // The card's own proportions, so the thumbnail is a card rather than a
    // square, and a bad crop is visible at a glance.
    aspectRatio: CARD_ASPECT,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '72%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderTopWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  sheetHeader: {
    gap: 2,
  },
  sheetTitle: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '800',
  },
  sheetSubtitle: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
  },
  sheetReason: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    lineHeight: 19,
  },
  sheetList: {
    flexGrow: 0,
  },
  sheetListContent: {
    paddingVertical: spacing.xs,
  },
  errorSheet: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    bottom: spacing.xl,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  cropSheet: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.background,
    padding: spacing.lg,
    paddingTop: spacing.xl,
    gap: spacing.md,
  },
  cropHeader: {
    gap: 2,
  },
  cropFull: {
    flex: 1,
    width: '100%',
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  errorTitle: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '800',
  },
  errorBody: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    lineHeight: 20,
    marginBottom: spacing.xs,
  },
});
