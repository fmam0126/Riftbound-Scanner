/**
 * Access to the bundled card database.
 *
 * The database is a static JSON file shipped inside the app bundle. That is a
 * deliberate choice: scanning must work instantly and offline, so there is no
 * network fetch on the scan path and no loading state to handle.
 *
 * It is loaded lazily because the file is ~850 KB, and parsed once per session.
 */

import type { CardDatabase, CardRecord } from '../types.ts';

// The `with { type: 'json' }` attribute is required by Node's ESM loader when the
// test suite imports this module directly. Metro ignores it.
import rawDatabase from '../data/cards.json' with { type: 'json' };

let cached: CardDatabase | null = null;

/** Returns the parsed card database, parsing the JSON only on first use. */
export function getDatabase(): CardDatabase {
  if (cached === null) {
    cached = rawDatabase as unknown as CardDatabase;
  }
  return cached;
}

/**
 * Pre-built, lowercased search fields for every card.
 *
 * Built once on first search. Recomputing `toLowerCase()` over 1400+ cards on
 * every keystroke is the difference between a search that keeps up with typing
 * and one that visibly stutters, so the strings are prepared up front.
 */
interface SearchIndexEntry {
  card: CardRecord;
  name: string;
  id: string;
  printingName: string;
}

let searchIndex: SearchIndexEntry[] | null = null;

function getSearchIndex(): SearchIndexEntry[] {
  if (searchIndex === null) {
    searchIndex = getDatabase().cards.map((card) => ({
      card,
      name: card.name.toLowerCase(),
      id: card.id.toLowerCase(),
      printingName: card.printingName.toLowerCase(),
    }));
  }
  return searchIndex;
}

/**
 * Case- and punctuation-insensitive card search over name and identifier.
 *
 * Used by the Browse tab, which doubles as the manual fallback when a scan is
 * unreadable or reads a card the matcher cannot resolve.
 *
 * Results are truncated to `limit`; pair with {@link countSearchMatches} and a
 * growing limit to page through a large set instead of rendering it all.
 */
export function searchCards(
  query: string,
  options: { setCode?: string | null; limit?: number } = {},
): CardRecord[] {
  const limit = options.limit ?? 60;
  const normalized = query.trim().toLowerCase();
  const entries = getSearchIndex().filter(
    (entry) => options.setCode == null || entry.card.setCode === options.setCode,
  );

  if (normalized.length === 0) {
    return entries.slice(0, limit).map((entry) => entry.card);
  }

  const terms = normalized.split(/\s+/).filter(Boolean);
  const scored: Array<{ card: CardRecord; score: number }> = [];

  for (const entry of entries) {
    let score = 0;
    let matchedAll = true;

    for (const term of terms) {
      // Identifier matches are exact and rank highest.
      if (entry.id.startsWith(term)) score += 100;
      else if (entry.id.includes(term)) score += 40;

      if (entry.name.startsWith(term)) score += 50;
      else if (entry.name.includes(term)) score += 20;
      else if (entry.printingName.includes(term)) score += 10;
      else if (!entry.id.includes(term)) matchedAll = false;
    }

    if (matchedAll && score > 0) scored.push({ card: entry.card, score });
  }

  scored.sort((a, b) => b.score - a.score || a.card.key.localeCompare(b.card.key));
  return scored.slice(0, limit).map((entry) => entry.card);
}

/** Number of cards a search matches, so the UI can show totals and page. */
export function countSearchMatches(
  query: string,
  options: { setCode?: string | null } = {},
): number {
  const normalized = query.trim().toLowerCase();
  const entries = getSearchIndex().filter(
    (entry) => options.setCode == null || entry.card.setCode === options.setCode,
  );
  if (normalized.length === 0) return entries.length;

  const terms = normalized.split(/\s+/).filter(Boolean);
  let count = 0;
  for (const entry of entries) {
    const matched = terms.every(
      (term) =>
        entry.name.includes(term) ||
        entry.id.includes(term) ||
        entry.printingName.includes(term),
    );
    if (matched) count += 1;
  }
  return count;
}
