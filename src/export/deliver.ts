/**
 * Getting an export off the device.
 *
 * Three routes, because they answer different needs:
 *
 *  - **Copy** puts the text on the clipboard, which is the fast path for pasting
 *    a card list into a tracker's import box.
 *  - **Share** writes the file and hands it to the OS share sheet, so it can go
 *    straight into a mail, a chat, or another app.
 *  - **Save** writes the file to a folder the user picks. On Android that is the
 *    Storage Access Framework; on iOS the document picker.
 *
 * The routing itself lives here rather than in the screen so the screen holds no
 * branch on `Platform.OS`, and so the two platform file pickers cannot drift
 * apart in behaviour.
 *
 * This module touches native APIs, so it is deliberately *not* imported by any
 * test — the formatting it writes is tested purely in `logic/exportCollection.ts`.
 */

import * as Clipboard from 'expo-clipboard';
import { File, Paths } from 'expo-file-system';
import { StorageAccessFramework, writeAsStringAsync } from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

/**
 * Where an export ended up, so the caller can word its confirmation honestly.
 *
 * `saved` and `shared` are reported separately because they leave the file in
 * very different places, and a user who chose "save" needs the folder, not
 * "shared".
 */
export type DeliveryOutcome =
  | { kind: 'copied' }
  | { kind: 'shared' }
  | { kind: 'saved'; location: string }
  /** The user backed out of a system picker. Not an error. */
  | { kind: 'cancelled' };

/** True when the platform cancelled a picker rather than failing. */
function isCancellation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /cancel/i.test(message);
}

/**
 * Writes the export to a file in the app's cache directory and returns it.
 *
 * The cache directory is right for a file that is about to leave the app: the OS
 * may reclaim it later, which is exactly what should happen to an export that
 * has been shared. A file the user chose to *save* is copied out to real storage
 * by {@link saveExport} instead.
 *
 * `create({ overwrite: true })` matters because the file name is dated to the
 * day: sharing twice in one day must not fail on the second attempt.
 */
function writeToCache(fileName: string, contents: string): File {
  const file = new File(Paths.cache, fileName);
  file.create({ overwrite: true });
  file.write(contents);
  return file;
}

/** Copies the export text to the clipboard. */
export async function copyExport(contents: string): Promise<DeliveryOutcome> {
  await Clipboard.setStringAsync(contents);
  return { kind: 'copied' };
}

/**
 * Writes the export into the app's own documents directory.
 *
 * This is the iOS save target. `Paths.document` is the app sandbox, surfaced in
 * the Files app under the app's name, which is where a user can reliably find a
 * file again.
 */
async function writeDocumentAsync(fileName: string, contents: string): Promise<void> {
  const directory = Paths.document.uri;
  if (directory === null || directory === undefined) {
    throw new Error('This device has no documents directory to save into.');
  }
  // A plain string join rather than `new File(Paths.document, ...)` because the
  // legacy writer is the API that handles a `file://` URI on every platform.
  const separator = directory.endsWith('/') ? '' : '/';
  await writeAsStringAsync(`${directory}${separator}${fileName}`, contents);
}

/**
 * Offers the export through the OS share sheet.
 *
 * Sharing a *file* rather than a bare string is deliberate: it is what makes the
 * result arrive as an attachment with a sensible name and extension, which is
 * what a tracking site's file upload expects.
 */
export async function shareExport(
  fileName: string,
  contents: string,
  mimeType: string,
): Promise<DeliveryOutcome> {
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error(
      'Sharing is not available on this device. Use Copy or Save instead.',
    );
  }
  const file = writeToCache(fileName, contents);
  await Sharing.shareAsync(file.uri, {
    mimeType,
    UTI: mimeType === 'text/csv' ? 'public.comma-separated-values-text' : 'public.plain-text',
    dialogTitle: 'Export Riftbound collection',
  });
  return { kind: 'shared' };
}

/**
 * Writes the export to a folder the user picks.
 *
 * Android and iOS are handled separately because the platforms genuinely differ.
 * Android has no filesystem-wide write access, so the Storage Access Framework
 * is used to create the file inside a directory the user grants. iOS apps are
 * sandboxed to their own documents directory, which the Files app exposes as the
 * app's folder, so the export is written straight there.
 *
 * A cancelled picker returns `cancelled` rather than throwing — backing out of a
 * folder chooser is a normal thing to do, not a failure.
 */
export async function saveExport(
  fileName: string,
  contents: string,
  mimeType: string,
): Promise<DeliveryOutcome> {
  try {
    if (Platform.OS === 'ios') {
      await writeDocumentAsync(fileName, contents);
      return { kind: 'saved', location: 'Files › On My iPhone › Riftbound Scanner' };
    }

    if (Platform.OS === 'android') {
      const permission =
        await StorageAccessFramework.requestDirectoryPermissionsAsync();
      if (!permission.granted) return { kind: 'cancelled' };

      const destination = await StorageAccessFramework.createFileAsync(
        permission.directoryUri,
        fileName,
        mimeType,
      );
      await StorageAccessFramework.writeAsStringAsync(destination, contents);

      // The granted directory URI is opaque, so the user is told what they did
      // rather than being shown it.
      return { kind: 'saved', location: 'the folder you chose' };
    }

    // Web: no filesystem, so the share sheet/download is the only route out.
    return await shareExport(fileName, contents, mimeType);
  } catch (error) {
    if (isCancellation(error)) return { kind: 'cancelled' };
    throw error;
  }
}
