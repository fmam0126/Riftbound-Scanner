/**
 * Tests for the Browse tab's search and paging.
 *
 * The card database is ~1400 entries, so the screen only renders a window of the
 * results and grows it as the user scrolls. These tests pin the two invariants
 * that make that safe: the count must agree with what the search actually
 * returns, and paging must not change the order or drop cards.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  countSearchMatches,
  getDatabase,
  searchCards,
} from '../src/data/cards.ts';

const db = getDatabase();

describe('searchCards', () => {
  it('returns the first page when there is no query', () => {
    const results = searchCards('', { limit: 40 });
    assert.strictEqual(results.length, 40);
    assert.strictEqual(results[0]?.key, db.cards[0]?.key);
  });

  it('ranks an exact identifier above a name match', () => {
    const results = searchCards('OGN-010', { limit: 10 });
    assert.strictEqual(results[0]?.key, 'OGN-010');
  });

  it('finds a card by name', () => {
    const results = searchCards('Legion Rearguard', { limit: 10 });
    assert.ok(results.some((card) => card.key === 'OGN-010'));
  });

  it('matches a printing name that differs from the card name', () => {
    // Alternate arts are only distinguishable by the TCGplayer printing name.
    const results = searchCards('alternate art', { limit: 20 });
    assert.ok(results.length > 0, 'should find alternate-art printings');
    assert.ok(results.every((card) => card.printingName.toLowerCase().includes('alternate')));
  });

  it('filters by set code', () => {
    const results = searchCards('', { setCode: 'SFD', limit: 50 });
    assert.ok(results.length > 0);
    assert.ok(results.every((card) => card.setCode === 'SFD'));
  });

  it('respects the limit', () => {
    for (const limit of [1, 5, 40]) {
      assert.strictEqual(searchCards('', { limit }).length, Math.min(limit, db.cards.length));
    }
  });

  it('returns nothing for a query that matches no card', () => {
    assert.deepStrictEqual(searchCards('zzzznotacard', { limit: 10 }), []);
  });
});

describe('countSearchMatches', () => {
  it('counts every card when there is no query', () => {
    assert.strictEqual(countSearchMatches(''), db.cards.length);
  });

  it('counts only the cards in the selected set', () => {
    const sfd = db.sets.find((set) => set.code === 'SFD');
    assert.strictEqual(countSearchMatches('', { setCode: 'SFD' }), sfd?.cardCount);
  });

  it('agrees with the number of results an unbounded search returns', () => {
    for (const query of ['', 'poro', 'OGN', 'alternate', 'rune', 'zzzznotacard']) {
      const total = countSearchMatches(query);
      const all = searchCards(query, { limit: Number.MAX_SAFE_INTEGER }).length;
      assert.strictEqual(
        total,
        all,
        `count ${total} disagrees with search results ${all} for ${JSON.stringify(query)}`,
      );
    }
  });

  it('agrees with search results within a set', () => {
    for (const query of ['poro', 'blade', '']) {
      const total = countSearchMatches(query, { setCode: 'OGN' });
      const all = searchCards(query, { setCode: 'OGN', limit: Number.MAX_SAFE_INTEGER }).length;
      assert.strictEqual(total, all, `set-scoped count disagreed for ${JSON.stringify(query)}`);
    }
  });
});

describe('paging', () => {
  it('returns a prefix of the full result set as the limit grows', () => {
    // This is what the Browse tab relies on: growing `limit` must extend the
    // list, never reshuffle or drop entries the user has already scrolled past.
    const query = 'poro';
    const pageA = searchCards(query, { limit: 5 });
    const pageB = searchCards(query, { limit: 10 });

    assert.ok(pageA.length <= pageB.length);
    for (let i = 0; i < pageA.length; i += 1) {
      assert.strictEqual(
        pageA[i]?.key,
        pageB[i]?.key,
        `entry ${i} changed when the limit grew`,
      );
    }
  });

  it('never returns duplicates across a growing window', () => {
    const grown = searchCards('rune', { limit: 60 });
    const keys = grown.map((card) => card.key);
    assert.strictEqual(new Set(keys).size, keys.length, 'results contained duplicates');
  });

  it('reaches every match when the limit is unlimited', () => {
    const total = countSearchMatches('poro');
    const all = searchCards('poro', { limit: Number.MAX_SAFE_INTEGER });
    assert.strictEqual(all.length, total);
  });
});

describe('database access', () => {
  it('exposes a stable card array across calls', () => {
    assert.strictEqual(getDatabase().cards, getDatabase().cards);
  });

  it('has a card count that matches the metadata', () => {
    assert.strictEqual(db.cards.length, db.meta.cardCount);
  });
});
