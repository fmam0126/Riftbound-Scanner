/**
 * Tests for the collection export.
 *
 * Two formats are produced, and both are asserted here rather than only being
 * checked by eye in the app:
 *
 *  - the **card-code list**, which exists to be pasted into another tracker. Its
 *    contract is the card code itself, so the tests pin the exact codes for
 *    ordinary, alternate-art and promo printings.
 *  - the **CSV**, whose contract is that the columns line up. A stray comma in a
 *    card name silently shifting every later column is the failure mode worth
 *    guarding, because the file still looks fine in a text editor.
 *
 * The rows are built from the real generated database, matching the rest of the
 * suite: a hand-written fixture would not catch a change in how the generator
 * spells a variant.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CardDatabase, CardRecord, CollectionState } from '../src/types.ts';
import { getDatabase } from '../src/data/cards.ts';
import {
  CSV_COLUMNS,
  cardCode,
  csvField,
  describeExport,
  exportFileName,
  exportRecords,
  exportRows,
  formatCardCodeList,
  formatCollection,
  formatCsv,
  type ExportRecord,
} from '../src/logic/exportCollection.ts';

const db: CardDatabase = getDatabase();

/** Looks a card up by key, failing loudly so a data change is not a silent skip. */
function card(key: string): CardRecord {
  const found = db.cards.find((c) => c.key === key);
  assert.ok(found !== undefined, `expected the database to contain ${key}`);
  return found;
}

/** A collection holding `copies` of each named key. */
function collectionOf(entries: Array<[string, number]>): CollectionState {
  const owned: CollectionState['owned'] = {};
  for (const [key, copies] of entries) {
    owned[key] = {
      key,
      copies,
      firstScannedAt: '2026-01-01T00:00:00.000Z',
      lastScannedAt: '2026-01-01T00:00:00.000Z',
    };
  }
  return { version: 1, owned };
}

/**
 * The whole export path in one call: collection -> resolved records -> text.
 *
 * Mirrors what the export sheet does, so these tests exercise the same
 * composition the app uses rather than a hand-resolved row list.
 */
function exportOf(
  entries: Array<[string, number]>,
  format: 'text' | 'csv',
): string {
  return formatCollection(exportRecords(collectionOf(entries), db), format);
}

/** Parses a CSV line, honouring quoted fields, so tests can assert on columns. */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

describe('exportRows', () => {
  it('drops keys that are not in the database', () => {
    const collection = collectionOf([
      ['OGN-160', 1],
      ['NOT-A-CARD', 3],
    ]);
    const rows = exportRows(collection, db);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0]?.card.key, 'OGN-160');
  });

  it('keeps copies of cards owned more than once', () => {
    const rows = exportRows(collectionOf([['OGN-160', 4]]), db);
    assert.strictEqual(rows[0]?.copies, 4);
  });

  it('ignores entries with no copies', () => {
    const collection = collectionOf([['OGN-160', 1]]);
    collection.owned['OGN-161'] = {
      key: 'OGN-161',
      copies: 0,
      firstScannedAt: '2026-01-01T00:00:00.000Z',
      lastScannedAt: '2026-01-01T00:00:00.000Z',
    };
    assert.strictEqual(exportRows(collection, db).length, 1);
  });

  it('is empty for an empty collection', () => {
    assert.deepStrictEqual(exportRows(collectionOf([]), db), []);
  });
});

describe('cardCode', () => {
  it('is the printed identity of an ordinary card', () => {
    assert.strictEqual(cardCode(card('OGN-160')), 'OGN-160');
  });

  it('includes the alternate-art letter, which card.id omits', () => {
    const alternate = card('OGN-007a');
    // `id` is the base number; the variant lives on its own field. If the code
    // were read from `id`, base and alternate art would be indistinguishable.
    assert.strictEqual(alternate.id, 'OGN-007');
    assert.strictEqual(cardCode(alternate), 'OGN-007a');
  });

  it('uses the signed suffix rather than the asterisk TCGplayer prints', () => {
    const signed = db.cards.find((c) => c.variant === 's');
    assert.ok(signed !== undefined, 'expected a signed printing in the database');
    assert.ok(cardCode(signed).endsWith('s'));
  });

  it('distinguishes every card that shares a printed number', () => {
    // The promo bundles publish one collector number for several different
    // cards, so this is the case where a code alone cannot be unique.
    const overlapping = db.cards.filter((c) => c.setCode === 'OPP' && c.number === '001');
    assert.ok(overlapping.length > 1, 'expected OPP-001 to be reused');
    const keys = new Set(overlapping.map((c) => c.key));
    assert.strictEqual(keys.size, overlapping.length, 'keys must stay unique');
  });
});

