/**
 * Turns raw OCR text from a Riftbound card into a structured card identifier.
 *
 * A physical Riftbound card prints `OGN-010` (set code, then the collector
 * number) at the bottom-left. ML Kit will rarely return that cleanly. Real
 * observations we design for:
 *
 *   "OGN-010"          -> clean
 *   "OGN 010"          -> space instead of hyphen (most common)
 *   "0GN O10"          -> every ambiguous glyph misread
 *   "OGN\n010"         -> the two halves land in different OCR lines
 *   "OGN-010a"         -> alternate-art printing with a letter suffix
 *   "og n 010"         -> stray whitespace splitting the code
 *
 * The strategy is: find the *number* first using a deliberately permissive
 * regex, then look near it for a token that is either a known set code or a
 * confusion-equivalent of one. Anchoring on the number avoids the trap of
 * matching set-code-like words (e.g. the word "SGN" in rules text) with no
 * number attached.
 */

import type { ParsedCardId } from '../types.ts';
import {
  isConfusionEquivalent,
  numberOf,
  repairByShape,
  weightedDistance,
} from './normalize.ts';

/**
 * Permissive number pattern, anchored on 3 digits (all Riftbound collector
 * numbers are 3 digits) with optional letter prefix/suffix used by promos and
 * alternate arts.
 *
 * Accepts OCR digits `0`, `1`, `5`, `6`, `8` *and* the letters they are
 * confusable with. Requires at least one solid digit somewhere to avoid
 * matching ordinary words.
 */
const NUMBER_TOKEN = /([A-Z]{0,2})([0-9OQDISZBGTL]{2,4})([A-Z]{0,2})/gi;

/** A candidate set code must be this long; all Riftbound set codes are 2–4 chars. */
const MIN_SET_LEN = 2;
const MAX_SET_LEN = 4;

/** Maximum Levenshtein distance allowed when a set code does not match a known one. */
const MAX_SET_DISTANCE = 1.2;

/**
 * Distance at or below which a set-code difference is explained purely by OCR
 * confusions rather than a genuine difference. Recorded in
 * {@link ParsedCardId.source} so callers can tell the two apart.
 */
const CONFUSION_ONLY_DISTANCE = 0.35;

export interface Token {
  /** Original text of the token as OCR returned it. */
  text: string;
  /** Index of the line this token was found on. */
  line: number;
  /** Position of the token within its line. */
  index: number;
}

/**
 * Matches the trailing `/<setTotal>` that a real card prints after the number.
 *
 * Every Riftbound card shows its number as `160/298`, so the `/298` half is
 * present in essentially every OCR read. It carries no identifying information
 * (it is just the set size) and must be tolerated rather than treated as noise
 * that invalidates the token.
 *
 * Also tolerates the OCR variants of a slash (`\`, `1`, `l`, `I`) and an
 * optional trailing glyph, because the denominator is frequently misread and we
 * do not care about its value.
 */
const SET_TOTAL_SUFFIX = /^[\s]*[/\\1lI|][\s]*(?:[0-9OQDISZBGTL]{1,4})?[\s]*[.:;,]?$/i;

/**
 * Splits OCR text into tokens while retaining line information.
 *
 * Hyphens, en/em dashes and slashes that separate the set code from the number
 * are treated as separators only when they stand alone between two tokens. A
 * slash *inside* a token is kept, because `160/298` is a single printed unit;
 * splitting it would discard the number's context.
 *
 * Line numbers matter because `OGN` and `160/298` frequently land on separate
 * lines, and a token on the same line is stronger evidence than one that is
 * merely close in the flattened string.
 */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const lines = text.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] as string;
    // Keep `/` inside tokens so `160/298` survives, but drop the dashes used as
    // `OGN - 160/298` separators.
    const parts = line
      .replace(/[-–—]+/g, ' ')
      .split(/[\s|_·•:]+/)
      .filter(Boolean);
    for (let i = 0; i < parts.length; i += 1) {
      tokens.push({ text: parts[i] as string, line: lineIndex, index: i });
    }
  }
  return tokens;
}

/** Splits off a leading identifier prefix such as the `T` in `T01`. */
function splitPrefix(raw: string): { prefix: string; rest: string } {
  const match = /^([A-Za-z]{1,2})(?=[0-9OQDISZBGTL])/.exec(raw);
  if (!match) return { prefix: '', rest: raw };
  return { prefix: match[1] as string, rest: raw.slice(match[1]!.length) };
}

