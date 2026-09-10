/**
 * On-device OCR for Riftbound card numbers.
 *
 * Everything here runs locally: the camera frame is cropped to the strip where
 * the collector number is printed, Google ML Kit reads the text, and the result
 * is handed to the pure matcher. No image or text ever leaves the device, which
 * is why the app needs no network permission beyond the optional card-data
 * refresh.
 *
 * Accuracy comes from cropping rather than from a better OCR model. Full-frame
 * OCR on a card returns the name, rules text, flavour text and type line, and
 * the collector number is a small part of that noise. Cropping to the bottom
 * strip removes almost all of it before ML Kit ever sees the image.
 */

import TextRecognition from '@react-native-ml-kit/text-recognition';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';

import type { CardDatabase, MatchResult } from '../types.ts';
import { buildIndex, matchOcrText, type CardIndex } from '../logic/match.ts';
import {
  NUMBER_LABEL_IN_GUIDE,
  WHOLE_CARD_IN_GUIDE,
  guideForViewport,
  regionWithinGuide,
  toPixelCrop,
  type CropRegion,
} from './geometry.ts';

// Re-exported so screens and tests can reach the geometry from one place.
export {
  CARD_ASPECT,
  CARD_GUIDE_BOTTOM,
  CARD_GUIDE_HEIGHT_FRACTION,
  NUMBER_LABEL_IN_GUIDE,
  WHOLE_CARD_IN_GUIDE,
  guideForViewport,
  regionWithinGuide,
  toPixelCrop,
} from './geometry.ts';
export type { CropRegion } from './geometry.ts';

/**
 * How the collector number was located. Reported to the UI so a failing scan can
 * be diagnosed without guessing.
 */
export type ScanPass = 'label' | 'card' | 'frame';

export interface OcrOutcome {
  /** Raw text ML Kit returned, kept for the debug view and for retries. */
  text: string;
  /** Which pass produced the text. */
  pass: ScanPass;
  /** Every pass that was attempted, in order, with what it read. */
  attempts: Array<{ pass: ScanPass; text: string; kind: MatchResult['kind'] }>;
  /** The match produced by the pure matcher. */
  match: MatchResult;
  /** Milliseconds spent, useful when tuning. */
  durationMs: number;
}

export interface ScanOptions {
  /**
   * Where the user has the card guide in the preview. Defaults to the standard
   * layout; the screen passes its measured rectangle so the crop follows the
   * outline the user actually sees.
   */
  guide?: CropRegion;
  /**
   * Try the whole card, then the uncropped frame, when the label strip yields
   * nothing. Each fallback costs an OCR pass, so they only run on failure.
   */
  fallbacks?: boolean;
}

/** Crops an image to a fractional region and returns the new local URI. */
export async function cropImage(
  uri: string,
  crop: CropRegion,
  imageSize: { width: number; height: number },
): Promise<string> {
  const pixels = toPixelCrop(crop, imageSize.width, imageSize.height);
  const result = await manipulateAsync(uri, [{ crop: pixels }], {
    // PNG is lossless, which matters here: JPEG artefacts around small
    // high-contrast digits are exactly what confuses OCR.
    format: SaveFormat.PNG,
    compress: 1,
  });
  return result.uri;
}

/**
 * Runs ML Kit text recognition over a local image file.
 *
 * Returns the block text. Word-level bounding boxes are available from ML Kit
 * but are not used: cropping already isolates the number, and the pure matcher
 * handles the remaining noise without needing geometry.
 */
export async function recogniseText(uri: string): Promise<string> {
  const result = await TextRecognition.recognize(uri);
  return result.text ?? '';
}

/**
 * Scans a captured photo and returns a card match.
 *
 * The user frames the whole card once; the app then finds the collector number
 * on its own, so there is no need to aim at the bottom corner of the card. Passes
 * run in order of decreasing precision and increasing cost, stopping at the first
 * usable result:
 *
 *   1. `label` — the bottom-left strip of the card, where the number is printed.
 *      Cleanest input, so it is tried first and is usually the only pass needed.
 *   2. `card` — the whole card. Recovers a blurred or glared label by giving the
 *      matcher the card name as well.
 *   3. `frame` — the uncropped photo. Last resort when the guide was misaligned.
 *
 * A pass is accepted when it produces a confident match, or when it produces any
 * match and no later pass does better. Without that second rule a blurry exact
 * read of the label would be discarded in favour of a worse guess from the
 * noisier whole-card pass.
 */
export async function scanPhoto(
  index: CardIndex,
  photo: { uri: string; width: number; height: number },
  options: ScanOptions = {},
): Promise<OcrOutcome> {
  const started = Date.now();
  const guide: CropRegion = options.guide ?? guideForViewport(photo.width, photo.height);
  const useFallbacks = options.fallbacks ?? true;

  const labelRegion = regionWithinGuide(guide, { ...NUMBER_LABEL_IN_GUIDE });
  const cardRegion = regionWithinGuide(guide, { ...WHOLE_CARD_IN_GUIDE });

  const passes: Array<{ pass: ScanPass; crop: CropRegion | null }> = [{ pass: 'label', crop: labelRegion }];
  if (useFallbacks) {
    passes.push({ pass: 'card', crop: cardRegion });
    passes.push({ pass: 'frame', crop: null });
  }

  const attempts: OcrOutcome['attempts'] = [];
  let best: { text: string; pass: ScanPass; match: MatchResult } | null = null;

  for (const step of passes) {
    let text = '';
    try {
      if (step.crop === null) {
        text = await recogniseText(photo.uri);
      } else {
        const croppedUri = await cropImage(photo.uri, step.crop, photo);
        text = await recogniseText(croppedUri);
      }
    } catch (error) {
      // Cropping is an optimisation; a failure here should degrade to the next
      // pass rather than fail the whole scan.
      console.warn(`OCR pass "${step.pass}" failed:`, error);
      text = '';
    }

    const match = matchOcrText(index, text);
    attempts.push({ pass: step.pass, text, kind: match.kind });

    const confident = match.kind === 'exact' || match.kind === 'ambiguous';
    if (match.kind !== 'none' && best === null) {
      best = { text, pass: step.pass, match };
    }
    if (confident && match.best !== null) {
      return { text, pass: step.pass, attempts, match, durationMs: Date.now() - started };
    }
  }

  if (best !== null) {
    return {
      text: best.text,
      pass: best.pass,
      attempts,
      match: best.match,
      durationMs: Date.now() - started,
    };
  }

  // Nothing matched anywhere; report the label pass's text, since that is the
  // input the user can most easily fix by adjusting the card.
  const labelAttempt = attempts.find((a) => a.pass === 'label');
  return {
    text: labelAttempt?.text ?? '',
    pass: 'label',
    attempts,
    match: matchOcrText(index, labelAttempt?.text ?? ''),
    durationMs: Date.now() - started,
  };
}

/** A ready-to-use scanner bound to a card database. */
export interface Scanner {
  index: CardIndex;
  scan: (
    photo: { uri: string; width: number; height: number },
    options?: ScanOptions,
  ) => Promise<OcrOutcome>;
}

/** Builds the matcher index once from the bundled database. */
export function createScanner(db: CardDatabase): Scanner {
  const index = buildIndex(db);
  return {
    index,
    scan: (photo, options) => scanPhoto(index, photo, options),
  };
}
