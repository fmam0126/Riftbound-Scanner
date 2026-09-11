/**
 * Collection export formatting.
 *
 * Two formats, because no single one is universally accepted:
 *
 *  1. **Card-code list** — `2 OGN-007` per line. This is the interchange format
 *     Riftbound trackers actually agree on: the card code is the identifier
 *     Piltover Archive's own `@piltoverarchive/riftbound-deck-codes` library
 *     defines (`SET-NUMBER` plus an optional prefix and variant suffix), and
 *     deckbuilders that accept a pasted list parse exactly this shape.
 *  2. **CSV** — for spreadsheets, and for tracking sites that only accept a
 *     file. The leading columns follow the order MythicHub and ManaBox both use
 *     (`Amount, Name, Set Code, Set Name, Collector Number, ...`); the columns
 *     after that are Riftbound-specific and exist so the export is not lossy.
 *
 * Neither format encodes the collection the way a *deck code* would: those are
 * a separate base32 scheme that stores a deck, not an inventory, and cannot
 * represent copy counts of an arbitrary collection.
 *
 * Everything here is pure — no React, no native imports — so both formats are
 * unit tested against the real generated card database, exactly like the
 * matcher.
 */

import type { CardDatabase, CardRecord, CollectionState } from '../types.ts';

/** A card the user owns, flattened down to just what an export needs. */
export interface ExportRow {
  card: CardRecord;
  copies: number;
}

/**
 * A row reduced to the export's own vocabulary.
 *
 * Named for the printed identity rather than reusing `CardRecord`'s field names,
 * because the distinction between `code` and `key` is the whole reason this type
 * exists — see {@link toExportRecord}.
 */
export interface ExportRecord {
  /** Printed identity, e.g. `OGN-007a`. Safe to hand to another app. */
  code: string;
  /**
   * The collection key, e.g. `OGN-007a` or `OPP-001~2`.
   *
   * Only differs from `code` for the promo bundles that publish one collector
   * number for several genuinely different cards; the `~2` suffix is what
   * distinguishes them. Kept because a CSV needs to be able to tell those rows
   * apart, and dropped from the card-code list because `~2` is not a card code
   * any other app would recognise.
   */
  key: string;
  copies: number;
  name: string;
  printingName: string;
  setCode: string;
  setName: string;
  /** Printed collector number, e.g. `007`. Quoted so spreadsheets keep the zeros. */
  number: string;
  /** Raw TCGplayer variant label, e.g. `a`, `s`, `overnumbered`. */
  variant: string;
  rarity: string;
  domain: string;
  cardType: string;
  energyCost: string;
  might: string;
  productId: string;
}

export type ExportFormat = 'text' | 'csv';

/**
 * Formats the export for the file name and the format picker.
 *
 * `extension` is what the file is actually written as; `label` and
 * `description` are what the user chooses between.
 */
export const EXPORT_FORMATS: ReadonlyArray<{
  format: ExportFormat;
  label: string;
  extension: string;
  description: string;
}> = [
  {
    format: 'text',
    label: 'Card list',
    extension: 'txt',
    description: '2 OGN-007 — paste into a deck builder or tracker',
  },
  {
    format: 'csv',
    label: 'Spreadsheet (CSV)',
    extension: 'csv',
    description: 'One row per printing — opens in Excel or Sheets',
  },
];

/**
 * The printed card code for a card: set code, number, then variant.
 *
 * Built from the parts rather than read from `card.id`, because `id` is the
 * *base* number for an alternate art — the `a` in `OGN-007a` lives only in the
 * variant field. Reading `id` would collapse a base printing and its alternate
 * art into one indistinguishable code, which is exactly the distinction a
 * collection export exists to preserve.
 */
export function cardCode(card: CardRecord): string {
  return `${card.setCode}-${card.number}${card.variant}`;
}

/**
 * Sorts rows into the order a reader expects to see them.
 *
 * Set code, then collector number compared numerically (`10` before `9` would be
 * wrong), then variant, so a base printing precedes its alternate art.
 */
function compareRows(a: ExportRecord, b: ExportRecord): number {
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  return (
    a.setCode.localeCompare(b.setCode) ||
    collator.compare(a.number, b.number) ||
    a.variant.localeCompare(b.variant)
  );
}

/** Renders a nullable card field as an empty string rather than `null`. */
function field(value: string | number | null): string {
  return value === null ? '' : String(value);
}

/**
 * Collects the owned rows of a collection, resolving each against the database.
 *
 * A key with no matching card is dropped rather than exported blind: it means
 * the collection refers to a card the current database no longer has (a promo
 * that was renumbered upstream), and writing it out would produce an export the
 * destination site cannot resolve.
 */
export function exportRows(collection: CollectionState, db: CardDatabase): ExportRow[] {
  const cardsByKey = new Map(db.cards.map((card) => [card.key, card]));

  const rows: ExportRow[] = [];
  for (const owned of Object.values(collection.owned)) {
    if (owned.copies < 1) continue;
    const card = cardsByKey.get(owned.key);
    if (card === undefined) continue;
    rows.push({ card, copies: owned.copies });
  }
  return rows;
}