/**
 * Scores how likely a token is the collector number, lower is better.
 *
 * Returns null when the token cannot be a collector number at all.
 */
function numberTokenScore(
  token: string,
  relation: 'after' | 'before' | 'near',
  lineGap: number,
  positionGap: number,
): number | null {
  // Re-run the pattern freshly: /g regexes are stateful, so we never keep one
  // at module scope for reuse across calls.
  const re = new RegExp(NUMBER_TOKEN.source, 'i');
  const match = re.exec(token);
  if (!match) return null;

  const [full, prefix = '', digits = '', suffix = ''] = match;

  // Anything after the matched number must be the printed set total (`/298`).
  // This is what makes `160/298` usable while still rejecting a token that has
  // genuinely unrelated trailing content.
  const trailing = token.slice(full.length);
  if (trailing.length > 0 && !SET_TOTAL_SUFFIX.test(trailing)) return null;

  if (digits.length < 2 || digits.length > 4) return null;

  // Reject a token that contains no unambiguous digit at all (e.g. "OIO"),
  // which would otherwise match pure words.
  if (!/[0-9]/.test(digits)) return null;

  let score = 0;
  if (digits.length < 3) score += 2.5; // Riftbound numbers are 3 digits
  if (digits.length > 3) score += 1;
  if (prefix.length > 0) score += 0.6; // promo-style "T01"
  if (suffix.length > 0) score += 0.6; // alternate-art "010a"

  // Adjacency: the number sits immediately beside the set code when printed.
  if (relation === 'after') score += 0;
  else if (relation === 'before') score += 0.5;
  else score += 2.5;

  score += lineGap * 1.5;
  score += positionGap * 0.4;

  return score;
}

interface NumberCandidate {
  number: string;
  /** Printed prefix, e.g. `T` in `T01`. Empty for ordinary numbers. */
  prefix: string;
  variant: string;
  token: Token;
  score: number;
}

/**
 * Builds a candidate from a token, or null when it cannot be a collector number.
 *
 * Split out from {@link findNumberNear} so the same logic can be applied both to
 * sibling tokens and to the remainder of the anchor token itself.
 *
 * The prefix/number/variant split follows what is actually printed:
 *   - An **alphabetic** suffix is an art letter, and is not part of the number
 *     (`007a` -> number `007`, variant `a`).
 *   - A **numeric or ambiguous** suffix is treated as part of the number, because
 *     a permissive split produced false matches: reading `998` as `99` plus
 *     variant `8` happened to match a real card and turned a clear non-match into
 *     a confident wrong answer.
 */
function candidateFromToken(
  token: Token,
  text: string,
  relation: 'after' | 'before' | 'near' | 'glued',
  lineGap: number,
  positionGap: number,
): NumberCandidate | null {
  const re = new RegExp(NUMBER_TOKEN.source, 'i');
  const match = re.exec(text);
  if (!match) return null;
  const [full, rawPrefix = '', digits = '', rawSuffix = ''] = match;

  // Allow the printed set total (`/298`) to follow the number, exactly as
  // `numberTokenScore` does. Without this, the most common real read never
  // produces a candidate.
  const trailing = text.slice(full.length);
  if (trailing.length > 0 && !SET_TOTAL_SUFFIX.test(trailing)) return null;

  if (digits.length < 2 || digits.length > 4) return null;
  if (!/[0-9]/.test(digits)) return null;

  let score = 0;
  if (digits.length < 3) score += 2.5; // Riftbound numbers are 3 digits
  if (digits.length > 3) score += 1;
  if (rawPrefix.length > 0) score += 0.6; // promo-style "T01"
  if (rawSuffix.length > 0) score += 0.6; // alternate-art "010a"

  // A number glued to the set code is the strongest possible signal, since it
  // is exactly how the identifier is printed.
  if (relation === 'glued') score -= 1.5;
  else if (relation === 'after') score += 0;
  else if (relation === 'before') score += 0.5;
  else score += 2.5;

  score += lineGap * 1.5;
  score += positionGap * 0.4;

  const { prefix, rest } = splitPrefix(rawPrefix);
  const prefixOut = repairByShape(prefix, 'A'.repeat(prefix.length));

  // A suffix that is recognisably alphabetic is an art marker; anything else is
  // presumed to be digits that OCR rendered as letters.
  const isArtSuffix = /^[a-zA-Z]+$/.test(rawSuffix) && !/[0-9OQ]/.test(rawSuffix);
  const body = isArtSuffix ? `${rest}${digits}` : `${rest}${digits}${rawSuffix}`;

  return {
    number: repairByShape(body, '9'.repeat(body.length)),
    prefix: prefixOut,
    variant: isArtSuffix ? rawSuffix.toLowerCase() : '',
    token,
    score,
  };
}
/**
 * Finds the best collector-number candidate for a set-code anchor.
 *
 * `anchorPart` is the set-code half of the anchor token and `anchorText` the
 * whole token, so a number glued to the code (`OGN010`) can be recovered from
 * the remainder after the set code.
 */
