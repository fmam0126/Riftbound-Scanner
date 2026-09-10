/**
 * Tests for the card-database generator's parsing rules.
 *
 * The `Number` field TCGplayer publishes is not uniform — alternate arts,
 * signature printings, special art codes, runes and tokens all use different
 * shapes, and promo bundles reuse collector numbers across genuinely different
 * cards. These cases come from the real catalogue, not from imagination, so the
 * generator cannot silently start producing wrong keys.
 */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

import {
  KEY_PATTERN,
  assignUniqueKeys,
  parsePrintedNumber,
  productToCard,
  validate,
} from '../scripts/build-card-db.ts';
import type { CardDatabase, CardRecord } from '../src/types.ts';

describe('parsePrintedNumber — ordinary cards', () => {
  it('parses a plain collector number', () => {
    const parsed = parsePrintedNumber('010/298');
    assert.strictEqual(parsed?.prefix, '');
    assert.strictEqual(parsed?.number, '010');
    assert.strictEqual(parsed?.variant, '');
    assert.strictEqual(parsed?.setTotal, '298');
  });

  it('parses without a set total', () => {
    const parsed = parsePrintedNumber('010');
    assert.strictEqual(parsed?.number, '010');
    assert.strictEqual(parsed?.setTotal, null);
  });

  it('treats a trailing letter as an alternate-art variant', () => {
    const parsed = parsePrintedNumber('007a/298');
    assert.strictEqual(parsed?.number, '007');
    assert.strictEqual(parsed?.variant, 'a');
    assert.strictEqual(parsed?.prefix, '');
  });

  it('handles a second alternate letter', () => {
    const parsed = parsePrintedNumber('246b/298');
    assert.strictEqual(parsed?.number, '246');
    assert.strictEqual(parsed?.variant, 'b');
  });
});

describe('parsePrintedNumber — promo and special printings', () => {
  it('normalises a signature asterisk into a letter variant', () => {
    const parsed = parsePrintedNumber('190*/166');
    assert.strictEqual(parsed?.number, '190');
    assert.strictEqual(parsed?.variant, 's');
    assert.strictEqual(parsed?.prefix, '');
  });

  it('rejects special-art codes, whose digits duplicate a real number', () => {
    // "SP3/006" is special art number 006, and Vendetta already has a card at
    // 006. Keeping both would give two cards the same identifier, which a scan
    // could never tell apart.
    assert.strictEqual(parsePrintedNumber('SP3/006'), null);
  });

  it('reads a space-separated bundle identifier', () => {
    const parsed = parsePrintedNumber('T1A 001/005');
    assert.strictEqual(parsed?.number, '001');
    assert.strictEqual(parsed?.variant, 't1a');
    assert.strictEqual(parsed?.prefix, '');
  });
});

describe('parsePrintedNumber — rejections', () => {
  it('rejects rune indices, which are not unique card identifiers', () => {
    assert.strictEqual(parsePrintedNumber('R01'), null);
    assert.strictEqual(parsePrintedNumber('R04a'), null);
  });

  it('rejects double-sided token identifiers', () => {
    assert.strictEqual(parsePrintedNumber('T05 // T06'), null);
    assert.strictEqual(parsePrintedNumber('T01 // T02'), null);
  });

  it('rejects token numbers, which have no unique collector number', () => {
    assert.strictEqual(parsePrintedNumber('T01/T02'), null);
  });

  it('rejects empty and non-numeric values', () => {
    assert.strictEqual(parsePrintedNumber(''), null);
    assert.strictEqual(parsePrintedNumber('abc'), null);
  });
});

describe('parsePrintedNumber — printing qualifiers', () => {
  it('falls back to the qualifier when the number carries no distinction', () => {
    // The five Worlds Champion bundles all print number 001, so the
    // parenthesised qualifier is the only thing separating them.
    const a = parsePrintedNumber('T1A 001/005', 'Ambessa (Player Bundle)');
    const b = parsePrintedNumber('T1S 001/005', 'Ambessa (Signature Edition Bundle)');
    assert.notStrictEqual(a?.variant, b?.variant);
  });

  it('does not add a qualifier when the printed number already distinguishes', () => {
    const parsed = parsePrintedNumber('007a/298', 'Fury Rune (Alternate Art)');
    assert.strictEqual(parsed?.variant, 'a');
  });
});

