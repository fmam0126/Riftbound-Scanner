/**
 * Shared domain types for the Riftbound Scanner.
 *
 * These types are the contract between three very different consumers:
 *   1. `scripts/build-card-db.ts` — which generates the data offline from TCGCSV.
 *   2. `src/logic/*` — the pure, testable OCR parsing + matching pipeline.
 *   3. The React Native UI in `src/screens/*`.
 *
 * Keep everything here serialisable: the card list is shipped as a bundled JSON
 * file so the app works with no network connection at all.
 */

/** A single card in the built-in database. */
export interface CardRecord {
  /** Stable key of the owning set, e.g. `OGN`. */
  setCode: string;
  /**
   * Leading letters printed before the digits, when they are part of the card's
   * printed identity, e.g. the `T` in promo number `T01`. Empty for most cards.
   */
  prefix: string;
  /** Printed collector number without the set code, e.g. `010` or `007`. */
  number: string;
  /**
   * Discriminating suffix for alternative printings of the same number.
   *
   * Alternate art uses the printed letter, e.g. the `a` in `007a`. Signature
   * printings are published by TCGplayer as `190*`; the asterisk is normalised
   * to `s` here so the key stays URL- and filename-safe.
   */
  variant: string;
  /** The full printed identifier a player reads on the card, e.g. `OGN-010`. */
  id: string;
  /**
   * Lookup key, `SET-NUMBER` with any variant letter folded in, e.g. `OGN-007a`.
   *
   * Two printings of the same card (base + alternate art) deliberately have
   * different keys so a collection can distinguish them. Promotional sets are
   * less tidy: they reuse one collector number across genuinely different
   * cards, so collisions get a `~2`, `~3`, … disambiguator appended. The first
   * occupant keeps the plain key.
   */
  key: string;
  /** Card name as printed, e.g. `Legion Rearguard`. */
  name: string;
  /** Printing name from TCGplayer, which adds set/art qualifiers, e.g. `Ahri, Alluring (Alternate Art)`. */
  printingName: string;
  rarity: string | null;
  cardType: string | null;
  /** Runeterra region/domain such as `Fury`, `Calm`, `Mind`. */
  domain: string | null;
  /** Semicolon-separated tags from TCGplayer, split into an array, e.g. `["Noxus", "Dragon"]`. */
  tags: string[];
  energyCost: number | null;
  powerCost: number | null;
  might: number | null;
  description: string | null;
  flavorText: string | null;
  /** `number/total` denominator as printed, e.g. `298`. */
  setTotal: string | null;
  imageUrl: string | null;
  /** TCGplayer product id, useful for deep links and price lookups. */
  productId: number;
}

/** A set (TCGplayer calls these "groups"). */
export interface SetRecord {
  groupId: number;
  /** Printed 2–4 letter set code, e.g. `OGN`. */
  code: string;
  name: string;
  publishedOn: string | null;
  /** Number of cards in {@link CardDatabase.cards} belonging to this set. */
  cardCount: number;
}

export interface CardDatabaseMeta {
  /** Schema version; bump when the shape of CardRecord changes. */
  version: number;
  /** ISO timestamp of when the data was generated. */
  generatedAt: string;
  /** Where the data came from, for attribution. */
  source: string;
  /** TCGCSV category id for Riftbound. */
  categoryId: number;
  cardCount: number;
  setCount: number;
}

export interface CardDatabase {
  meta: CardDatabaseMeta;
  sets: SetRecord[];
  cards: CardRecord[];
}

/** A card plus how many copies the user owns. */
export interface OwnedCard {
  key: string;
  copies: number;
  firstScannedAt: string;
  lastScannedAt: string;
}

/** Persisted collection state. */
export interface CollectionState {
  /** Schema version, so a future migration can detect old payloads. */
  version: number;
  owned: Record<string, OwnedCard>;
}

/* ------------------------------------------------------------------ *
 * Scan results
 * ------------------------------------------------------------------ */

/**
 * A card identifier recovered from OCR text.
 *
 * `setCodeRaw` and `prefix` are kept exactly as the OCR produced them (e.g.
 * `0GN`, `T`) so the matcher can decide how much correction is needed, which
 * feeds confidence.
 */
export interface ParsedCardId {
  setCodeRaw: string;
  /** Printed identifier prefix, e.g. the `T` of promo number `T01`. */
  prefix: string;
  number: string;
  variant: string;
  /** The substring of OCR text this was parsed from, for debugging/UI. */
  raw: string;
  /** Which strategy found it; useful when tuning the parser. */
  source: 'pattern' | 'known-set' | 'loose';
}

/** How a scan resolved against the database. */
export type MatchKind =
  | 'exact' /** set code and number matched a known card. */
  | 'fuzzy' /** matched after OCR error correction. */
  | 'ambiguous' /** several printings share the number (base vs alternate art). */
  | 'none';

export interface CardMatch {
  card: CardRecord;
  /** 0–1 confidence that this is the card in the image. */
  confidence: number;
  kind: MatchKind;
}

export interface MatchResult {
  kind: MatchKind;
  parsed: ParsedCardId | null;
  /** Best candidate, or null when nothing plausible was found. */
  best: CardMatch | null;
  /** Ranked alternatives the user can pick from, best first. */
  candidates: CardMatch[];
  /** Human-readable explanation, surfaced in the UI when confidence is low. */
  reason: string;
}
