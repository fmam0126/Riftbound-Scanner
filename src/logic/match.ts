/**
 * Matches OCR-parsed card identifiers against the bundled card database.
 *
 * Design notes
 * ------------
 * The collector number is the primary key: it is short, printed in isolation,
 * and unique within a set. The set code is the secondary key. So the matcher
 * enumerates *all* candidate set codes within a fuzzy threshold of the read,
 * then within each set looks for the exact number and, failing that, a number
 * one digit off in the units place.
 *
 * That two-axis search is what makes a total misread like `0GN O1O` resolve:
 * `0GN` is a pure confusion match for `OGN`, and `O1O` repairs to `010`.
 *
 * Confidence is computed per field from how much had to be corrected, and the
 * two are multiplied so errors compound (see {@link confidenceFor}).
 *
 * When several printings genuinely tie — same number, same cost, differing only
 * by an art qualifier — the result is reported as `ambiguous` so the UI asks,
 * rather than silently picking one and corrupting the collection. A read that
 * omits the art letter is *not* that case: the base printing is ranked strictly
 * ahead, because the letter is too small to depend on.
 */

import type {
  CardDatabase,
  CardMatch,
  CardRecord,
  MatchKind,
  MatchResult,
  ParsedCardId,
} from '../types.ts';
import {
  numberDistance,
  weightedDistance,
} from './normalize.ts';
import { parseCardId, parseCardIds, resolveSetCode, tokenize } from './parseOcr.ts';

/**
 * How far a read set code may be from a real one and still be considered.
 * 0.9 admits up to three visual confusions (`0GN` for `OGN`) while rejecting
 * one genuine wrong letter, which is what keeps `XGN` from reaching `OGN`.
 */
const SET_CANDIDATE_THRESHOLD = 0.9;
/**
 * Best candidates further than this behind the leader are discarded. A small
 * window keeps genuine base/alternate-art ties while dropping noise.
 */
const CANDIDATE_WINDOW = 0.4;
/** Two candidates this close are treated as a genuine tie requiring user input. */
const AMBIGUITY_EPSILON = 0.05;
/**
 * Absolute ceiling on a candidate's correction cost.
 *
 * Without this, a real card number that is merely *nearest* to the read would
 * be returned: `OGN 998` is not a card, but `198` and `298` are each one digit
 * away, so the window would happily offer both. Beyond this cost the read is
 * treated as not corresponding to any card at all, which is the honest answer.
 *
 * The largest plausible cost is one number error in the units place (0.5) plus
 * three set-code confusions (0.9), so 1.6 admits every read worth believing.
 */
const MAX_CANDIDATE_COST = 1.6;
/** Below this confidence the UI asks the user to confirm instead of auto-adding. */
export const AUTO_ACCEPT_CONFIDENCE = 0.7;

/** Pre-processed lookup structure built once per database. */
export interface CardIndex {
  sets: readonly string[];
  cards: readonly CardRecord[];
}

export function buildIndex(db: CardDatabase): CardIndex {
  return {
    sets: db.sets.map((s) => s.code),
    cards: db.cards,
  };
}

/**
 * Every real set code plausibly intended by `raw`, best (lowest distance) first.
 *
 * Returning a list rather than a single winner matters because OCR of a 3-letter
 * code can be genuinely ambiguous until the number disambiguates it.
 */
export function candidateSetCodes(
  raw: string,
  knownSets: readonly string[],
  threshold = SET_CANDIDATE_THRESHOLD,
): string[] {
  const upper = raw.toUpperCase();
  const scored: Array<{ code: string; distance: number }> = [];

  for (const code of knownSets) {
    const distance = weightedDistance(upper, code);
    if (distance <= threshold) scored.push({ code, distance });
  }

  scored.sort((a, b) => a.distance - b.distance || a.code.localeCompare(b.code));
  return scored.map((s) => s.code);
}

/**
 * Per-correction confidence penalties.
 *
 * Set code and number are scored separately because they are not comparable
 * quantities. A misread set code is one of a handful of known alternatives and
 * is therefore quite safe to correct; a misread digit is intrinsically more
 * dangerous, because the digit is what identifies the card within its set.
 */
const SET_CORRECTION_PENALTY = 0.65;
const NUMBER_CORRECTION_PENALTY = 0.55;
/** Correction cost at or above which a field is treated as fully unreliable. */
const CORRECTION_CEILING = 1.5;

