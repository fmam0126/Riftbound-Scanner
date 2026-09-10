/**
 * Tests for the scan geometry: where the collector number is on a real card, how
 * that maps into the frame, and how the OCR text that comes back is parsed.
 *
 * The card layout used here was measured from a real photo of an Origins card in
 * a top-loader (`testImage/ogn-160.jpg`), which prints its number as
 * `OGN - 160/298` at the bottom-left. That slash-separated set total is on every
 * Riftbound card, so failing to handle it breaks every scan.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

import {
  CARD_ASPECT,
  CARD_GUIDE_BOTTOM,
  NUMBER_LABEL_IN_GUIDE,
  guideForViewport,
  regionWithinGuide,
  toPixelCrop,
  type CropRegion,
} from '../src/scan/geometry.ts';
import { buildIndex, matchOcrText } from '../src/logic/match.ts';
import { parseCardId } from '../src/logic/parseOcr.ts';
import type { CardDatabase } from '../src/types.ts';

const db = JSON.parse(readFileSync('src/data/cards.json', 'utf8')) as CardDatabase;
const index = buildIndex(db);

describe('regionWithinGuide', () => {
  it('maps a full-guide region back to the guide itself', () => {
    const guide: CropRegion = { x: 0.2, y: 0.5, width: 0.6, height: 0.4 };
    const full = regionWithinGuide(guide, { x: 0, y: 0, width: 1, height: 1 });
    assert.deepStrictEqual(full, guide);
  });

  it('places a half-height bottom region in the lower half of the guide', () => {
    const guide: CropRegion = { x: 0.2, y: 0.5, width: 0.6, height: 0.4 };
    const bottom = regionWithinGuide(guide, { x: 0, y: 0.5, width: 1, height: 0.5 });
    assert.strictEqual(bottom.y, 0.7);
    assert.strictEqual(bottom.height, 0.2);
  });

  it('scales a sub-region proportionally', () => {
    const guide: CropRegion = { x: 0, y: 0, width: 0.5, height: 0.5 };
    const inner = regionWithinGuide(guide, { x: 0.1, y: 0.2, width: 0.3, height: 0.4 });
    assert.deepStrictEqual(inner, { x: 0.05, y: 0.1, width: 0.15, height: 0.2 });
  });

  it('extends slightly past the guide on the left, for tolerance', () => {
    // The set code is the first thing printed, and estimating the card's true
    // left edge from a photo is imprecise. Clipping the leading characters would
    // cost a confidence tier, so the strip deliberately overshoots to the left.
    // The crop is clamped to the image, so overshooting is free.
    assert.ok(NUMBER_LABEL_IN_GUIDE.x < 0, 'strip should overshoot the left edge');
  });

  it('stays within the guide on the right and only slightly past on the bottom', () => {
    const guide = guideForViewport(412, 915);
    const strip = regionWithinGuide(guide, { ...NUMBER_LABEL_IN_GUIDE });

    assert.ok(
      strip.x + strip.width <= guide.x + guide.width + 1e-9,
      'strip should not extend past the guide on the right',
    );
    // The bottom overshoot is intentional tolerance, but must stay small: the
    // crop is clamped to the image, so a big overshoot would just be wasted area.
    const overshoot = strip.y + strip.height - (guide.y + guide.height);
    assert.ok(overshoot >= 0, 'strip should reach the guide bottom');
    assert.ok(
      overshoot <= guide.height * 0.1,
      `bottom overshoot ${overshoot.toFixed(1)}px is more than 10% of the guide`,
    );
  });

  it('places the label strip at the bottom of the card, where the number is printed', () => {
    assert.ok(NUMBER_LABEL_IN_GUIDE.y > 0.5, 'strip should be in the lower half');
    // It must at least reach the card's bottom edge; a small overshoot is
    // intended as tolerance for how the card's bottom edge is detected.
    assert.ok(
      NUMBER_LABEL_IN_GUIDE.y + NUMBER_LABEL_IN_GUIDE.height >= 1,
      'strip should reach the card bottom',
    );
  });

  it('covers the collector label measured on the real test photo', () => {
    // Card box and label position were measured from testImage/ogn-160.jpg, a
    // photo of an Origins card in a top-loader printing `OGN - 160/298`.
    const cardBox: CropRegion = {
      x: 0.262,
      y: 0.298,
      width: 0.642 - 0.262,
      height: 0.72 - 0.298,
    };
    const label = { x0: 0.238, y0: 0.685, x1: 0.4, y1: 0.702 };

    const strip = regionWithinGuide(cardBox, { ...NUMBER_LABEL_IN_GUIDE });
    assert.ok(strip.x <= label.x0, `strip starts at ${strip.x}, label starts at ${label.x0}`);
    assert.ok(strip.y <= label.y0, `strip starts at ${strip.y}, label starts at ${label.y0}`);
    assert.ok(
      strip.x + strip.width >= label.x1,
      `strip ends at ${strip.x + strip.width}, label ends at ${label.x1}`,
    );
    assert.ok(
      strip.y + strip.height >= label.y1,
      `strip ends at ${strip.y + strip.height}, label ends at ${label.y1}`,
    );
  });
});

describe('card guide proportions', () => {
  it('uses the physical card aspect ratio', () => {
    assert.ok(CARD_ASPECT < 1, 'a card is portrait, taller than it is wide');
    assert.ok(Math.abs(CARD_ASPECT - 63 / 88) < 1e-9);
  });
});

describe('guideForViewport', () => {
  /** Portrait phones from a small budget device to a large one. */
  const VIEWPORTS: Array<[string, number, number]> = [
    ['small phone', 360, 640],
    ['pixel-ish', 412, 915],
    ['tall phone', 393, 852],
    ['tablet portrait', 800, 1280],
    ['landscape', 915, 412],
  ];

  it('produces a card-shaped rectangle on every viewport', () => {
    for (const [name, w, h] of VIEWPORTS) {
      const guide = guideForViewport(w, h);
      assert.ok(
        Math.abs(guide.width / guide.height - CARD_ASPECT) < 1e-9,
        `${name}: aspect ${(guide.width / guide.height).toFixed(3)} should be ${CARD_ASPECT.toFixed(3)}`,
      );
    }
  });

  it('keeps the guide fully inside the viewport on every device', () => {
    for (const [name, w, h] of VIEWPORTS) {
      const guide = guideForViewport(w, h);
      assert.ok(guide.x >= 0, `${name}: x=${guide.x}`);
      assert.ok(guide.y >= 0, `${name}: y=${guide.y}`);
      assert.ok(guide.x + guide.width <= w + 1e-6, `${name}: overflows width`);
      assert.ok(guide.y + guide.height <= h + 1e-6, `${name}: overflows height`);
    }
  });

  it('anchors the bottom edge so the number strip is consistently placed', () => {
    for (const [name, w, h] of VIEWPORTS) {
      const guide = guideForViewport(w, h);
      const expectedBottom = h * CARD_GUIDE_BOTTOM;
      // On landscape the guide is shrunk to fit, so only require it to be at or
      // above the anchor rather than exactly on it.
      assert.ok(
        guide.y + guide.height <= expectedBottom + 1e-6,
        `${name}: bottom ${guide.y + guide.height} exceeds anchor ${expectedBottom}`,
      );
    }
  });

  it('keeps the number strip a usable size on a small phone', () => {
    const guide = guideForViewport(360, 640);
    const strip = regionWithinGuide(
      { x: guide.x, y: guide.y, width: guide.width, height: guide.height },
      { ...NUMBER_LABEL_IN_GUIDE },
    );
    // The label is only a few millimetres tall on a real card; below ~20px of
    // source it is not reliably readable, so guard against a guide that is too
    // small to work at all.
    assert.ok(strip.height > 20, `label strip only ${strip.height.toFixed(1)}px tall`);
    assert.ok(strip.width > 60, `label strip only ${strip.width.toFixed(1)}px wide`);
  });

  it('places the number strip in the lower-left of the guide', () => {
    const guide = guideForViewport(412, 915);
    const strip = regionWithinGuide(
      { x: guide.x, y: guide.y, width: guide.width, height: guide.height },
      { ...NUMBER_LABEL_IN_GUIDE },
    );
    assert.ok(strip.x <= guide.x + guide.width * 0.1, 'strip should hug the left edge');
    assert.ok(strip.y > guide.y + guide.height * 0.7, 'strip should be near the bottom');
  });
});

