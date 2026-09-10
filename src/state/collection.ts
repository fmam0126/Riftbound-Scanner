/**
 * Collection persistence.
 *
 * The collection is small — at most a few thousand entries — so it is kept as a
 * single JSON document in AsyncStorage rather than a database. That keeps the
 * app dependency-light and makes the whole state trivially inspectable.
 *
 * Writes are debounced and serialised so that rapid scanning (which is the
 * normal case for this app) does not thrash storage or lose updates.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import type { CardDatabase, CardRecord, CollectionState, OwnedCard } from '../types.ts';

const STORAGE_KEY = 'riftbound.collection.v1';
const SCHEMA_VERSION = 1;

/** An empty collection, used before the first load and after a reset. */
export function emptyCollection(): CollectionState {
  return { version: SCHEMA_VERSION, owned: {} };
}

/**
 * Reads the collection, tolerating missing or corrupt data.
 *
 * Corrupt state returns an empty collection rather than throwing: a collection
 * tracker that refuses to open is worse than one that starts fresh.
 */
export async function loadCollection(): Promise<CollectionState> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw === null) return emptyCollection();

    const parsed = JSON.parse(raw) as Partial<CollectionState>;
    if (parsed.version !== SCHEMA_VERSION || typeof parsed.owned !== 'object' || parsed.owned === null) {
      return emptyCollection();
    }

    // Drop entries that are not shaped like an owned card, so one bad record
    // cannot break the whole collection view.
    const owned: Record<string, OwnedCard> = {};
    for (const [key, value] of Object.entries(parsed.owned)) {
      if (typeof key !== 'string' || value === null || typeof value !== 'object') continue;
      const entry = value as Partial<OwnedCard>;
      if (typeof entry.copies !== 'number' || !Number.isFinite(entry.copies) || entry.copies < 1) {
        continue;
      }
      owned[key] = {
        key,
        copies: Math.floor(entry.copies),
        firstScannedAt: entry.firstScannedAt ?? new Date().toISOString(),
        lastScannedAt: entry.lastScannedAt ?? new Date().toISOString(),
      };
    }

    return { version: SCHEMA_VERSION, owned };
  } catch {
    return emptyCollection();
  }
}

let writeQueue: Promise<void> = Promise.resolve();

/** Persists the collection, serialising overlapping writes. */
export async function saveCollection(state: CollectionState): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  });
  return writeQueue;
}

export async function clearCollection(): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    await AsyncStorage.removeItem(STORAGE_KEY);
  });
  return writeQueue;
}

/**
 * Records `copies` more of a card.
 *
 * Returns the updated state plus the copy count after the change, so the UI can
 * show "3 copies" and distinguish a first-time add from a duplicate.
 */
export function addCard(
  state: CollectionState,
  card: CardRecord,
  copies = 1,
): { state: CollectionState; newCopies: number; isNew: boolean } {
  const existing = state.owned[card.key];
  const now = new Date().toISOString();

  const updated: OwnedCard =
    existing === undefined
      ? { key: card.key, copies, firstScannedAt: now, lastScannedAt: now }
      : { ...existing, copies: existing.copies + copies, lastScannedAt: now };

  return {
    state: { ...state, owned: { ...state.owned, [card.key]: updated } },
    newCopies: updated.copies,
    isNew: existing === undefined,
  };
}

/** Removes a single copy, deleting the entry when the last copy goes. */
export function removeCard(
  state: CollectionState,
  key: string,
  copies = 1,
): CollectionState {
  const existing = state.owned[key];
  if (existing === undefined) return state;

  const remaining = existing.copies - copies;
  const owned = { ...state.owned };
  if (remaining > 0) {
    owned[key] = { ...existing, copies: remaining };
  } else {
    delete owned[key];
  }
  return { ...state, owned };
}

/** Aggregated collection progress, returned by {@link computeStats}. */
export interface CollectionStats {
  uniqueOwned: number;
  totalCopies: number;
  /** Unique owned cards per set code. */
  perSet: Record<string, number>;
  /** Copies owned per set code. */
  copiesPerSet: Record<string, number>;
  totalCards: number;
  /** Completion in 0..1 across the whole database. */
  completion: number;
}

/** Aggregates collection progress, ignoring owned keys absent from the database. */
export function computeStats(
  collection: CollectionState,
  db: CardDatabase,
): CollectionStats {
  const cardsByKey = new Map(db.cards.map((card) => [card.key, card]));
  const perSet: Record<string, number> = {};
  const copiesPerSet: Record<string, number> = {};
  for (const set of db.sets) {
    perSet[set.code] = 0;
    copiesPerSet[set.code] = 0;
  }

  let uniqueOwned = 0;
  let totalCopies = 0;

  for (const entry of Object.values(collection.owned)) {
    const card = cardsByKey.get(entry.key);
    if (card === undefined) continue; // stale key from an older card database
    uniqueOwned += 1;
    totalCopies += entry.copies;
    perSet[card.setCode] = (perSet[card.setCode] ?? 0) + 1;
    copiesPerSet[card.setCode] = (copiesPerSet[card.setCode] ?? 0) + entry.copies;
  }

  return {
    uniqueOwned,
    totalCopies,
    perSet,
    copiesPerSet,
    totalCards: db.cards.length,
    completion: db.cards.length === 0 ? 0 : uniqueOwned / db.cards.length,
  };
}

export type CollectionSort = 'number' | 'name' | 'recent' | 'copies';

export interface CollectionFilter {
  /** Restrict to a single set code; null means all sets. */
  setCode: string | null;
  /** Free-text query matched against card name and identifier. */
  query: string;
  /** When true, only show cards with more than one copy. */
  duplicatesOnly: boolean;
  sort: CollectionSort;
}

export function defaultFilter(): CollectionFilter {
  return { setCode: null, query: '', duplicatesOnly: false, sort: 'number' };
}

export interface CollectionRow {
  card: CardRecord;
  owned: OwnedCard;
}

/** Filters and sorts the collection for display. */
export function selectRows(
  collection: CollectionState,
  db: CardDatabase,
  filter: CollectionFilter,
): CollectionRow[] {
  const cardsByKey = new Map(db.cards.map((card) => [card.key, card]));
  const query = filter.query.trim().toLowerCase();

  const rows: CollectionRow[] = [];
  for (const owned of Object.values(collection.owned)) {
    const card = cardsByKey.get(owned.key);
    if (card === undefined) continue;
    if (filter.setCode !== null && card.setCode !== filter.setCode) continue;
    if (filter.duplicatesOnly && owned.copies < 2) continue;
    if (query.length > 0) {
      const haystack = `${card.name} ${card.id} ${card.printingName}`.toLowerCase();
      if (!haystack.includes(query)) continue;
    }
    rows.push({ card, owned });
  }

  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  rows.sort((a, b) => {
    switch (filter.sort) {
      case 'name':
        return collator.compare(a.card.name, b.card.name) || collator.compare(a.card.key, b.card.key);
      case 'recent':
        return b.owned.lastScannedAt.localeCompare(a.owned.lastScannedAt);
      case 'copies':
        return b.owned.copies - a.owned.copies || collator.compare(a.card.key, b.card.key);
      case 'number':
      default:
        return (
          a.card.setCode.localeCompare(b.card.setCode) ||
          collator.compare(a.card.number, b.card.number) ||
          a.card.variant.localeCompare(b.card.variant)
        );
    }
  });

  return rows;
}