/** Flattens the database lookup into the export's own column vocabulary. */
export function toExportRecord(row: ExportRow, db: CardDatabase): ExportRecord {
  const { card, copies } = row;
  const set = db.sets.find((s) => s.code === card.setCode);
  return {
    code: cardCode(card),
    key: card.key,
    copies,
    name: card.name,
    printingName: card.printingName,
    setCode: card.setCode,
    setName: set?.name ?? card.setCode,
    number: card.number,
    variant: card.variant,
    rarity: field(card.rarity),
    domain: field(card.domain),
    cardType: field(card.cardType),
    energyCost: field(card.energyCost),
    might: field(card.might),
    productId: field(card.productId),
  };
}

/** Every owned card, sorted for display. */
export function exportRecords(collection: CollectionState, db: CardDatabase): ExportRecord[] {
  return exportRows(collection, db).map((row) => toExportRecord(row, db)).sort(compareRows);
}

/**
 * The card-code list: `2 OGN-007` per line.
 *
 * No header and no comment lines, deliberately. This format exists to be pasted
 * into another app, and importers vary in how forgiving they are — several
 * reject a file whose first line is not a card. Keeping the file to nothing but
 * card lines is what makes it usable everywhere, at the cost of it not being
 * self-describing. The metadata lives in the file name instead.
 *
 * Copies are written per owned printing and never merged, so the file is a
 * faithful list of what is in the collection.
 */
export function formatCardCodeList(records: readonly ExportRecord[]): string {
  if (records.length === 0) return '';
  return records.map((record) => `${record.copies} ${record.code}`).join('\n');
}

/** Quotes a CSV field when it contains a comma, quote, or newline. */
export function csvField(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Column order, mirroring the convention MythicHub and ManaBox both export.
 *
 * `Key` is carried alongside `Card Code` on purpose: a handful of promotional
 * cards share one printed number, so the code alone cannot identify a row
 * uniquely. `Key` is also what this app stores the collection under, which makes
 * a CSV a complete backup rather than only a hand-off.
 */
export const CSV_COLUMNS = [
  'Amount',
  'Name',
  'Set Code',
  'Set Name',
  'Collector Number',
  'Card Code',
  'Key',
  'Variant',
  'Printing Name',
  'Rarity',
  'Domain',
  'Card Type',
  'Energy Cost',
  'Might',
  'Product ID',
] as const;

/**
 * The CSV export.
 *
 * `Collector Number` is written zero-padded (`007`), because that is how it is
 * printed on the card and what other trackers match on when the leading zeros
 * are preserved.
 */
export function formatCsv(records: readonly ExportRecord[]): string {
  const lines: string[] = [CSV_COLUMNS.join(',')];

  for (const record of records) {
    lines.push(
      [
        String(record.copies),
        record.name,
        record.setCode,
        record.setName,
        record.number,
        record.code,
        record.key,
        record.variant,
        record.printingName,
        record.rarity,
        record.domain,
        record.cardType,
        record.energyCost,
        record.might,
        record.productId,
      ]
        .map(csvField)
        .join(','),
    );
  }

  // A trailing newline so the file ends cleanly on the last row; the empty
  // collection still emits its header, so the file is never zero bytes.
  return `${lines.join('\n')}\n`;
}

/**
 * Formats already-resolved records in the chosen format.
 *
 * Takes records rather than the collection so the caller can resolve and sort
 * the collection once and then switch formats without repeating that work —
 * which is what the export sheet does when the user toggles between the two.
 */
export function formatCollection(
  records: readonly ExportRecord[],
  format: ExportFormat,
): string {
  return format === 'csv' ? formatCsv(records) : formatCardCodeList(records);
}

/**
 * File name for an export, e.g. `riftbound-collection-2026-08-22.csv`.
 *
 * Dated because the whole point of a file export is that several of them
 * accumulate — in a share target, a downloads folder, or a backup directory —
 * and an undated name would make them indistinguishable.
 *
 * @param now Injected so the name is deterministic under test.
 */
export function exportFileName(format: ExportFormat, now: Date = new Date()): string {
  const extension = EXPORT_FORMATS.find((f) => f.format === format)?.extension ?? 'txt';
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  return `riftbound-collection-${stamp}.${extension}`;
}

/** A one-line summary for the export sheet, e.g. `12 cards · 19 copies`. */
export function describeExport(records: readonly ExportRecord[]): string {
  const unique = records.length;
  const copies = records.reduce((total, record) => total + record.copies, 0);
  const cardWord = unique === 1 ? 'card' : 'cards';
  const copyWord = copies === 1 ? 'copy' : 'copies';
  return `${unique} ${cardWord} · ${copies} ${copyWord}`;
}
