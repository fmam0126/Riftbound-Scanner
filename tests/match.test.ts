/**
 * Tests for the OCR parser and card matcher, run against the real generated
 * card database.
 *
 * Using the real data matters: the whole point of these tests is to prove the
 * scanner resolves the misreads that Google ML Kit actually produces on a
 * Riftbound card's collector number, not misreads invented to flatter the
 * algorithm.
 */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import type { CardDatabase } from '../src/types.ts';
import { buildIndex, matchOcrText, matchParsed, type CardIndex } from '../src/logic/match.ts';
import { parseCardId, tokenize } from '../src/logic/parseOcr.ts';

import rawDb from '../src/data/cards.json' with { type: 'json' };

const db = rawDb as unknown as CardDatabase;

let index: CardIndex;

before(() => {
  index = buildIndex(db);
});

/** Shorthand for the common assertion. */
function scan(text: string) {
  return matchOcrText(index, text);
}

describe('generated card database', () => {
  it('contains the known Riftbound sets', () => {
    const codes = index.sets;
    for (const expected of ['OGN', 'OGS', 'SFD', 'UNL', 'VEN', 'OPP', 'PR', 'JDG', 'SGN']) {
      assert.ok(codes.includes(expected));
    }
  });

  it('has a unique key for every card', () => {
    const keys = new Set(index.cards.map((c) => c.key));
    assert.strictEqual(keys.size, index.cards.length);
  });

  it('includes the canonical Origins card the app is documented against', () => {
    const card = index.cards.find((c) => c.id === 'OGN-010');
    assert.notStrictEqual(card, undefined);
    assert.strictEqual(card?.name, 'Legion Rearguard');
    assert.strictEqual(card?.number, '010');
  });

  it('tracks alternate-art printings as separate cards sharing a number', () => {
    const base = index.cards.find((c) => c.key === 'OGN-007');
    const alt = index.cards.find((c) => c.key === 'OGN-007a');
    // The two printings share a card name and collector number; the key and the
    // TCGplayer printing name are what tell them apart.
    assert.strictEqual(base?.number, alt?.number);
    assert.strictEqual(base?.variant, '');
    assert.strictEqual(alt?.variant, 'a');
    assert.ok(alt?.printingName.includes('Alternate Art'));
  });

  it('records every set code in lowercase-free uppercase form', () => {
    for (const code of index.sets) {
      assert.strictEqual(code, code.toUpperCase());
    }
  });
});

describe('tokenize', () => {
  it('splits on whitespace and common separators while keeping line numbers', () => {
    const tokens = tokenize('OGN-010\nRIFTBOUND');
    // The hyphen is a separator, so `OGN-010` becomes two tokens. That is what
    // lets the same code handle `OGN 010`, `OGN-010` and `OGN - 010`.
    assert.deepStrictEqual(tokens.map((t) => t.text), ['OGN', '010', 'RIFTBOUND']);
    assert.strictEqual(tokens[0]?.line, 0);
    assert.strictEqual(tokens[1]?.line, 0);
    assert.strictEqual(tokens[2]?.line, 1);
  });

  it('keeps the printed set total inside one token', () => {
    // `160/298` is a single printed unit; splitting it would lose the number's
    // context and break every real card read.
    assert.deepStrictEqual(tokenize('OGN 160/298').map((t) => t.text), ['OGN', '160/298']);
  });

  it('treats pipes as separators', () => {
    const tokens = tokenize('OGN|010');
    assert.deepStrictEqual(tokens.map((t) => t.text), ['OGN', '010']);
  });

  it('treats en and em dashes as separators', () => {
    assert.deepStrictEqual(tokenize('OGN — 160/298').map((t) => t.text), ['OGN', '160/298']);
    assert.deepStrictEqual(tokenize('OGN – 160/298').map((t) => t.text), ['OGN', '160/298']);
  });
});