describe('formatCardCodeList', () => {
  it('writes one "count CODE" line per owned printing', () => {
    const text = formatCardCodeList(
      exportRecords(collectionOf([['OGN-007', 1], ['OGN-160', 2]]), db),
    );
    assert.deepStrictEqual(text.split('\n'), ['1 OGN-007', '2 OGN-160']);
  });

  it('writes nothing at all for an empty collection', () => {
    // Not a header, not a newline: an empty file is the honest representation,
    // and importers reject a file whose first line is not a card.
    assert.strictEqual(exportOf([], 'text'), '');
  });

  it('never emits the disambiguating "~" suffix, which is not a card code', () => {
    const promo = db.cards.find((c) => c.key.includes('~'));
    assert.ok(promo !== undefined, 'expected a disambiguated promo in the database');
    const text = formatCardCodeList(exportRecords(collectionOf([[promo.key, 1]]), db));
    assert.strictEqual(text.includes('~'), false);
    assert.strictEqual(text, `1 ${cardCode(promo)}`);
  });

  it('sorts by set, then by collector number', () => {
    // Collector numbers are stored zero-padded to three digits, so `099` sorts
    // before `160` on the digits alone. The collator is still numeric rather
    // than lexicographic, so an unpadded number added upstream would order
    // correctly instead of landing between `099` and `100`.
    const text = formatCardCodeList(
      exportRecords(collectionOf([['OGN-160', 1], ['OGN-099', 1], ['SFD-001', 1]]), db),
    );
    const codes = text.split('\n').map((line) => line.split(' ')[1]);
    assert.deepStrictEqual(codes, ['OGN-099', 'OGN-160', 'SFD-001']);
  });

  it('orders collector numbers numerically when padding differs', () => {
    // The committed database pads every number to three digits, so `099` before
    // `160` is already true lexicographically and does not exercise the
    // collator. If the generator ever emitted an unpadded number, a plain string
    // sort would put `160` before `99`; this pins the numeric behaviour that
    // prevents it. `formatCsv` applies the same ordering, so no database lookup
    // is involved.
    const base = exportRecords(collectionOf([['OGN-160', 1]]), db)[0] as ExportRecord;
    const records: ExportRecord[] = [
      { ...base, number: '99', code: 'OGN-99' },
      { ...base, number: '160', code: 'OGN-160' },
    ];

    const lines = formatCsv(records).trimEnd().split('\n').slice(1);
    const numbers = lines.map((line) => splitCsvLine(line)[4]);
    assert.deepStrictEqual(numbers, ['99', '160']);
  });

  it('lists a base printing before its alternate art', () => {
    const text = formatCardCodeList(
      exportRecords(collectionOf([['OGN-007a', 1], ['OGN-007', 1]]), db),
    );
    assert.deepStrictEqual(text.split('\n'), ['1 OGN-007', '1 OGN-007a']);
  });
});

describe('csvField', () => {
  it('leaves an ordinary value alone', () => {
    assert.strictEqual(csvField('Legion Rearguard'), 'Legion Rearguard');
  });

  it('quotes a value containing a comma', () => {
    assert.strictEqual(csvField('Darius, Trifarian'), '"Darius, Trifarian"');
  });

  it('quotes a value containing a quote, and doubles the quote', () => {
    assert.strictEqual(csvField('Kai"Sa'), '"Kai""Sa"');
  });

  it('quotes a value containing a newline', () => {
    assert.strictEqual(csvField('two\nlines'), '"two\nlines"');
  });
});

