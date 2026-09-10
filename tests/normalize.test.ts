/**
 * Unit tests for the OCR normalisation helpers.
 *
 * These cover the character-confusion model that the whole matcher depends on.
 *
 * Run with `npm test`, which uses Node's built-in test runner. No bundler or
 * transform step is involved: Node 24 strips the TypeScript types itself.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  alphanumeric,
  confusionClass,
  isConfusable,
  isConfusionEquivalent,
  normalizeName,
  numberOf,
  numberDistance,
  repairByShape,
  weightedDistance,
  weightedSimilarity,
} from '../src/logic/normalize.ts';

describe('isConfusable', () => {
  it('treats identical characters as confusable', () => {
    assert.strictEqual(isConfusable('O', 'O'), true);
    assert.strictEqual(isConfusable('5', '5'), true);
  });

  it('treats the classic OCR glyph pairs as confusable', () => {
    assert.strictEqual(isConfusable('0', 'O'), true);
    assert.strictEqual(isConfusable('O', '0'), true);
    assert.strictEqual(isConfusable('1', 'I'), true);
    assert.strictEqual(isConfusable('1', 'L'), true);
    assert.strictEqual(isConfusable('5', 'S'), true);
    assert.strictEqual(isConfusable('8', 'B'), true);
    assert.strictEqual(isConfusable('2', 'Z'), true);
    assert.strictEqual(isConfusable('6', 'G'), true);
    assert.strictEqual(isConfusable('7', 'T'), true);
    assert.strictEqual(isConfusable('4', 'A'), true);
  });

  it('is case insensitive', () => {
    assert.strictEqual(isConfusable('o', '0'), true);
    assert.strictEqual(isConfusable('s', '5'), true);
  });

  it('does not confuse unrelated characters', () => {
    assert.strictEqual(isConfusable('O', 'X'), false);
    assert.strictEqual(isConfusable('5', '7'), false);
    assert.strictEqual(isConfusable('A', 'B'), false);
  });
});

describe('confusionClass', () => {
  it('maps characters to a stable representative', () => {
    assert.strictEqual(confusionClass('O'), confusionClass('0'));
    assert.strictEqual(confusionClass('I'), confusionClass('1'));
    assert.strictEqual(confusionClass('S'), confusionClass('5'));
  });

  it('maps unknown characters to themselves, uppercased', () => {
    assert.strictEqual(confusionClass('x'), 'X');
    assert.strictEqual(confusionClass('7'), '7');
  });
});

describe('weightedDistance', () => {
  it('is zero for identical strings', () => {
    assert.strictEqual(weightedDistance('OGN', 'OGN'), 0);
  });

  it('is case insensitive', () => {
    assert.strictEqual(weightedDistance('ogn', 'OGN'), 0);
  });

  it('charges less for a confusion than for a real substitution', () => {
    const confusion = weightedDistance('0GN', 'OGN');
    const substitution = weightedDistance('XGN', 'OGN');
    assert.ok(confusion < substitution);
    assert.ok(confusion > 0);
  });

  it('scales with the number of wrong characters', () => {
    assert.ok(weightedDistance('XXX', 'OGN') > weightedDistance('XXN', 'OGN'));
  });

  it('handles empty strings', () => {
    assert.strictEqual(weightedDistance('', 'OGN'), 3);
    assert.strictEqual(weightedDistance('OGN', ''), 3);
    assert.strictEqual(weightedDistance('', ''), 0);
  });
});

describe('weightedSimilarity', () => {
  it('returns 1 for equal strings and 0 for wholly different ones', () => {
    assert.strictEqual(weightedSimilarity('OGN', 'OGN'), 1);
    assert.strictEqual(weightedSimilarity('OGN', 'XYZ'), 0);
  });

  it('scores a single confusion well above an unrelated substitution', () => {
    // A confusion costs 0.3 of a 3-character string, so ~0.9; a real
    // substitution costs a full 1.0, giving ~0.67.
    assert.ok(weightedSimilarity('0GN', 'OGN') > weightedSimilarity('XGN', 'OGN'));
    assert.ok(weightedSimilarity('0GN', 'OGN') > 0.85);
  });
});

describe('isConfusionEquivalent', () => {
  it('accepts strings differing only by confusions', () => {
    assert.strictEqual(isConfusionEquivalent('0GN', 'OGN'), true);
    assert.strictEqual(isConfusionEquivalent('O1O', '010'), true);
    assert.strictEqual(isConfusionEquivalent('SFD', '5FD'), true);
  });

  it('rejects different lengths and real differences', () => {
    assert.strictEqual(isConfusionEquivalent('OGN', 'OGNX'), false);
    assert.strictEqual(isConfusionEquivalent('0GN', 'SFI'), false);
    assert.strictEqual(isConfusionEquivalent('ABC', 'XYZ'), false);
  });
});

describe('repairByShape', () => {
  it('snaps digit positions to letters', () => {
    assert.strictEqual(repairByShape('0GN', 'AAA'), 'OGN');
    assert.strictEqual(repairByShape('5FD', 'AAA'), 'SFD');
    assert.strictEqual(repairByShape('1GN', 'AAA'), 'IGN');
  });

  it('snaps letter positions to digits', () => {
    assert.strictEqual(repairByShape('O1O', '999'), '010');
    assert.strictEqual(repairByShape('SZS', '999'), '525');
    assert.strictEqual(repairByShape('BGT', '999'), '867');
  });

  it('handles a mixed shape', () => {
    assert.strictEqual(repairByShape('TOI', 'A99'), 'T01');
  });

  it('leaves already-correct characters alone', () => {
    assert.strictEqual(repairByShape('010', '999'), '010');
    assert.strictEqual(repairByShape('OGN', 'AAA'), 'OGN');
  });

  it('repeats the final shape class when the token is longer', () => {
    assert.strictEqual(repairByShape('OOO', '9'), '000');
  });
});

describe('alphanumeric', () => {
  it('strips punctuation and uppercases', () => {
    assert.strictEqual(alphanumeric('ogn-010'), 'OGN010');
    assert.strictEqual(alphanumeric('0GN 010a'), '0GN010A');
  });

  it('removes whitespace and symbols', () => {
    assert.strictEqual(alphanumeric(' OGN / 010 '), 'OGN010');
  });
});

describe('normalizeName', () => {
  it('lowercases and collapses punctuation', () => {
    assert.strictEqual(normalizeName('Legion Rearguard'), 'legion rearguard');
    assert.strictEqual(normalizeName('Get Excited!'), 'get excited');
    assert.strictEqual(normalizeName('Spirit\u2019s Refuge'), 'spirit s refuge');
  });

  it('drops TCGplayer printing qualifiers', () => {
    assert.strictEqual(normalizeName('Fury Rune (Alternate Art)'), 'fury rune');
    assert.strictEqual(normalizeName('Ahri, Alluring (Alternate Art)'), 'ahri alluring');
    assert.strictEqual(normalizeName('Ahri, Alluring'), 'ahri alluring');
  });
});

describe('numberOf', () => {
  it('parses numbers ignoring leading zeros', () => {
    assert.strictEqual(numberOf('010'), 10);
    assert.strictEqual(numberOf('10'), 10);
    assert.strictEqual(numberOf('298'), 298);
    assert.strictEqual(numberOf('007a'), 7);
  });

  it('returns null when there are no digits', () => {
    assert.strictEqual(numberOf('abc'), null);
    assert.strictEqual(numberOf(''), null);
  });
});

describe('numberDistance', () => {
  it('is zero for the same number with different padding', () => {
    assert.strictEqual(numberDistance('010', '10'), 0);
    assert.strictEqual(numberDistance('010', '010'), 0);
    assert.strictEqual(numberDistance('001', '1'), 0);
  });

  it('accepts a single digit error in the units place', () => {
    // The units digit is the least significant, so a single wrong digit there
    // is the one error shape worth trusting.
    assert.strictEqual(numberDistance('010', '014'), 0.5);
    assert.strictEqual(numberDistance('015', '019'), 0.5);
  });

  it('rejects a digit error in the tens or hundreds place', () => {
    // These move the number far enough that it is a different card, not a
    // misread. `015` vs `075` is a real pair from the Vendetta set data.
    assert.strictEqual(numberDistance('015', '075'), Number.POSITIVE_INFINITY);
    assert.strictEqual(numberDistance('998', '198'), Number.POSITIVE_INFINITY);
    assert.strictEqual(numberDistance('744', '144'), Number.POSITIVE_INFINITY);
  });

  it('rejects two or more digit errors as implausible', () => {
    assert.strictEqual(numberDistance('010', '088'), Number.POSITIVE_INFINITY);
  });

  it('ignores leading zeros entirely, however many there are', () => {
    // Comparison is numeric, so zero padding never counts as a difference.
    assert.strictEqual(numberDistance('0123', '123'), 0);
    assert.strictEqual(numberDistance('0007', '7'), 0);
  });

  it('rejects a digit-count difference that is not zero padding', () => {
    assert.strictEqual(numberDistance('1234', '234'), Number.POSITIVE_INFINITY);
  });

  it('rejects wildly different lengths', () => {
    assert.strictEqual(numberDistance('1234', '1'), Number.POSITIVE_INFINITY);
  });
});