/**
 * Converts per-field correction costs into a 0–1 confidence.
 *
 * The two fields multiply, so errors compound:
 *   0 / 0      exact read                              -> 1.0
 *   0.3 set    one set confusion (0GN for OGN)          -> ~0.87
 *   0.5 number one digit wrong in the units place       -> ~0.82
 *   0.3 / 0.5  a realistic two-glyph misread             -> ~0.60
 *   1.0 / 0.5  barely plausible                          -> ~0
 *
 * A confidence of exactly 1 is reserved for a read needing no correction at all,
 * so the UI can distinguish "certain" from "highly likely".
 */
function confidenceFor(setDistance: number, numDistance: number): number {
  const penalise = (distance: number, perUnit: number): number => {
    if (distance === 0) return 1;
    const scaled = Math.min(1, distance / CORRECTION_CEILING);
    return (1 - scaled) * perUnit + (1 - perUnit) * (1 - scaled) ** 2;
  };
  const value =
    penalise(setDistance, SET_CORRECTION_PENALTY) *
    penalise(numDistance, NUMBER_CORRECTION_PENALTY);
  return Math.max(0, Math.min(1, value));
}

interface Candidate {
  card: CardRecord;
  setDistance: number;
  numDistance: number;
  total: number;
}

/**
 * Scores every card that could plausibly be the parsed identifier.
 *
 * A read with no variant letter is compatible with any variant printing, since
 * the printed base number is a prefix of the variant number. The base printing
 * nevertheless comes out strictly ahead of the art variant, so reading `007`
 * ranks `007` above `007a`.
 */
export function findCandidates(index: CardIndex, parsed: ParsedCardId): Candidate[] {
  const codes = candidateSetCodes(parsed.setCodeRaw, index.sets);
  if (codes.length === 0) return [];

  const candidates: Candidate[] = [];

  for (const code of codes) {
    const setDistance = weightedDistance(parsed.setCodeRaw.toUpperCase(), code);
    if (setDistance > SET_CANDIDATE_THRESHOLD) continue;

    for (const card of index.cards) {
      if (card.setCode !== code) continue;

      // The prefix is part of the printed number (`T01` vs `01`), so a
      // mismatch means a different printing. Without this, the sister cards
      // numbered `01` and `001` collide numerically and swamp every result.
      if (parsed.prefix.toUpperCase() !== card.prefix.toUpperCase()) continue;

      const numDistance = numberDistance(parsed.number, card.number);
      if (!Number.isFinite(numDistance)) continue;

      // A read with no variant letter is compatible with any variant printing,
      // since the printed base number is a prefix of the variant number. The
      // base printing must nevertheless come out strictly ahead of the art
      // variant, so that reading `007` ranks `007` above `007a`.
      let variantPenalty = 0;
      if (parsed.variant.length > 0) {
        // The read named a specific art letter, so a different printing is a
        // different card.
        variantPenalty = parsed.variant === card.variant ? 0 : 0.5;
      } else if (card.variant.length > 0) {
        // Reading `010` when the card could be `010a`: plausible (the letter is
        // tiny) but strictly worse than the exact-number printing.
        variantPenalty = 0.25;
      }

      candidates.push({
        card,
        setDistance,
        numDistance,
        // Set code is the governing field: a wrong set means a wrong card no
        // matter how well the number matched, so it is weighted heavier than a
        // number correction.
        total: setDistance * 2.5 + numDistance + variantPenalty,
      });
    }
  }

  candidates.sort(
    (a, b) =>
      // Cost is the primary ordering. Only when two cards cost exactly the same
      // should any preference apply.
      a.total - b.total ||
      // At equal cost prefer the base printing over an art variant, so reading
      // `007` offers `007` ahead of `007a` deterministically.
      a.card.variant.length - b.card.variant.length ||
      // Final tiebreak keeps the ordering stable across runs.
      a.card.key.localeCompare(b.card.key),
  );

  if (candidates.length === 0) return [];

  const bestTotal = (candidates[0] as Candidate).total;
  // Reject everything when the best available explanation is still implausible.
  if (bestTotal > MAX_CANDIDATE_COST) return [];
  return candidates.filter((c) => c.total <= bestTotal + CANDIDATE_WINDOW).slice(0, 6);
}

/** Builds a {@link CardMatch} from a scored candidate. */
function toMatch(candidate: Candidate, parsed: ParsedCardId, kind: MatchKind): CardMatch {
  const exact =
    candidate.setDistance === 0 &&
    candidate.numDistance === 0 &&
    parsed.variant === candidate.card.variant;
  return {
    card: candidate.card,
    confidence: exact ? 1 : confidenceFor(candidate.setDistance, candidate.numDistance),
    kind,
  };
}