describe('formatCsv', () => {
  it('emits the header even for an empty collection', () => {
    const csv = formatCsv([]);
    assert.strictEqual(csv, `${CSV_COLUMNS.join(',')}\n`);
  });

  it('opens with the column order the tracking sites share', () => {
    // Amount, Name, Set Code, Set Name, Collector Number is the run both
    // MythicHub and ManaBox export, so a site expecting that shape still reads
    // the leading columns correctly.
    assert.deepStrictEqual(CSV_COLUMNS.slice(0, 5), [
      'Amount',
      'Name',
      'Set Code',
      'Set Name',
      'Collector Number',
    ]);
  });

  it('gives every row exactly as many columns as the header', () => {
    const csv = exportOf([['OGN-160', 3], ['OGN-007a', 1], ['OPP-001~2', 2]], 'csv');
    const lines = csv.trimEnd().split('\n');
    assert.strictEqual(lines.length, 4);
    for (const line of lines) {
      assert.strictEqual(splitCsvLine(line).length, CSV_COLUMNS.length);
    }
  });

  it('keeps a comma-containing name inside its own column', () => {
    // Many Riftbound names carry a comma ("Darius, Trifarian"), so this is the
    // ordinary case rather than an edge one.
    const csv = exportOf([['OGN-027a', 1]], 'csv');
    const row = splitCsvLine(csv.trimEnd().split('\n')[1] as string);
    assert.strictEqual(row[1], 'Darius, Trifarian (Alternate Art)');
    assert.strictEqual(row[5], 'OGN-027a');
  });

  it('reports the zero-padded printed number', () => {
    const csv = exportOf([['OGN-007', 1]], 'csv');
    const row = splitCsvLine(csv.trimEnd().split('\n')[1] as string);
    const numberIndex = CSV_COLUMNS.indexOf('Collector Number');
    assert.strictEqual(row[numberIndex], '007');
  });

  it('carries the key so rows sharing a printed number stay distinguishable', () => {
    const csv = exportOf([['OPP-001~2', 1], ['OPP-001', 1]], 'csv');
    const rows = csv.trimEnd().split('\n').slice(1).map(splitCsvLine);
    const keyIndex = CSV_COLUMNS.indexOf('Key');
    const codeIndex = CSV_COLUMNS.indexOf('Card Code');
    const keys = rows.map((row) => row[keyIndex]);
    assert.strictEqual(new Set(keys).size, keys.length);
    // Both print the same code, which is precisely why Key has to be there.
    assert.strictEqual(rows[0]?.[codeIndex], rows[1]?.[codeIndex]);
    // ...and they are genuinely different cards, not one card twice.
    assert.notStrictEqual(rows[0]?.[1], rows[1]?.[1]);
  });

  it('names the set rather than only its code', () => {
    const csv = exportOf([['OGN-160', 1]], 'csv');
    const row = splitCsvLine(csv.trimEnd().split('\n')[1] as string);
    // Taken from the database rather than hardcoded, so a set rename upstream is
    // not a test failure.
    const origins = db.sets.find((s) => s.code === 'OGN');
    assert.strictEqual(row[CSV_COLUMNS.indexOf('Set Name')], origins?.name);
  });

  it('leaves an absent field empty rather than writing "null"', () => {
    const csv = exportOf([['OGN-160', 1]], 'csv');
    const row = splitCsvLine(csv.trimEnd().split('\n')[1] as string);
    const domainIndex = CSV_COLUMNS.indexOf('Domain');
    assert.strictEqual(row[domainIndex]?.includes('null'), false);
  });
});

describe('formatCollection', () => {
  it('round-trips the same cards through both formats', () => {
    const entries: Array<[string, number]> = [['OGN-160', 2], ['OGN-007a', 1]];
    const text = exportOf(entries, 'text');
    const csv = exportOf(entries, 'csv');

    const textCodes = text.split('\n').map((line) => line.split(' ')[1]);
    const csvCodes = csv
      .trimEnd()
      .split('\n')
      .slice(1)
      .map((line) => splitCsvLine(line)[CSV_COLUMNS.indexOf('Card Code')]);

    assert.deepStrictEqual(textCodes, csvCodes);
  });

  it('preserves every copy count', () => {
    const text = exportOf([['OGN-160', 4], ['OGN-161', 2]], 'text');
    // Ordered by collector number: 160 before 161, so 4 copies then 2.
    const counts = text.split('\n').map((line) => Number(line.split(' ')[0]));
    assert.deepStrictEqual(counts, [4, 2]);
    assert.strictEqual(
      counts.reduce((total, n) => total + n, 0),
      6,
    );
  });

  it('exports a large collection without losing a row', () => {
    // The real failure mode for a 1400-card collection is a formatter that
    // truncates or de-duplicates; both would be invisible in a small sample.
    const everyCard = db.cards.map((c) => [c.key, 1] as [string, number]);
    const records = exportRecords(collectionOf(everyCard), db);
    assert.strictEqual(records.length, db.cards.length);
    assert.strictEqual(formatCardCodeList(records).split('\n').length, db.cards.length);
  });
});

describe('exportFileName', () => {
  const day = new Date(2026, 7, 22);

  it('is dated and carries the format extension', () => {
    assert.strictEqual(exportFileName('csv', day), 'riftbound-collection-2026-08-22.csv');
    assert.strictEqual(exportFileName('text', day), 'riftbound-collection-2026-08-22.txt');
  });

  it('zero-pads a single-digit month and day', () => {
    assert.strictEqual(
      exportFileName('csv', new Date(2026, 0, 5)),
      'riftbound-collection-2026-01-05.csv',
    );
  });
});

describe('describeExport', () => {
  it('summarises cards and copies, keeping them distinct', () => {
    const records = exportRecords(collectionOf([['OGN-160', 3], ['OGN-161', 1]]), db);
    assert.strictEqual(describeExport(records), '2 cards · 4 copies');
  });

  it('uses singular wording for one card and one copy', () => {
    const records = exportRecords(collectionOf([['OGN-160', 1]]), db);
    assert.strictEqual(describeExport(records), '1 card · 1 copy');
  });
});
