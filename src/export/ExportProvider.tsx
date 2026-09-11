/**
 * The export session: formatting what the user owns, and getting it off the
 * device.
 *
 * This lives behind a provider rather than inside `CollectionScreen` because two
 * separate places start an export — the button in the collection header and the
 * tab bar button — and both must open the *same* sheet. Routing them through one
 * piece of state is what keeps a tab-bar export from rendering a second copy of
 * the sheet over the first.
 *
 * The provider also decides what the delivery actions mean. `deliver.ts` knows
 * how to reach the clipboard, the share sheet and the filesystem, but not how a
 * result should be worded; that mapping lives here so the sheet is purely
 * presentational.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import {
  describeExport,
  exportFileName,
  exportRecords,
  formatCollection,
  type ExportFormat,
  type ExportRecord,
} from '../logic/exportCollection.ts';
import { getDatabase } from '../data/cards.ts';
import { useCollection } from '../state/CollectionProvider.tsx';
import {
  copyExport,
  saveExport,
  shareExport,
  type DeliveryOutcome,
} from './deliver.ts';

/** MIME type per format, used for the shared file and the save dialog. */
const MIME_TYPES: Record<ExportFormat, string> = {
  text: 'text/plain',
  csv: 'text/csv',
};

/** Every delivery route the sheet offers. */
export type ExportAction = 'copy' | 'share' | 'save';

export interface ExportSession {
  open: boolean;
  format: ExportFormat;
  setFormat: (format: ExportFormat) => void;
  /** Formatted contents for the current format, or '' when nothing is owned. */
  contents: string;
  records: readonly ExportRecord[];
  /** e.g. `12 cards · 19 copies`, or a prompt when the collection is empty. */
  summary: string;
  fileName: string;
  /** True while one of the delivery routes is in flight. */
  busy: boolean;
  /** What to tell the user about the last delivery, or null before one ran. */
  message: string | null;
  /** Set when the last delivery failed, for styling the message as a warning. */
  failed: boolean;
  start: () => void;
  close: () => void;
  run: (action: ExportAction) => Promise<void>;
}

const ExportContext = createContext<ExportSession | null>(null);

/** The line shown under the buttons for each way a delivery can end. */
function describeOutcome(outcome: DeliveryOutcome): string {
  switch (outcome.kind) {
    case 'copied':
      return 'Copied to the clipboard.';
    case 'shared':
      return 'Opened the share sheet.';
    case 'saved':
      return `Saved to ${outcome.location}.`;
    case 'cancelled':
      return 'Cancelled — nothing was saved.';
  }
}

export function ExportProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const { collection, loading } = useCollection();
  const db = getDatabase();

  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<ExportFormat>('text');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // Recomputed when the collection or the database changes rather than on every
  // render, so toggling the format does not re-resolve 1400 cards.
  const records = useMemo(() => exportRecords(collection, db), [collection, db]);

  const contents = useMemo(() => formatCollection(records, format), [records, format]);

  const summary = useMemo(
    () =>
      loading
        ? 'Loading your collection…'
        : records.length === 0
          ? 'Nothing to export yet — scan a card first.'
          : describeExport(records),
    [loading, records],
  );

  const fileName = useMemo(() => exportFileName(format), [format]);

  const start = useCallback(() => {
    // A stale message from a previous export would look like the result of this
    // one, so the sheet always opens clean.
    setMessage(null);
    setFailed(false);
    setOpen(true);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setMessage(null);
    setFailed(false);
  }, []);

  const run = useCallback(
    async (action: ExportAction) => {
      if (contents.length === 0) return;

      setBusy(true);
      setFailed(false);
      try {
        const mimeType = MIME_TYPES[format];

        const outcome =
          action === 'copy'
            ? await copyExport(contents)
            : action === 'share'
              ? await shareExport(fileName, contents, mimeType)
              : await saveExport(fileName, contents, mimeType);

        setMessage(describeOutcome(outcome));
        // A cancelled picker is not a failure, but it is also not a success, so
        // the sheet stays open with the message rather than closing the user out.
        if (outcome.kind !== 'cancelled') setOpen(false);
      } catch (error) {
        setFailed(true);
        setMessage(error instanceof Error ? error.message : 'Export failed.');
      } finally {
        setBusy(false);
      }
    },
    [contents, fileName, format],
  );

  const value = useMemo<ExportSession>(
    () => ({
      open,
      format,
      setFormat,
      contents,
      records,
      summary,
      fileName,
      busy,
      message,
      failed,
      start,
      close,
      run,
    }),
    [open, format, contents, records, summary, fileName, busy, message, failed, start, close, run],
  );

  return <ExportContext.Provider value={value}>{children}</ExportContext.Provider>;
}

export function useExportSession(): ExportSession {
  const value = useContext(ExportContext);
  if (value === null) {
    throw new Error('useExportSession must be used inside an ExportProvider');
  }
  return value;
}
