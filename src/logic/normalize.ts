/**
 * Text normalisation helpers shared by the OCR parser and the matcher.
 *
 * The whole point of this module is that ML Kit reads card numbers imperfectly.
 * The printed identifier is tiny, high-contrast, and uses a condensed font
 * where several glyph pairs are nearly identical at camera resolution:
 *
 *   0 <-> O     1 <-> I/L    5 <-> S    8 <-> B
 *   2 <-> Z     6 <-> G       7 <-> T    4 <-> A     9 <-> q/g
 *
 * So rather than trying to make OCR perfect, we model those confusions
 * explicitly and let the matcher score candidates by how many confusions would
 * have to be true. That is what makes "0GN O1O" resolve confidently to
 * `OGN-010` while still rejecting genuinely wrong reads.
 */

/**
 * Characters that OCR commonly confuses, grouped into equivalence classes.
 *
 * Each inner string is one class: any two characters inside it may be mistaken
 * for one another at card-number size. The first character is the canonical
 * representative used by {@link confusionClass}.
 *
 * `0` and `O` are deliberately in the *same* class. An earlier revision put
 * them in separate groups keyed by a canonical form, which silently made
 * `isConfusable('0', 'O')` false — the single most common OCR confusion there
 * is. Membership, not a canonical lookup, is what decides confusability.
 */
const CONFUSION_CLASSES: readonly string[] = [
  '0OQD',
  '1IL',
  '2Z',
  '5S',
  '8B',
  '6G',
  '7T',
  '4A',
  '9G',
];

/** Uppercase char -> index of the confusion class it belongs to. */
const CONFUSION_GROUP: ReadonlyMap<string, number> = (() => {
  const index = new Map<string, number>();
  CONFUSION_CLASSES.forEach((group, groupIndex) => {
    for (const ch of group) {
      if (!index.has(ch)) index.set(ch, groupIndex);
    }
  });
  return index;
})();

/**
 * True when `a` and `b` are the same character, or may be confused by OCR.
 *
 * Case insensitive, and true for identical characters.
 */
export function isConfusable(a: string, b: string): boolean {
  if (a === b) return true;
  const ua = a.toUpperCase();
  const ub = b.toUpperCase();
  if (ua === ub) return true;
  const ga = CONFUSION_GROUP.get(ua);
  const gb = CONFUSION_GROUP.get(ub);
  return ga !== undefined && ga === gb;
}

/**
 * Canonical representative of a character's confusion class, uppercased.
 * Characters with no known confusion map to themselves.
 */
export function confusionClass(ch: string): string {
  const upper = ch.toUpperCase();
  const groupIndex = CONFUSION_GROUP.get(upper);
  if (groupIndex === undefined) return upper;
  return (CONFUSION_CLASSES[groupIndex] as string)[0] as string;
}

/** Substitution cost when two characters are in the same confusion class. */
const CONFUSION_COST = 0.3;
/** Substitution cost for an unrelated character. */
const MISS_COST = 1;

/**
 * Distance between two short codes where visually-similar substitutions are
 * cheap.
 *
 * Used for set-code comparison, where `0GN` vs `OGN` must score far better than
 * `0GN` vs `SFI`.
 *
 * Equal-length inputs are compared position-by-position rather than through
 * full Levenshtein. That distinction matters: with edit distance, the cheapest
 * way to turn `0GN` into `OGN` is often a deletion plus an insertion (cost 2)
 * instead of the single cheap substitution (cost 0.3), and the minimum wins — so
 * the obviously-closest set code scored worse than an unrelated one. Set codes
 * are fixed-width identifiers, so positional comparison is both cheaper and
 * correct. Unequal lengths still allow insertions and deletions, which is what
 * makes a truncated read like `RB` comparable to `RBUN`.
 */
export function weightedDistance(a: string, b: string): number {
  const s = a.toUpperCase();
  const t = b.toUpperCase();
  if (s === t) return 0;
  if (s.length === 0) return t.length;
  if (t.length === 0) return s.length;

  if (s.length === t.length) {
    let total = 0;
    for (let i = 0; i < s.length; i += 1) {
      const sc = s[i] as string;
      const tc = t[i] as string;
      // Identical characters are free. This must be checked first:
      // `isConfusable` is intentionally true for a character and itself, so
      // using it alone would charge a confusion for every matching position.
      if (sc === tc) continue;
      total += isConfusable(sc, tc) ? CONFUSION_COST : MISS_COST;
    }
    return total;
  }

  let previous = new Array<number>(t.length + 1);
  let current = new Array<number>(t.length + 1);

  for (let j = 0; j <= t.length; j += 1) previous[j] = j;

  for (let i = 1; i <= s.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= t.length; j += 1) {
      const substitutionCost = isConfusable(s[i - 1] as string, t[j - 1] as string)
        ? CONFUSION_COST
        : MISS_COST;
      const deletion = (previous[j] as number) + 1;
      const insertion = (current[j - 1] as number) + 1;
      const substitution = (previous[j - 1] as number) + substitutionCost;
      current[j] = Math.min(deletion, insertion, substitution);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }

  return previous[t.length] as number;
}

/** Similarity in 0..1 derived from {@link weightedDistance}. */
export function weightedSimilarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return Math.max(0, 1 - weightedDistance(a, b) / longest);
}

