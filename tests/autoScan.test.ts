/**
 * Tests for the auto-scan repeat rule.
 *
 * The scanner runs on a timer, so a card held under the camera is resolved on
 * every tick. Without a repeat rule that would add the same card several times a
 * second, which is the whole reason the rule exists.
 *
 * The window is measured in **cards**, not seconds: a card counts as a repeat if
 * it is one of the last few cards seen. That is what lets the user scan several
 * copies of the same card by showing one other card in between, while still
 * suppressing a card that is simply sitting under the camera.
 *
 * `isDuplicateSighting` and `recordSighting` are pure, so this policy is pinned
 * here rather than only being observable by running the app against a camera.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AUTO_SCAN_INTERVAL_MS,
  DUPLICATE_HISTORY_SIZE,
  isDuplicateSighting,
  recordSighting,
} from '../src/scan/useAutoScan.ts';

const OGN_160 = 'OGN-160';
const OGN_161 = 'OGN-161';
const OGN_162 = 'OGN-162';
const OGN_163 = 'OGN-163';
const OGN_164 = 'OGN-164';

/** Feeds sightings through the same pair of functions the hook uses. */
function scanSequence(keys: string[], historySize = DUPLICATE_HISTORY_SIZE) {
  let recent: string[] = [];
  const added: string[] = [];
  const duplicates: string[] = [];

  for (const key of keys) {
    if (isDuplicateSighting(recent, key)) duplicates.push(key);
    else added.push(key);
    recent = recordSighting(recent, key, historySize);
  }

  return { added, duplicates, recent };
}

describe('isDuplicateSighting', () => {
  it('is not a repeat when nothing has been seen', () => {
    assert.strictEqual(isDuplicateSighting([], OGN_160), false);
  });

  it('is a repeat when the same card is in the window', () => {
    assert.strictEqual(isDuplicateSighting([OGN_160], OGN_160), true);
  });

  it('is not a repeat for a card outside the window', () => {
    assert.strictEqual(isDuplicateSighting([OGN_161, OGN_162], OGN_160), false);
  });
});

describe('recordSighting', () => {
  it('appends a new card', () => {
    assert.deepStrictEqual(recordSighting([], OGN_160), [OGN_160]);
  });

  it('keeps at most the history size, dropping the oldest', () => {
    let recent: string[] = [];
    for (const key of [OGN_160, OGN_161, OGN_162, OGN_163]) {
      recent = recordSighting(recent, key);
    }
    assert.strictEqual(recent.length, DUPLICATE_HISTORY_SIZE);
    assert.deepStrictEqual(recent, [OGN_161, OGN_162, OGN_163]);
    assert.ok(!recent.includes(OGN_160), 'oldest should have been dropped');
  });

  it('keeps a repeated card where it is rather than refreshing it', () => {
    // Keeping its place is what makes the window advance on *other* cards
    // rather than on ticks. If a repeat refreshed the entry, a card sitting
    // under the camera would never leave the window — which is correct — but a
    // card flickering between two readings would also block itself forever.
    let recent = recordSighting([], OGN_160);
    recent = recordSighting(recent, OGN_161);
    recent = recordSighting(recent, OGN_160);
    assert.deepStrictEqual(recent, [OGN_160, OGN_161]);
  });

  it('does not mutate the array it is given', () => {
    const original = [OGN_160];
    const next = recordSighting(original, OGN_161);
    assert.deepStrictEqual(original, [OGN_160], 'input should be untouched');
    assert.deepStrictEqual(next, [OGN_160, OGN_161]);
  });
});

describe('a card resting under the camera', () => {
  it('is added once and reported as a repeat on every later tick', () => {
    const ticks = Array.from({ length: 10 }, () => OGN_160);
    const { added, duplicates } = scanSequence(ticks);

    assert.deepStrictEqual(added, [OGN_160], 'should be counted exactly once');
    assert.strictEqual(duplicates.length, 9);
  });

  it('stays suppressed for two minutes of continuous scanning', () => {
    const ticks = Array.from({ length: 66 }, () => OGN_160);
    const { added } = scanSequence(ticks);
    assert.strictEqual(added.length, 1, `card was counted ${added.length} times`);
  });
});

describe('scanning multiple copies of the same card', () => {
  it('allows a second copy once the card leaves the window', () => {
    // This is the case the previous rule got wrong: owning a card must not stop
    // you scanning another copy of it. With a window of 3, three other cards
    // must be shown in between.
    const { added } = scanSequence([
      OGN_160,
      OGN_161,
      OGN_162,
      OGN_163,
      OGN_160,
    ]);
    assert.deepStrictEqual(added, [OGN_160, OGN_161, OGN_162, OGN_163, OGN_160]);
  });

  it('allows a third copy after the window advances again', () => {
    const { added } = scanSequence([
      OGN_160,
      OGN_161,
      OGN_162,
      OGN_163,
      OGN_160,
      OGN_161,
      OGN_162,
      OGN_163,
      OGN_160,
    ]);
    assert.strictEqual(added.filter((key) => key === OGN_160).length, 3);
  });

  it('blocks a copy while the card is still inside the window', () => {
    const { added } = scanSequence([
      OGN_160,
      OGN_161,
      OGN_160, // still within the last 3 distinct cards -> blocked
      OGN_162,
      OGN_160, // still within the window -> blocked
      OGN_163,
      OGN_160, // pushed out by OGN_161..163 -> counted
    ]);
    assert.deepStrictEqual(added, [OGN_160, OGN_161, OGN_162, OGN_163, OGN_160]);
  });

  it('does not count a second copy merely because the card was briefly replaced', () => {
    // A card being swapped out and back in within the window is not a new copy.
    const { added } = scanSequence([OGN_160, OGN_161, OGN_160]);
    assert.deepStrictEqual(added, [OGN_160, OGN_161]);
  });
});

describe('scanning a mixed stack', () => {
  it('counts each distinct card once when no card repeats immediately', () => {
    const keys = [OGN_160, OGN_161, OGN_162, OGN_163, OGN_164];
    const { added, duplicates } = scanSequence(keys);
    assert.deepStrictEqual(added, keys);
    assert.deepStrictEqual(duplicates, []);
  });

  it('suppresses a card that flickers back within the window', () => {
    // A camera may alternate between two readings of the same physical card.
    const { added } = scanSequence([OGN_160, OGN_161, OGN_160, OGN_161]);
    assert.deepStrictEqual(added, [OGN_160, OGN_161]);
  });
});

describe('timing constants', () => {
  it('scans often enough to feel automatic', () => {
    assert.ok(AUTO_SCAN_INTERVAL_MS >= 800, 'interval too short to let OCR finish');
    assert.ok(AUTO_SCAN_INTERVAL_MS <= 3000, 'interval too slow to feel automatic');
  });

  it('uses a small repeat window', () => {
    assert.ok(DUPLICATE_HISTORY_SIZE >= 2, 'a window of 1 would re-add a card between ticks');
    assert.ok(DUPLICATE_HISTORY_SIZE <= 5, 'a large window makes repeat scans tedious');
  });
});