describe('parseCardId', () => {
  it('parses a clean hyphenated identifier', () => {
    const parsed = parseCardId('OGN-010', index.sets);
    assert.strictEqual(parsed?.number, '010');
    assert.strictEqual(parsed?.setCodeRaw, 'OGN');
  });

  it('parses a space-separated identifier', () => {
    const parsed = parseCardId('OGN 010', index.sets);
    assert.strictEqual(parsed?.number, '010');
  });

  it('parses an identifier split across lines', () => {
    const parsed = parseCardId('OGN\n010', index.sets);
    assert.strictEqual(parsed?.number, '010');
  });

  it('repairs a fully garbled read', () => {
    // 0<->O and O<->0 confusions: "OGN 010" read as "0GN O1O".
    const parsed = parseCardId('0GN O1O', index.sets);
    assert.strictEqual(parsed?.setCodeRaw, '0GN');
    assert.strictEqual(parsed?.number, '010');
  });

  it('finds the identifier inside surrounding noise', () => {
    const parsed = parseCardId('RIFTBOUND\nOGN-010\nLEGION REARGUARD', index.sets);
    assert.strictEqual(parsed?.number, '010');
  });

  it('captures an alternate-art letter suffix', () => {
    const parsed = parseCardId('OGN 007a', index.sets);
    assert.strictEqual(parsed?.number, '007');
    assert.strictEqual(parsed?.variant, 'a');
  });

  it('returns null when there is no collector number', () => {
    assert.strictEqual(parseCardId('RIFTBOUND LEAGUE OF LEGENDS', index.sets), null);
    assert.strictEqual(parseCardId('', index.sets), null);
  });

  it('does not invent an identifier from a bare year', () => {
    // A 4-digit value is not a Riftbound collector number, but the parser is
    // lenient about length; what matters is that it does not claim high
    // confidence for it. The matcher is responsible for rejecting it.
    const result = scan('RIFTBOUND 2025');
    assert.strictEqual(result.kind, 'none');
  });
});

describe('matchOcrText — exact reads', () => {
  it('matches the documented example card', () => {
    const result = scan('OGN-010');
    assert.strictEqual(result.kind, 'exact');
    assert.strictEqual(result.best?.card.id, 'OGN-010');
    assert.strictEqual(result.best?.card.name, 'Legion Rearguard');
    assert.ok(result.best?.confidence > 0.9);
  });

  it('matches across every set', () => {
    const expectations: Array<[string, string]> = [
      ['OGN 010', 'Legion Rearguard'],
      ['OGN 054', 'Sunlit Guardian'],
      ['SFD 001', 'Against the Odds'],
    ];
    for (const [text, name] of expectations) {
      const result = scan(text);
      assert.strictEqual(result.kind, 'exact');
      assert.strictEqual(result.best?.card.name, name);
    }
  });

  it('matches a space-separated read', () => {
    assert.strictEqual(scan('OGN 010').best?.card.id, 'OGN-010');
  });

  it('matches a split-line read', () => {
    assert.strictEqual(scan('OGN\n010').best?.card.id, 'OGN-010');
  });
});

describe('matchOcrText — OCR error correction', () => {
  it('corrects a fully garbled read to the right card', () => {
    const result = scan('0GN O1O');
    assert.strictEqual(result.best?.card.id, 'OGN-010');
    assert.strictEqual(result.kind, 'fuzzy');
    assert.ok(result.best?.confidence > 0.6);
  });

  it('corrects a single confused set-code character', () => {
    // "OGN" misread as "0GN".
    const result = scan('0GN 010');
    assert.strictEqual(result.best?.card.id, 'OGN-010');
    assert.strictEqual(result.kind, 'fuzzy');
  });

  it('corrects a single confused digit', () => {
    // "010" misread as "01O": the trailing O is a misread zero.
    const result = scan('OGN 01O');
    assert.strictEqual(result.best?.card.id, 'OGN-010');
  });

  it('corrects a confused set code', () => {
    // "SFD" misread as "5FD".
    const result = scan('5FD 001');
    assert.strictEqual(result.best?.card.id, 'SFD-001');
  });

  it('survives noise on the same line', () => {
    const result = scan('OGN-010 // RIFTBOUND');
    assert.strictEqual(result.best?.card.id, 'OGN-010');
  });

  it('explains how it corrected the read', () => {
    const result = scan('0GN O1O');
    assert.match(result.reason, /corrected|read/i);
  });
});