function findNumberNear(
  tokens: Token[],
  anchor: number,
  anchorPart: string,
  anchorText: string,
): NumberCandidate | null {
  const anchorToken = tokens[anchor] as Token;
  const WINDOW = 5;
  let best: NumberCandidate | null = null;

  const consider = (candidate: NumberCandidate | null): void => {
    if (candidate === null) return;
    if (best === null || candidate.score < best.score) best = candidate;
  };

  // 1. Whatever follows the set code inside the same token, e.g. "OGN-010".
  const upperText = anchorText.toUpperCase();
  const partIndex = upperText.indexOf(anchorPart);
  if (partIndex >= 0) {
    const remainder = upperText
      .slice(partIndex + anchorPart.length)
      .replace(/^[^A-Z0-9]+/, '');
    if (remainder.length > 0) {
      consider(candidateFromToken(anchorToken, remainder, 'glued', 0, 0));
    }
  }

  // 2. A sibling token immediately before or after the anchor.
  for (let offset = -WINDOW; offset <= WINDOW; offset += 1) {
    if (offset === 0) continue;
    const i = anchor + offset;
    if (i < 0 || i >= tokens.length) continue;
    const token = tokens[i] as Token;

    const lineGap = Math.abs(token.line - anchorToken.line);
    if (lineGap > 2) continue;

    const positionGap = Math.abs(offset);
    // A token that sits *after* the set code is the stronger candidate, since
    // that is the printed order (`OGN 010`).
    const relation: 'after' | 'before' | 'near' =
      offset === 1 ? 'after' : offset === -1 ? 'before' : 'near';

    // Cheap gate first so we do not construct a regex per token needlessly.
    if (numberTokenScore(token.text, relation, lineGap, positionGap) === null) continue;
    consider(candidateFromToken(token, token.text, relation, lineGap, positionGap));
  }

  return best;
}

/** Finds the known set code whose distance to `token` is smallest. */
function bestKnownSet(
  token: string,
  knownSets: readonly string[],
): { code: string; distance: number } | null {
  const candidate = token.toUpperCase();
  if (candidate.length < MIN_SET_LEN || candidate.length > MAX_SET_LEN) return null;
  if (!/^[A-Z0-9]+$/.test(candidate)) return null;

  let best: { code: string; distance: number } | null = null;
  for (const code of knownSets) {
    const distance = weightedDistance(candidate, code);
    if (best === null || distance < best.distance) {
      best = { code, distance };
    }
  }
  return best;
}

/**
 * Parses the most likely card identifier out of one OCR text block.
 *
 * Returns null when the text contains nothing that looks like a collector
 * number with an adjacent set code — the caller should treat that as "no card
 * found" rather than guessing.
 *
 * `knownSets` should be the set codes present in the card database; it is what
 * lets the parser resolve genuinely ambiguous reads.
 */
