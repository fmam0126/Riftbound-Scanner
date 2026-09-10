#!/usr/bin/env node
/**
 * Builds the bundled Riftbound card database from TCGCSV.
 *
 * Run directly with Node (which strips the TypeScript types natively), e.g.
 * `npm run build:cards`. No bundler or transpiler step is involved.
 *
 * TCGCSV republishes TCGplayer's catalogue as JSON. Riftbound is TCGplayer
 * category 89; each set is a "group" whose `abbreviation` is exactly the set
 * code printed on the cards (OGN, SFD, UNL, ...). Each card product carries an
 * `extendedData` array containing a `Number` entry such as `010/298` or
 * `007a/298`, which is what the OCR reads off the bottom-left of a real card.
 *
 * Only products that have a `Number` are cards. Sealed product (booster boxes,
 * champion decks, bundles) has no `Number` and is skipped.
 *
 * Usage:
 *   npm run build:cards            # uses .cache/ when fresh (24h)
 *   npm run build:cards:refresh    # ignores the cache, refetches everything
 *   npm run verify:cards           # validates src/data/cards.json, no network
 */

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  CardDatabase,
  CardRecord,
  CardDatabaseMeta,
  SetRecord,
} from '../src/types.ts';

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

/** TCGplayer category id for "Riftbound: League of Legends Trading Card Game". */
export const RIFTBOUND_CATEGORY_ID = 89;

const TCGCSV_BASE = 'https://tcgcsv.com/tcgplayer';
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CACHE_DIR = resolve(ROOT, '.cache');
const OUT_FILE = resolve(ROOT, 'src/data/cards.json');

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const VERIFY_ONLY = argv.includes('--verify-only');

/* ------------------------------------------------------------------ *
 * Fetching
 * ------------------------------------------------------------------ */

interface TcgcsvExtendedData {
  name?: string;
  displayName?: string;
  value?: string;
}

export interface TcgcsvProduct {
  productId: number;
  name: string;
  cleanName?: string;
  imageUrl?: string | null;
  groupId: number;
  extendedData?: TcgcsvExtendedData[];
}

export interface TcgcsvGroup {
  groupId: number;
  name: string;
  abbreviation: string;
  publishedOn?: string | null;
  categoryId: number;
}

interface TcgcsvEnvelope<T> {
  success: boolean;
  totalItems: number;
  results: T[];
  errors?: unknown[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetches JSON from TCGCSV, retrying transient network failures.
 *
 * The sandbox this was developed in had an unreliable TLS stack, so a couple of
 * retries with backoff is not paranoia — it is required for the script to be
 * runnable at all. Requests are also spaced out to be polite to a free service.
 */
async function fetchJson<T>(url: string, attempt = 1): Promise<T> {
  const MAX_ATTEMPTS = 4;
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'riftbound-scanner/1.0 (+card database build script)',
      },
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    // TCGCSV serves an HTML landing page for unknown paths. Treat that as an
    // error rather than letting JSON.parse produce a baffling message.
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(
        `expected JSON but got ${res.headers.get('content-type') ?? 'unknown content-type'} ` +
          `(first 60 chars: ${JSON.stringify(text.slice(0, 60))})`,
      );
    }
  } catch (err) {
    if (attempt >= MAX_ATTEMPTS) {
      throw new Error(
        `GET ${url} failed after ${MAX_ATTEMPTS} attempts: ${(err as Error).message}`,
      );
    }
    const backoff = 500 * 2 ** (attempt - 1);
    console.warn(
      `  ! ${(err as Error).message} — retrying in ${backoff}ms (${attempt}/${MAX_ATTEMPTS - 1})`,
    );
    await sleep(backoff);
    return fetchJson<T>(url, attempt + 1);
  }
}