/**
 * Matches a single parsed identifier against the database.
 *
 * This is the pure core of a scan. Everything above it (camera, OCR, UI) is
 * plumbing; all the accuracy lives here, which is why it is unit tested
 * against real OCR misreads.
 */
export function matchParsed(index: CardIndex, parsed: ParsedCardId): MatchResult {
  const candidates = findCandidates(index, parsed);

  if (candidates.length === 0) {
    return {
      kind: 'none',
      parsed,
      best: null,
      candidates: [],
      reason: `No card found for ${parsed.setCodeRaw} ${parsed.number}.`,
    };
  }

  const leader = candidates[0] as Candidate;
  const resolvedSet = resolveSetCode(parsed, index.sets);
  const exactBoth = leader.setDistance === 0 && leader.numDistance === 0;

  // A genuine tie (same distance) usually means base vs alternate art, or two
  // sets that share a number and read similarly. Ask the user.
  const tied = candidates.filter((c) => c.total <= leader.total + AMBIGUITY_EPSILON);
  const isAmbiguous = tied.length > 1;

  let kind: MatchKind;
  if (isAmbiguous) kind = 'ambiguous';
  else if (exactBoth) kind = 'exact';
  else kind = 'fuzzy';

  const matches = candidates.map((c) => toMatch(c, parsed, kind));

  let reason: string;
  if (isAmbiguous) {
    reason =
      tied.length === 2 && tied.every((c) => c.numDistance === 0)
        ? `Number ${parsed.number} has more than one printing — pick the one you scanned.`
        : 'Several cards are equally close to this read — pick the right one.';
  } else if (kind === 'exact') {
    reason = `Read ${resolvedSet ?? parsed.setCodeRaw}-${parsed.number} exactly.`;
  } else {
    const parts: string[] = [];
    if (leader.setDistance > 0) {
      parts.push(`set "${parsed.setCodeRaw}" corrected to ${leader.card.setCode}`);
    }
    if (leader.numDistance > 0) {
      parts.push(`number "${parsed.number}" corrected to ${leader.card.number}`);
    }
    reason =
      parts.length > 0
        ? `Matched with OCR correction: ${parts.join(', ')}.`
        : 'Close match.';
  }

  return {
    kind,
    parsed,
    best: matches[0] ?? null,
    candidates: matches,
    reason,
  };
}

/**
 * Matches raw OCR text, considering multiple card occurrences in the text.
 *
 * Tries each parseable identifier in the text and returns the most confident
 * result, so a photo containing several cards resolves to the clearest one.
 */
export function matchOcrText(index: CardIndex, text: string): MatchResult {
  const parsedList = parseCardIds(text, index.sets);

  if (parsedList.length === 0) {
    // Fall back to the single-best parse so the "saw a number but no set code"
    // guidance still works for messy reads.
    const single = parseCardId(text, index.sets);
    if (single === null) {
      const hasNumberish = tokenize(text).some((t) =>
        /[0-9OQDISZBGTL]{3}/i.test(t.text),
      );
      return {
        kind: 'none',
        parsed: null,
        best: null,
        candidates: [],
        reason: hasNumberish
          ? 'Saw a number but could not read the set code — try centring the card number.'
          : 'No collector number found — point the box at the number at the bottom of the card.',
      };
    }
    return matchParsed(index, single);
  }

  let best: MatchResult | null = null;
  for (const parsed of parsedList) {
    const result = matchParsed(index, parsed);
    if (result.kind === 'exact') return result;
    if (result.best === null) continue;
    if (best === null || best.best === null || result.best.confidence > best.best.confidence) {
      best = result;
    }
  }

  if (best !== null) return best;

  // Identifiers were found but none correspond to a card.
  const first = parsedList[0] as ParsedCardId;
  return {
    kind: 'none',
    parsed: first,
    best: null,
    candidates: [],
    reason: `No card found for ${first.setCodeRaw} ${first.number}.`,
  };
}

/**
 * Convenience helper used by the UI to label how a match was reached.
 */
export function describeMatchKind(kind: MatchKind): string {
  switch (kind) {
    case 'exact':
      return 'Exact read';
    case 'fuzzy':
      return 'Corrected OCR';
    case 'ambiguous':
      return 'Needs confirmation';
    case 'none':
      return 'No match';
  }
}