describe('toPixelCrop', () => {
  it('converts fractions to pixels', () => {
    const pixels = toPixelCrop({ x: 0.5, y: 0.25, width: 0.25, height: 0.5 }, 1000, 800);
    assert.deepStrictEqual(pixels, { originX: 500, originY: 200, width: 250, height: 400 });
  });

  it('clamps a region that would extend past the image', () => {
    const pixels = toPixelCrop({ x: 0.9, y: 0.9, width: 0.5, height: 0.5 }, 1000, 1000);
    assert.ok(pixels.originX + pixels.width <= 1000);
    assert.ok(pixels.originY + pixels.height <= 1000);
  });

  it('never produces a zero-sized crop', () => {
    const pixels = toPixelCrop({ x: 1, y: 1, width: 0, height: 0 }, 100, 100);
    assert.ok(pixels.width >= 1);
    assert.ok(pixels.height >= 1);
  });
});

describe('collector numbers as printed on real cards', () => {
  it('parses the `/setTotal` form that every card carries', () => {
    const parsed = parseCardId('OGN 160/298', index.sets);
    assert.strictEqual(parsed?.setCodeRaw, 'OGN');
    assert.strictEqual(parsed?.number, '160');
  });

  it('parses the real card from the test photo', () => {
    // The photo reads `OGN - 160/298`, with spaces around the hyphen.
    const result = matchOcrText(index, 'OGN - 160/298');
    assert.strictEqual(result.kind, 'exact');
    assert.strictEqual(result.best?.card.key, 'OGN-160');
  });

  it('ignores a set total that does not match the card set', () => {
    // The denominator is the set size, not part of the identifier, so a wrong
    // one must not prevent the match.
    const result = matchOcrText(index, 'OGN 010/166');
    assert.strictEqual(result.best?.card.key, 'OGN-010');
  });

  it('handles the alternate separators OCR produces', () => {
    for (const text of [
      'OGN-160/298',
      'OGN 160/298',
      'OGN - 160/298',
      'OGN – 160/298',
      'OGN — 160/298',
      'ogn 160/298',
    ]) {
      const result = matchOcrText(index, text);
      assert.strictEqual(result.best?.card.key, 'OGN-160', `failed for ${JSON.stringify(text)}`);
    }
  });

  it('tolerates OCR noise in the set total', () => {
    // The denominator is frequently misread; it must not invalidate the read.
    const result = matchOcrText(index, 'OGN 160/29B');
    assert.strictEqual(result.best?.card.key, 'OGN-160');
  });

  it('still corrects glyph confusions alongside the set total', () => {
    const result = matchOcrText(index, '0GN - 1GO/298');
    assert.strictEqual(result.best?.card.key, 'OGN-160');
  });

  it('parses the number when the set code and number are split across lines', () => {
    const result = matchOcrText(index, 'OGN\n160/298');
    assert.strictEqual(result.best?.card.key, 'OGN-160');
  });

  it('finds the identifier inside surrounding card text', () => {
    const noisy = [
      'Six More Vodka',
      'OGN - 160/298',
      '在你的回合即将结束时',
    ].join('\n');
    const result = matchOcrText(index, noisy);
    assert.strictEqual(result.best?.card.key, 'OGN-160');
  });

  it('still rejects a number that is not a card', () => {
    const result = matchOcrText(index, 'OGN 998/298');
    assert.strictEqual(result.kind, 'none');
  });
});