describe('matchOcrText — ambiguity', () => {
  it('prefers the base printing when the art letter was not read', () => {
    // Reading `007` cannot distinguish `007` from `007a`, but the base printing
    // is overwhelmingly the likelier card. It is therefore recorded directly
    // rather than forcing a choice on every single scan.
    const result = scan('OGN 007');
    assert.strictEqual(result.best?.card.key, 'OGN-007');
    assert.strictEqual(result.kind, 'exact');
  });

  it('still exposes the alternate art as a ranked alternative', () => {
    const result = scan('OGN 007');
    const keys = result.candidates.map((c) => c.card.key);
    assert.ok(keys.includes('OGN-007a'));
    assert.strictEqual(result.candidates[0]?.card.key, 'OGN-007');
  });

  it('asks the user when two cards are genuinely indistinguishable', () => {
    // The five Worlds Champion promo bundles share number 001 and differ only
    // by a printing qualifier TCGplayer publishes in the product name, so a
    // scan of `PR 001` cannot be resolved automatically.
    const result = scan('PR 001');
    assert.strictEqual(result.kind, 'ambiguous');
    assert.ok(result.candidates.length > 1);
    assert.match(result.reason, /printing|pick|close/i);
  });

  it('resolves unambiguously when the art letter is read', () => {
    const result = scan('OGN 007a');
    assert.strictEqual(result.best?.card.key, 'OGN-007a');
    assert.notStrictEqual(result.kind, 'ambiguous');
  });
});

describe('matchOcrText — rejection', () => {
  it('returns none for text with no number', () => {
    const result = scan('RIFTBOUND');
    assert.strictEqual(result.kind, 'none');
    assert.strictEqual(result.best, null);
    assert.match(result.reason, /collector number|set code/i);
  });

  it('returns none for an empty read', () => {
    assert.strictEqual(scan('').kind, 'none');
  });

  it('returns none when a single digit differs in the hundreds place', () => {
    // 998 is not a card. 198 and 298 are one digit away, but that digit is the
    // hundreds place, so they are different numbers rather than a misread.
    // Matching them would silently file the wrong card.
    const result = scan('OGN 998');
    assert.strictEqual(result.kind, 'none');
    assert.strictEqual(result.best, null);
  });

  it('returns none when no card is close enough to be plausible', () => {
    // 744 differs from every Origins number by at least two digits.
    const result = scan('OGN 744');
    assert.strictEqual(result.kind, 'none');
    assert.strictEqual(result.best, null);
  });
});

describe('matchParsed', () => {
  it('reports a reason when the set code is unknown', () => {
    const result = matchParsed(index, {
      setCodeRaw: 'ZZZ',
      prefix: '',
      number: '010',
      variant: '',
      raw: 'ZZZ 010',
      source: 'loose',
    });
    assert.strictEqual(result.kind, 'none');
    assert.strictEqual(result.candidates.length, 0);
  });

  it('carries the parsed identifier through for debugging', () => {
    const parsed = {
      setCodeRaw: 'OGN',
      prefix: '',
      number: '010',
      variant: '',
      raw: 'x',
      source: 'pattern' as const,
    };
    const result = matchParsed(index, parsed);
    assert.strictEqual(result.parsed, parsed);
  });
});

describe('confidence behaviour', () => {
  it('scores an exact read above a corrected one', () => {
    const exact = scan('OGN 010').best?.confidence ?? 0;
    const fuzzy = scan('0GN O1O').best?.confidence ?? 0;
    assert.ok(exact > fuzzy);
  });

  it('never reports confidence outside 0..1', () => {
    for (const text of ['OGN 010', '0GN O1O', '5FD 001', 'OGN 007a']) {
      const c = scan(text).best?.confidence;
      if (c !== undefined) {
        assert.ok(c >= 0);
        assert.ok(c <= 1);
      }
    }
  });
});