/** Reads a cached endpoint response, or null when missing/stale/bypassed. */
async function readCache<T>(key: string): Promise<T | null> {
  if (FORCE) return null;
  const file = resolve(CACHE_DIR, `${key}.json`);
  try {
    const info = await stat(file);
    if (Date.now() - info.mtimeMs > CACHE_MAX_AGE_MS) return null;
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function writeCache(key: string, value: unknown): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(resolve(CACHE_DIR, `${key}.json`), JSON.stringify(value), 'utf8');
}

async function fetchCached<T>(key: string, url: string): Promise<T> {
  const cached = await readCache<T>(key);
  if (cached !== null) {
    console.log(`  · cache hit  ${key}`);
    return cached;
  }
  console.log(`  · fetching   ${url}`);
  const fresh = await fetchJson<T>(url);
  await writeCache(key, fresh);
  await sleep(250);
  return fresh;
}

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

function extValue(product: TcgcsvProduct, field: string): string | null {
  const entry = product.extendedData?.find(
    (d) => (d.name ?? d.displayName ?? '').toLowerCase() === field.toLowerCase(),
  );
  const value = entry?.value?.trim();
  return value && value.length > 0 ? value : null;
}

function toInt(value: string | null): number | null {
  if (value === null) return null;
  const n = Number.parseInt(value.replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalises a variant/prefix fragment that TCGplayer prints with symbols.
 *
 * Signature printings are listed with a trailing asterisk (the number `190`
 * followed by `*` over `166`). Keeping the asterisk would put it in the
 * collection key, so it becomes `s` for "signature". Any other symbol is
 * dropped rather than allowed to leak into a key.
 */
function normalizeVariantFragment(fragment: string): string {
  return fragment
    .replace(/\*/g, 's')
    .replace(/[^A-Za-z0-9]/g, '')
    .toLowerCase();
}

/**
 * Splits TCGplayer's `Number` value into its printed pieces.
 *
 * Observed shapes in the real Riftbound catalogue (the slash separates the
 * printed number from the set total, exactly as TCGplayer publishes it):
 *
 *   "010/298"          prefix "",  number "010", variant "",   setTotal "298"
 *   "007a/298"         prefix "",  number "007", variant "a",  setTotal "298"
 *   "T01/T02"    rejected: a double-sided token, no unique number
 *   "R04"        rejected: a rune index, not a collectible card
 *   "SP3/006"    rejected: special art whose digits duplicate a real number
 *   "190s/166"   prefix "",  number "190", variant "s"   (Signature)
 *   "T1A 001/005" prefix "", number "001", variant "t1a" (promo bundle)
 *
 * The leading `prefix` is the part a player actually reads as part of the card
 * number (the printed number of `T01` is "T01"). Anything else that
 * TCGplayer bolts on — special-art codes, bundle codes — becomes a `variant`,
 * because the digits alone are what is printed on the card.
 *
 * Returns null when the value carries no usable collector number.
 */
export function parsePrintedNumber(
  raw: string,
  printingName = '',
): {
  prefix: string;
  number: string;
  variant: string;
  setTotal: string | null;
} | null {
  const [left, right] = raw.split('/');
  const numerator = (left ?? '').trim();
  if (numerator.length === 0) return null;
  const setTotal = right?.trim() ? right.trim() : null;

  const result = {
    prefix: '',
    number: '',
    variant: '',
    setTotal,
  };

  // A "//" numerator denotes a double-sided token ("T05 // T06"). Tokens are
  // not part of a player's collection, and the value is not a single id.
  if (numerator.includes('//')) return null;

  // Parenthesised qualifiers in the printing name carry the disambiguation
  // TCGplayer strips out of the Number field. Many products are otherwise
  // published with identical numbers — the five Worlds Champion promo bundles
  // each print number "001" — so this is the only signal that separates them.
  //
  // It is applied only when the printed number carries no distinction of its
  // own, so a card whose number already encodes the art (`007a`) keeps the
  // short, canonical key `OGN-007a` instead of also repeating "alternateart".
  const qualifier = [...printingName.matchAll(/\(([^)]*)\)/g)]
    .map((m) => normalizeVariantFragment(m[1] as string))
    .filter((q) => q.length > 0)
    .join('');

  // Space-separated identifiers: the segment after the space is the card's
  // number, and the code before it is a printing marker rather than part of
  // the number a player reads.
  const spaced = /^(\S{1,5})\s+(\d{1,4})([A-Za-z*]?)$/.exec(numerator);
  if (spaced) {
    const code = normalizeVariantFragment(spaced[1] as string);
    result.number = spaced[2] as string;
    result.variant = `${code}${qualifier}`;
    return finalise(result);
  }

  const match = /^([A-Za-z0-9]{0,4}?)(\d{1,4})([A-Za-z0-9*]{0,3})$/.exec(numerator);
  if (!match) return null;

  const rawPrefix = match[1] ?? '';
  const digits = match[2] as string;
  const rawSuffix = match[3] ?? '';

  // Take the leading letters as the prefix; whatever follows is a suffix. This
  // avoids the ambiguity of "T1A001", where the digits could be read as part
  // of the prefix.
  const leadingLetters = /^[A-Za-z]{0,3}/.exec(rawPrefix)?.[0] ?? '';
  const restOfPrefix = rawPrefix.slice(leadingLetters.length);
  const suffix = `${restOfPrefix}${rawSuffix}`;

  if (suffix.length > 0) {
    result.variant = normalizeVariantFragment(suffix);
  }

  result.number = digits;

  // A leading letter followed by a single digit (`R04`) is a rune, energy or
  // token index rather than a collector number, so it is not a stable
  // identifier a player can scan. Real card numbers are 2+ digits.
  if (leadingLetters.length > 0 && digits.length < 2) return null;

  // A two-or-more-letter prefix is an art/set code (`SP`), not part of an id a
  // player reads, so it moves into the variant. Single letters such as the `T`
  // of promo number `T01` stay as part of the printed number.
  if (leadingLetters.length >= 2) {
    const code = normalizeVariantFragment(leadingLetters);
    result.variant = result.variant ? `${result.variant}${code}` : code;
  } else {
    result.prefix = normalizeVariantFragment(leadingLetters);
  }

  // Fall back to the printing qualifier only when nothing else distinguishes
  // this printing, which is exactly the multi-bundle promo collision case.
  if (result.variant.length === 0) {
    result.variant = qualifier;
  }

  return finalise(result);
}

/**
 * The only printed prefix that is part of a real card's number.
 *
 * A survey of every `Number` value in the Riftbound catalogue shows exactly
 * three leading-letter forms:
 *   `R##`  rune indices (`R01` Fury Rune) — a rune, not a collectible card
 *   `T##`  double-sided tokens (`T01 // Empowered // Gold`) — tokens, no number
 *   `SP#`  special-art printing codes (`SP3`) — the digits alone are the number
 * Anything else prefixed is therefore not a scannable card identifier, so only
 * `T` is accepted and only when it is not a token pair.
 */
const PRINTED_PREFIX = 'T';

/**
 * Rejects implausible collector numbers and trims the variant.
 *
 * Kept separate so every parse path is validated identically, no matter which
 * shape the raw value had.
 */
function finalise(result: {
  prefix: string;
  number: string;
  variant: string;
  setTotal: string | null;
}): { prefix: string; number: string; variant: string; setTotal: string | null } | null {
  if (result.number.length < 2 || result.number.length > 4) return null;

  // A prefix is part of the printed number only for genuine tokens.
  if (result.prefix.length > 0 && result.prefix !== PRINTED_PREFIX) return null;

  // Variants are concatenated markers and can grow long (a bundle name plus an
  // art code). Two bundles normalise to the same text, so cap the length to
  // keep keys readable while letting the collision pass add a numeric
  // disambiguator for anything that still ties.
  return { ...result, variant: result.variant.slice(0, 20) };
}

/** Turns one TCGCSV product into a CardRecord, or null if it is not a card. */
export function productToCard(
  product: TcgcsvProduct,
  setCode: string,
): CardRecord | null {
  const printedRaw = extValue(product, 'Number');
  if (!printedRaw) return null; // sealed product

  const parsed = parsePrintedNumber(printedRaw, product.name);
  if (!parsed) return null;

  const { prefix, number, variant, setTotal } = parsed;
  const displayNumber = `${prefix}${number}`;
  const key = `${setCode}-${displayNumber}${variant}`;

  const tagValue = extValue(product, 'Tag');

  return {
    setCode,
    prefix,
    number,
    variant,
    // `id` is what a human reads on the card; `key` is the unique lookup key.
    id: `${setCode}-${displayNumber}`,
    key,
    name: extValue(product, 'Name') ?? product.name,
    printingName: product.name,
    rarity: extValue(product, 'Rarity'),
    cardType: extValue(product, 'Card Type'),
    domain: extValue(product, 'Domain'),
    tags: tagValue
      ? tagValue
          .split(';')
          .map((t) => t.trim())
          .filter(Boolean)
      : [],
    energyCost: toInt(extValue(product, 'Energy Cost')),
    powerCost: toInt(extValue(product, 'Power Cost')),
    might: toInt(extValue(product, 'Might')),
    description: extValue(product, 'Description'),
    flavorText: extValue(product, 'Flavor Text'),
    setTotal,
    imageUrl: product.imageUrl ?? null,
    productId: product.productId,
  };
}

/* ------------------------------------------------------------------ *
 * Key assignment
 * ------------------------------------------------------------------ */

/**
 * `SET-` then an optional identifier prefix, digits, an optional variant, and an
 * optional `~N` collision disambiguator.
 *
 * Variants can be multi-character: a printed art letter (`a`), a normalised
 * TCGplayer symbol (`s` for signature) or a normalised printing qualifier
 * (`top8`, `alternateart`), so they are not limited to a single character.
 * Prefixes are uppercase-bearing (`T1A`) while variants are always lowercase.
 */
export const KEY_PATTERN = /^[A-Z0-9]+-[A-Za-z0-9]{0,4}?\d+[a-z0-9]{0,20}(?:~\d+)?$/;

/**
 * Assigns every card a unique `key`.
 *
 * Main sets are well behaved — `OGN-010` is unique. Promotional and organized
 * play sets are not: they hand out one collector number to several completely
 * different cards (reprints, judge promos, prize-wall foils). Since the key is
 * the collection's primary key, a collision would merge unrelated cards.
 *
 * The first product to claim a key keeps the plain form; later claimants get
 * `~2`, `~3`, … appended. Input order therefore matters, which is why the
 * caller sorts by productId first: TCGplayer assigns ids in release order, so
 * the oldest printing keeps the cleanest key.
 */
export function assignUniqueKeys(cards: CardRecord[]): CardRecord[] {
  const used = new Map<string, number>();
  return cards.map((card) => {
    const base = `${card.setCode}-${card.prefix}${card.number}${card.variant}`;
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    if (seen === 0) return { ...card, key: base };
    return { ...card, key: `${base}~${seen + 1}` };
  });
}

/* ------------------------------------------------------------------ *
 * Build
 * ------------------------------------------------------------------ */

async function build(): Promise<CardDatabase> {
  console.log(`Building Riftbound card database (category ${RIFTBOUND_CATEGORY_ID})…`);

  const groupsEnvelope = await fetchCached<TcgcsvEnvelope<TcgcsvGroup>>(
    `groups-${RIFTBOUND_CATEGORY_ID}`,
    `${TCGCSV_BASE}/${RIFTBOUND_CATEGORY_ID}/groups`,
  );
  const groups = groupsEnvelope.results ?? [];

  if (groups.length === 0) {
    throw new Error(
      'TCGCSV returned no groups for the Riftbound category — schema may have changed.',
    );
  }
  console.log(`  found ${groups.length} sets`);

  const cards: CardRecord[] = [];
  const sets: SetRecord[] = [];
  const skipped: Array<{ set: string; name: string; reason: string }> = [];

  for (const group of groups) {
    const setCode = (group.abbreviation || group.name).trim().toUpperCase();
    const envelope = await fetchCached<TcgcsvEnvelope<TcgcsvProduct>>(
      `products-${group.groupId}`,
      `${TCGCSV_BASE}/${RIFTBOUND_CATEGORY_ID}/${group.groupId}/products`,
    );

    const products = envelope.results ?? [];
    let setCardCount = 0;

    for (const product of products) {
      const card = productToCard(product, setCode);
      if (card) {
        cards.push(card);
        setCardCount += 1;
        continue;
      }
      // Only report skips for things that look like they should have been cards,
      // so the log stays readable.
      const hasAnyNumber = product.extendedData?.some(
        (d) => (d.name ?? '').toLowerCase() === 'number',
      );
      if (hasAnyNumber) {
        skipped.push({
          set: setCode,
          name: product.name,
          reason: 'Number field present but unparseable',
        });
      }
    }

    sets.push({
      groupId: group.groupId,
      code: setCode,
      name: group.name,
      publishedOn: group.publishedOn ?? null,
      cardCount: setCardCount,
    });

    console.log(`  · ${setCode.padEnd(6)} ${String(setCardCount).padStart(4)} cards  (${group.name})`);
  }

  if (skipped.length > 0) {
    console.warn(`\n  ${skipped.length} product(s) skipped:`);
    for (const s of skipped.slice(0, 20)) {
      console.warn(`    - [${s.set}] ${s.name}: ${s.reason}`);
    }
  }

  // Deterministic ordering keeps the generated file diff-friendly, and sorting
  // by productId *before* key assignment means the oldest printing of a
  // duplicated promo number keeps the clean key.
  const ordered = [...cards].sort(
    (a, b) =>
      a.setCode.localeCompare(b.setCode) ||
      a.productId - b.productId,
  );
  const keyed = assignUniqueKeys(ordered);
  keyed.sort((a, b) => a.key.localeCompare(b.key));
  sets.sort((a, b) => a.code.localeCompare(b.code));

  const meta: CardDatabaseMeta = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: `${TCGCSV_BASE}/${RIFTBOUND_CATEGORY_ID}`,
    categoryId: RIFTBOUND_CATEGORY_ID,
    cardCount: keyed.length,
    setCount: sets.length,
  };

  return { meta, sets, cards: keyed };
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

/**
 * Sanity-checks a database. Run after every build, and available standalone via
 * `--verify-only` so CI can validate the committed JSON without network access.
 */
export function validate(db: CardDatabase): string[] {
  const problems: string[] = [];

  if (!Array.isArray(db.cards) || db.cards.length === 0) {
    problems.push('cards array is empty');
    return problems;
  }
  if (db.meta.cardCount !== db.cards.length) {
    problems.push(`meta.cardCount=${db.meta.cardCount} but cards.length=${db.cards.length}`);
  }
  if (db.meta.setCount !== db.sets.length) {
    problems.push(`meta.setCount=${db.meta.setCount} but sets.length=${db.sets.length}`);
  }

  const setCodes = new Set(db.sets.map((s) => s.code));
  const seenKeys = new Map<string, string>();

  for (const card of db.cards) {
    if (!setCodes.has(card.setCode)) {
      problems.push(`${card.key}: setCode ${card.setCode} is not in sets[]`);
    }
    // The key must be derived from the printed identity, optionally with the
    // `~N` collision disambiguator that promo sets require.
    const expectedBase = `${card.setCode}-${card.prefix}${card.number}${card.variant}`;
    if (!card.key.startsWith(expectedBase)) {
      problems.push(`${card.key}: key does not start with ${expectedBase}`);
    }
    if (!KEY_PATTERN.test(card.key)) {
      problems.push(`${card.key}: key does not look like SET-NNN[a][~N]`);
    }
    if (!card.name || card.name.trim().length === 0) {
      problems.push(`${card.key}: empty name`);
    }
    const previous = seenKeys.get(card.key);
    if (previous !== undefined) {
      problems.push(
        `${card.key}: duplicate key (${JSON.stringify(previous)} vs ${JSON.stringify(card.printingName)})`,
      );
    }
    seenKeys.set(card.key, card.printingName);
  }

  // Verify per-set counts match reality.
  const actualCounts = new Map<string, number>();
  for (const card of db.cards) {
    actualCounts.set(card.setCode, (actualCounts.get(card.setCode) ?? 0) + 1);
  }
  for (const set of db.sets) {
    const actual = actualCounts.get(set.code) ?? 0;
    if (set.cardCount !== actual) {
      problems.push(`${set.code}: set.cardCount=${set.cardCount} but found ${actual} cards`);
    }
  }

  return problems;
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (VERIFY_ONLY) {
    const raw = await readFile(OUT_FILE, 'utf8');
    const db = JSON.parse(raw) as CardDatabase;
    const problems = validate(db);
    console.log(
      `Verified ${db.cards.length} cards across ${db.sets.length} sets ` +
        `(generated ${db.meta.generatedAt}).`,
    );
    if (problems.length > 0) {
      console.error(`\n${problems.length} problem(s):`);
      for (const p of problems) console.error(`  - ${p}`);
      process.exitCode = 1;
    } else {
      console.log('No problems found.');
    }
    return;
  }

  const db = await build();
  const problems = validate(db);

  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify(db, null, 1)}\n`, 'utf8');

  const bytes = Buffer.byteLength(JSON.stringify(db));
  console.log(
    `\nWrote ${db.cards.length} cards across ${db.sets.length} sets to ` +
      `src/data/cards.json (${(bytes / 1024).toFixed(0)} KB)`,
  );

  if (problems.length > 0) {
    console.error(`\nValidation found ${problems.length} problem(s):`);
    for (const p of problems.slice(0, 40)) console.error(`  - ${p}`);
    if (problems.length > 40) console.error(`  … and ${problems.length - 40} more`);
    // The file is still written so the failure can be inspected, but the
    // non-zero exit makes the build fail loudly in CI.
    process.exitCode = 1;
  } else {
    console.log('Validation passed: keys are unique and set counts agree.');
  }
}

// Only run when invoked directly, so tests can import the helpers above.
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(`\nBuild failed: ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