export function parseCardId(
  text: string,
  knownSets: readonly string[],
): ParsedCardId | null {
  if (!text || text.trim().length === 0) return null;

  const tokens = tokenize(text);
  if (tokens.length === 0) return null;

  interface Scored {
    parsed: ParsedCardId;
    score: number;
  }
  let best: Scored | null = null;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as Token;

    // A token may already glue the set code to the number with a hyphen
    // (`OGN-010`), a slash or a dot. Split it so the set code half can be
    // treated as an anchor exactly like a standalone `OGN` token; otherwise the
    // most common printed form would never parse.
    const parts = token.text
      .toUpperCase()
      .split(/[-/.]+/)
      .filter((p) => p.length > 0);

    for (const part of parts) {
      const alphaOnly = part.replace(/[^A-Z0-9]/g, '');
      if (alphaOnly.length === 0) continue;

      const known = bestKnownSet(alphaOnly, knownSets);

      // Decide the set code for this anchor.
      let setCodeRaw: string;
      let setDistance: number;
      let source: ParsedCardId['source'];

      if (known !== null && known.distance === 0) {
        setCodeRaw = alphaOnly;
        setDistance = 0;
        source = 'pattern';
      } else if (known !== null && known.distance <= MAX_SET_DISTANCE) {
        setCodeRaw = alphaOnly;
        setDistance = known.distance;
        source = known.distance <= CONFUSION_ONLY_DISTANCE ? 'known-set' : 'loose';
      } else {
        // Not close to any known set code. Only accept it if it has a number
        // glued to it in the same token, which the loop over `parts` handles.
        const glued = /^([A-Z]{2,4})([0-9OQDISZBGTL]{2,4})([A-Z]{0,2})$/i.exec(alphaOnly);
        if (!glued) continue;
        const setPart = (glued[1] as string).toUpperCase();
        if (setPart.length < MIN_SET_LEN || setPart.length > MAX_SET_LEN) continue;
        setCodeRaw = setPart;
        setDistance = weightedDistance(setPart, known?.code ?? setPart);
        source = 'pattern';
      }

      // Number may be in a sibling token (`OGN 010`) or glued into this one
      // (`OGN010`, `OGN-010`); both are handled by searching around the anchor
      // and accepting a number only when it is adjacent to it.
      const numberCandidate = findNumberNear(tokens, i, part, token.text);
      if (numberCandidate === null) continue;

      const parsed: ParsedCardId = {
        setCodeRaw,
        prefix: numberCandidate.prefix,
        number: numberCandidate.number.padStart(3, '0'),
        variant: numberCandidate.variant,
        raw: `${token.text} ${numberCandidate.token.text}`.trim(),
        source,
      };

      // Lower is better: set-code distance dominates, and number-token quality
      // breaks ties between competing anchors.
      const score = setDistance * 2 + numberCandidate.score;
      if (best === null || score < best.score) {
        best = { parsed, score };
      }
    }
  }

  return best?.parsed ?? null;
}

/** True when two readings refer to the same printed identity. */
function sameReading(a: ParsedCardId, b: ParsedCardId): boolean {
  return (
    a.setCodeRaw === b.setCodeRaw &&
    a.prefix === b.prefix &&
    a.number === b.number &&
    a.variant === b.variant
  );
}

/**
 * Parses *every* plausible identifier in the text, best first.
 *
 * A single photo can contain several cards, and each parseable token can yield
 * its own identifier. Returning all of them lets the matcher try each against the
 * card database and keep whichever resolves to a real card.
 */
export function parseCardIds(
  text: string,
  knownSets: readonly string[],
  limit = 12,
): ParsedCardId[] {
  if (!text || text.trim().length === 0) return [];

  const tokens = tokenize(text);
  const results: ParsedCardId[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const single = tokens
      .slice(Math.max(0, i - 6), Math.min(tokens.length, i + 7))
      .map((t) => t.text)
      .join(' ');
    const parsed = parseCardId(single, knownSets);
    if (parsed === null) continue;

    // The same card can appear in several windows; keep the first sighting,
    // which roughly follows the top of the image.
    if (results.some((r) => sameReading(r, parsed))) continue;

    results.push(parsed);
  }

  return results.slice(0, limit);
}

/**
 * Convenience wrapper used by the matcher: resolves the parsed set code to a
 * real set code from the database.
 *
 * A read like `0GN` is returned as `OGN` once we know `OGN` exists.
 */
export function resolveSetCode(
  parsed: ParsedCardId,
  knownSets: readonly string[],
): string | null {
  const raw = parsed.setCodeRaw.toUpperCase();
  if (knownSets.includes(raw)) return raw;

  // Prefer a pure-confusion match, since those are by far the most common.
  const confusion = knownSets.find((code) => isConfusionEquivalent(raw, code));
  if (confusion !== undefined) return confusion;

  let best: { code: string; distance: number } | null = null;
  for (const code of knownSets) {
    const distance = weightedDistance(raw, code);
    if (best === null || distance < best.distance) best = { code, distance };
  }
  if (best !== null && best.distance <= MAX_SET_DISTANCE) return best.code;
  return null;
}

/** Re-exported so callers can reason about number equality without importing normalize. */
export { numberOf };
