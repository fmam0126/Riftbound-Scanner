/**
 * Pure scan geometry: where the collector number sits on a Riftbound card, and
 * how that maps into the camera frame.
 *
 * Kept free of React Native and native-module imports so it can be unit tested
 * directly. `src/scan/ocr.ts` owns the actual cropping and OCR and imports these
 * helpers.
 */

/** A region of an image, as fractions of its width and height. */
export interface CropRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Physical trading-card proportions (63mm x 88mm).
 *
 * The guide outline is drawn at this ratio because the label region is taken as
 * a fraction of the guide — a differently-proportioned guide would crop the
 * wrong band of the card.
 */
export const CARD_ASPECT = 63 / 88;

/**
 * Default card guide shape: how tall it is relative to the frame, and where its
 * bottom edge sits. Both are fractions of the frame's **height**.
 *
 * Height is the right axis to anchor on because a portrait phone frame is always
 * comfortably taller than a card, whereas a card's *width* as a fraction of the
 * frame varies a lot between devices. Deriving the width from the card's aspect
 * ratio keeps the outline card-shaped on every screen.
 *
 * This is the single source of truth for the guide; use
 * {@link guideForViewport} to turn it into pixels.
 */
export const CARD_GUIDE_HEIGHT_FRACTION = 0.46;
export const CARD_GUIDE_BOTTOM = 0.8;

/**
 * The collector-number label, expressed relative to the card guide.
 *
 * Riftbound prints it in the very bottom-left of the card face, beneath the
 * rules text. Measured against a real photo of an Origins card in a top-loader
 * (`testImage/ogn-160.jpg`), which prints `OGN - 160/298` there.
 *
 * The left edge is deliberately pulled slightly *outside* the guide. Estimating
 * the card's true left edge from a photo is imprecise, and clipping the leading
 * characters of the set code (`0GN` instead of `OGN`) costs a whole confidence
 * tier. The crop is clamped to the image, so overshooting to the left is free.
 */
export const NUMBER_LABEL_IN_GUIDE = {
  x: -0.08,
  y: 0.84,
  width: 0.74,
  height: 0.2,
} as const;

/**
 * The whole card guide, used as a recovery pass.
 *
 * If reading the label strip fails, OCR-ing the entire card also gives the
 * matcher the card's *name*, which is far more text to work with and survives
 * the label being blurred, glared, or cropped off.
 */
export const WHOLE_CARD_IN_GUIDE = {
  x: 0,
  y: 0,
  width: 1,
  height: 1,
} as const;

/** Combines a region expressed relative to the guide into frame fractions. */
export function regionWithinGuide(guide: CropRegion, region: CropRegion): CropRegion {
  return {
    x: guide.x + region.x * guide.width,
    y: guide.y + region.y * guide.height,
    width: region.width * guide.width,
    height: region.height * guide.height,
  };
}

/**
 * Builds the guide rectangle for an actual viewport, in layout pixels.
 *
 * The height comes from {@link CARD_GUIDE_HEIGHT_FRACTION} and the width follows
 * from the card's aspect ratio, so the outline stays card-shaped on any screen.
 * The bottom edge is anchored to {@link CARD_GUIDE_BOTTOM}, which keeps the
 * collector-number strip at a predictable place for the crop.
 *
 * Degrades safely on an unusually short or wide window (landscape, split screen):
 * the guide is shrunk to fit rather than overflowing the frame.
 */
export function guideForViewport(
  viewWidth: number,
  viewHeight: number,
  options: { heightFraction?: number; bottomFraction?: number } = {},
): CropRegion {
  const heightFraction = options.heightFraction ?? CARD_GUIDE_HEIGHT_FRACTION;
  const bottomFraction = options.bottomFraction ?? CARD_GUIDE_BOTTOM;

  let height = viewHeight * heightFraction;
  let width = height * CARD_ASPECT;

  // Keep the outline inside the frame horizontally.
  const maxWidth = viewWidth * 0.92;
  if (width > maxWidth) {
    width = maxWidth;
    height = width / CARD_ASPECT;
  }

  // ...and vertically, so it never runs off the top.
  const bottom = viewHeight * bottomFraction;
  if (height > bottom) {
    height = bottom * 0.96;
    width = height * CARD_ASPECT;
  }

  return {
    x: (viewWidth - width) / 2,
    y: bottom - height,
    width,
    height,
  };
}

/**
 * Converts a fractional crop region into pixel coordinates.
 *
 * Clamped so the crop can never extend past the image, which some native
 * implementations treat as an error, and never collapses to zero size.
 */
export function toPixelCrop(
  crop: CropRegion,
  width: number,
  height: number,
): { originX: number; originY: number; width: number; height: number } {
  const originX = Math.max(0, Math.round(crop.x * width));
  const originY = Math.max(0, Math.round(crop.y * height));
  const cropWidth = Math.max(1, Math.min(Math.round(crop.width * width), width - originX));
  const cropHeight = Math.max(1, Math.min(Math.round(crop.height * height), height - originY));
  return { originX, originY, width: cropWidth, height: cropHeight };
}