describe('assignUniqueKeys', () => {
  const card = (key: string, overrides: Partial<CardRecord> = {}): CardRecord => ({
    setCode: 'OPP',
    prefix: '',
    number: '001',
    variant: '',
    id: 'OPP-001',
    key,
    name: 'Test',
    printingName: 'Test',
    rarity: null,
    cardType: null,
    domain: null,
    tags: [],
    energyCost: null,
    powerCost: null,
    might: null,
    description: null,
    flavorText: null,
    setTotal: null,
    imageUrl: null,
    productId: 1,
    ...overrides,
  });

  it('keeps the plain key for the first claimant', () => {
    const result = assignUniqueKeys([card('OPP-001')]);
    assert.strictEqual(result[0]?.key, 'OPP-001');
  });

  it('disambiguates repeated numbers with a numeric suffix', () => {
    const result = assignUniqueKeys([card('a'), card('b'), card('c')]);
    assert.deepStrictEqual(
      result.map((c) => c.key),
      ['OPP-001', 'OPP-001~2', 'OPP-001~3'],
    );
  });

  it('never produces a duplicate key', () => {
    const result = assignUniqueKeys([
      card('x', { number: '001' }),
      card('y', { number: '001' }),
      card('z', { number: '001', variant: 'a' }),
      card('w', { number: '002' }),
    ]);
    const keys = new Set(result.map((c) => c.key));
    assert.strictEqual(keys.size, result.length);
  });

  it('produces keys matching the documented pattern', () => {
    const result = assignUniqueKeys([
      card('a'),
      card('b'),
      card('c', { number: '007', variant: 'alternateart' }),
      card('d', { number: '01', prefix: 'T' }),
    ]);
    for (const entry of result) {
      assert.ok(KEY_PATTERN.test(entry.key), `key ${entry.key} failed the pattern`);
    }
  });
});

describe('productToCard', () => {
  it('returns null for sealed product without a Number field', () => {
    const card = productToCard(
      { productId: 1, name: 'Origins Booster Pack', groupId: 24344, extendedData: [] },
      'OGN',
    );
    assert.strictEqual(card, null);
  });

  it('maps extendedData fields onto a card record', () => {
    const card = productToCard(
      {
        productId: 652771,
        name: 'Blazing Scorcher',
        imageUrl: 'https://example.test/1.jpg',
        groupId: 24344,
        extendedData: [
          { name: 'Rarity', value: 'Common' },
          { name: 'Number', value: '001/298' },
          { name: 'Card Type', value: 'Unit' },
          { name: 'Domain', value: 'Fury' },
          { name: 'Tag', value: 'Noxus;Dragon' },
          { name: 'Energy Cost', value: '5' },
          { name: 'Might', value: '5' },
        ],
      },
      'OGN',
    );

    assert.strictEqual(card?.key, 'OGN-001');
    assert.strictEqual(card?.id, 'OGN-001');
    assert.strictEqual(card?.rarity, 'Common');
    assert.strictEqual(card?.cardType, 'Unit');
    assert.strictEqual(card?.domain, 'Fury');
    assert.deepStrictEqual(card?.tags, ['Noxus', 'Dragon']);
    assert.strictEqual(card?.energyCost, 5);
    assert.strictEqual(card?.might, 5);
  });
});

describe('validate', () => {
  const db = JSON.parse(readFileSync('src/data/cards.json', 'utf8')) as CardDatabase;

  it('reports no problems for the committed database', () => {
    assert.deepStrictEqual(validate(db), []);
  });

  it('detects a corrupted key', () => {
    const broken: CardDatabase = {
      ...db,
      cards: [{ ...db.cards[0]!, key: 'NOT-A-KEY' }, ...db.cards.slice(1)],
    };
    assert.ok(validate(broken).length > 0);
  });

  it('detects a mismatched card count', () => {
    const broken: CardDatabase = {
      ...db,
      meta: { ...db.meta, cardCount: db.meta.cardCount + 1 },
    };
    assert.ok(validate(broken).some((p) => p.includes('cardCount')));
  });
});