/**
 * True when two strings differ *only* by known OCR confusions.
 *
 * `isConfusionEquivalent('0GN', 'OGN') === true`; `('0GN', 'SFI') === false`.
 */
export function isConfusionEquivalent(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!isConfusable(a[i] as string, b[i] as string)) return false;
  }
  return true;
}

/**
 * Rewrites a token to its most likely intended form, given a *shape* of which
 * positions must be letters and which must be digits.
 *
 * `shape` uses `A` for a letter position and `9` for a digit position, e.g.
 * `repairByShape('0GN', 'AAA') === 'OGN'` and `repairByShape('O1O', '999') === '010'`.
 * This is the trick that makes a fully-garbled read usable: once we know where
 * the set code sits and where the number sits, each character can be snapped to
 * the correct alphabet independently.
 */
export function repairByShape(token: string, shape: string): string {
  let out = '';
  for (let i = 0; i < token.length; i += 1) {
    const ch = token[i] as string;
    const want = shape[i] ?? shape[shape.length - 1];
    if (want === 'A') {
      out += LETTER_FROM_DIGIT[ch] ?? ch.toUpperCase();
    } else if (want === '9') {
      out += DIGIT_FROM_LETTER[ch] ?? ch;
    } else {
      out += ch.toUpperCase();
    }
  }
  return out;
}

const LETTER_FROM_DIGIT: Readonly<Record<string, string>> = {
  '0': 'O',
  '1': 'I',
  '2': 'Z',
  '4': 'A',
  '5': 'S',
  '6': 'G',
  '7': 'T',
  '8': 'B',
  '9': 'G',
};

const DIGIT_FROM_LETTER: Readonly<Record<string, string>> = {
  O: '0',
  Q: '0',
  D: '0',
  I: '1',
  L: '1',
  Z: '2',
  A: '4',
  S: '5',
  G: '6',
  T: '7',
  B: '8',
};

/** Strips everything that is not a letter or digit and uppercases the result. */
export function alphanumeric(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Normalises a card name for search: lowercase, strip punctuation, collapse
 * whitespace, and drop the parenthesised printing qualifiers TCGplayer appends
 * (e.g. `Fury Rune (Alternate Art)` -> `fury rune`).
 */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Parses a printed number token into an integer, ignoring leading zeros. */
export function numberOf(token: string): number | null {
  const digits = token.replace(/\D/g, '');
  if (digits.length === 0) return null;
  const n = Number.parseInt(digits, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Multiplier applied to a digit error based on its decimal place.
 *
 * The hundreds digit is worth far more than the units digit, both visually (a
 * change there is a large, easily-spotted difference) and factually (it moves
 * the number by a hundred). Without this weighting, reading `998` matched
 * `198` exactly as readily as a genuine units-place misread, because both
 * differ by "one digit".
 *
 * The units digit costs exactly 0.5, so only a units-place error can fall at
 * or below the acceptance threshold; the tens place costs 0.6 and the hundreds
 * place a full 1.0.
 */
function placeWeight(distanceFromRight: number): number {
  if (distanceFromRight === 0) return 0.5; // units
  if (distanceFromRight === 1) return 0.6; // tens
  return 1; // hundreds and above
}

/**
 * Weighted digit-level edit distance between two equal-length digit strings.
 *
 * Only ever computed after the caller has established that exactly one digit
 * differs, so in practice this returns the weight of that single place.
 */
export function digitDistance(a: string, b: string): number {
  let total = 0;
  for (let i = 0; i < a.length; i += 1) {
    const ca = a[i] as string;
    const cb = b[i] as string;
    if (ca === cb) continue;
    total += placeWeight(a.length - 1 - i);
  }
  return total;
}

/**
 * Compares two printed card numbers, tolerating a plausible OCR digit error.
 *
 * Returns 0 for an identical number and a positive penalty otherwise. Because
 * the comparison is numeric, zero padding is irrelevant: `010`, `10` and `0010`
 * all compare equal, which is what we want — leading zeros on a collector
 * number vary by set but never identify the card.
 *
 * Returns `Infinity` — no match at all — unless the numbers differ by exactly
 * one digit **and** that digit is in the units place. Anything else moves the
 * number far enough that treating it as a misread would let `744` "match"
 * `144`, or `998` "match" `198`, which are different cards.
 */
export function numberDistance(a: string, b: string): number {
  const na = numberOf(a);
  const nb = numberOf(b);
  if (na === null || nb === null) {
    return a === b ? 0 : Number.POSITIVE_INFINITY;
  }
  if (na === nb) return 0;

  const sa = String(na);
  const sb = String(nb);

  // Numeric equality already covered every zero-padding case, so a differing
  // digit count here means the numbers are genuinely different lengths.
  if (sa.length !== sb.length) return Number.POSITIVE_INFINITY;

  let differences = 0;
  for (let i = 0; i < sa.length; i += 1) {
    if (sa[i] !== sb[i]) differences += 1;
  }
  if (differences !== 1) return Number.POSITIVE_INFINITY;

  const distance = digitDistance(sa, sb);
  return distance <= 0.5 ? distance : Number.POSITIVE_INFINITY;
}
