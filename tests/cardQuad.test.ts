/**
 * Tests for the card-outline geometry that OpenCV's contour output is fed
 * through: which four-sided shapes count as a card, which one wins, and what size
 * the rectified card is.
 *
 * These run against synthetic corners, which is the only way to test this part
 * without a camera: the native pipeline in `cardDetect.ts` is what turns pixels
 * into corners, and everything that happens to the corners afterwards is here.
 * That split is the point of the split — the decisions are testable, and the
 * untestable half does nothing but call OpenCV.
 *
 * The card used throughout is 80 × 112 px, i.e. 63 × 88 mm in miniature, so the
 * proportions in these tests are the proportions of a real Riftbound card.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    CARD_HEIGHT_RATIO,
    MAX_CARD_WIDTH,
    MIN_CARD_SCORE,
    MIN_CARD_WIDTH,
    QUAD_BOTTOM_LEFT,
    QUAD_BOTTOM_RIGHT,
    QUAD_TOP_LEFT,
    QUAD_TOP_RIGHT,
    aspectScore,
    chooseBestQuad,
    expandQuad,
    isConvexQuad,
    orderQuad,
    quadArea,
    quadCentre,
    quadSideLengths,
    rectangularity,
    scaleQuad,
    scoreQuad,
    warpSizeForQuad,
    type Point,
    type Quad,
} from '../src/scan/quad.ts';

/** A card at the origin, in card order: 63 × 88 in miniature. */
const CARD: Quad = [
    { x: 0, y: 0 },
    { x: 63, y: 0 },
    { x: 63, y: 88 },
    { x: 0, y: 88 },
];

/** A 1440 × 1920 portrait frame: 3:4, like a phone camera's stills. */
const FRAME = { width: 1440, height: 1920 };

/** How tall the guide is, in the frame its fractions were designed for. */
const GUIDE_HEIGHT = FRAME.height * 0.46;
const GUIDE_WIDTH = GUIDE_HEIGHT * (1 / CARD_HEIGHT_RATIO);

/** Rotates a point around a centre, for building tilted cards. */
function rotate(point: Point, centre: Point, degrees: number): Point {
    const radians = (degrees * Math.PI) / 180;
    const dx = point.x - centre.x;
    const dy = point.y - centre.y;
    return {
        x: centre.x + dx * Math.cos(radians) - dy * Math.sin(radians),
        y: centre.y + dx * Math.sin(radians) + dy * Math.cos(radians),
    };
}

/** Rebuilds the card from a point transform, keeping the tuple cast in one place. */
function quadOf(map: (point: Point) => Point): Quad {
    const mapped = CARD.map(map);
    return [mapped[0]!, mapped[1]!, mapped[2]!, mapped[3]!];
}

/** Moves a quad, so tests can place it anywhere in a frame. */
function move(quad: Quad, dx: number, dy: number): Quad {
    const offset = (point: Point): Point => ({ x: point.x + dx, y: point.y + dy });
    return [offset(quad[0]), offset(quad[1]), offset(quad[2]), offset(quad[3])];
}

/** Scales a quad about the origin. */
function resize(quad: Quad, factor: number): Quad {
    const scaled = (point: Point): Point => ({ x: point.x * factor, y: point.y * factor });
    return [scaled(quad[0]), scaled(quad[1]), scaled(quad[2]), scaled(quad[3])];
}

/** A rectangle in card order, at the given position. */
function rectangle(x: number, y: number, width: number, height: number): Quad {
    return [
        { x, y },
        { x: x + width, y },
        { x: x + width, y: y + height },
        { x, y: y + height },
    ];
}

function assertSamePoint(actual: Point, expected: Point, message?: string): void {
    assert.ok(
        Math.abs(actual.x - expected.x) < 1e-6 && Math.abs(actual.y - expected.y) < 1e-6,
        message ?? `expected (${expected.x}, ${expected.y}), got (${actual.x}, ${actual.y})`,
    );
}

function assertSameQuad(actual: Quad, expected: Quad, message?: string): void {
    for (let index = 0; index < 4; index += 1) {
        assertSamePoint(actual[index]!, expected[index]!, `${message} corner ${index}`);
    }
}

describe('orderQuad', () => {
    it('labels a card from the card, not from the frame', () => {
        const ordered = orderQuad(CARD);
        assert.ok(ordered !== null);
        assertSameQuad(ordered, CARD);
    });

    it('gives the same corners whatever order the contour came in', () => {
        // OpenCV's contour direction depends on which side of the edge is the
        // inside, and where it starts depends on the scan. Neither may change which
        // corner is called the top-left, or the label strip would land elsewhere.
        for (let start = 0; start < 4; start += 1) {
            for (const direction of [1, -1]) {
                const scrambled = Array.from({ length: 4 }, (_, index) => {
                    const position = (((start + direction * index) % 4) + 4) % 4;
                    return CARD[position]!;
                });
                const ordered = orderQuad(scrambled);
                assert.ok(ordered !== null, `order ${start}/${direction} should be a card`);
                assertSameQuad(ordered, CARD, `order ${start}/${direction}`);
            }
        }
    });

    it('finds the card corners when the card is held crooked', () => {
        const centre = quadCentre(CARD);
        const tilted = quadOf((point) => rotate(point, centre, 17));

        // Read from a different corner of the same outline, as a contour may start
        // anywhere along it.
        const ordered = orderQuad([tilted[2]!, tilted[3]!, tilted[0]!, tilted[1]!]);
        assert.ok(ordered !== null);

        // Each returned corner is the corner of the *card* that was tilted, not the
        // one nearest a corner of the frame.
        assertSamePoint(ordered[QUAD_TOP_LEFT], tilted[QUAD_TOP_LEFT], 'top left');
        assertSamePoint(ordered[QUAD_TOP_RIGHT], tilted[QUAD_TOP_RIGHT], 'top right');
        assertSamePoint(ordered[QUAD_BOTTOM_RIGHT], tilted[QUAD_BOTTOM_RIGHT], 'bottom right');
        assertSamePoint(ordered[QUAD_BOTTOM_LEFT], tilted[QUAD_BOTTOM_LEFT], 'bottom left');
    });

    it('rejects a card held on its side', () => {
        // A landscape quad is a portrait card turned a quarter turn. Its corners
        // would be found, but nothing could say which end is the top, and a card
        // rectified upside down reads worse than one not rectified at all.
        const sideways = quadOf((point) => ({ x: point.y, y: point.x }));
        assert.strictEqual(orderQuad(sideways), null);
    });

    it('rejects a quad held at 45 degrees', () => {
        const centre = quadCentre(CARD);
        const diagonal = quadOf((point) => rotate(point, centre, 45));
        assert.strictEqual(orderQuad(diagonal), null);
    });

    it('rejects shapes that are not the outline of a card', () => {
        // A dart: one corner pushed inside, so the shape is concave.
        const dart: Point[] = [
            { x: 0, y: 0 },
            { x: 80, y: 0 },
            { x: 40, y: 40 },
            { x: 0, y: 112 },
        ];
        assert.strictEqual(isConvexQuad(dart), false);
        assert.strictEqual(orderQuad(dart), null);

        // Three points is not a quad, and a repeated corner is not a shape.
        assert.strictEqual(orderQuad([CARD[0]!, CARD[1]!, CARD[2]!]), null);
        assert.strictEqual(orderQuad([CARD[0]!, CARD[1]!, CARD[2]!, CARD[2]!]), null);
    });
});

describe('rectangularity', () => {
    it('is 1 for a rectangle', () => {
        assert.strictEqual(rectangularity(CARD), 1);
    });

    it('falls as a corner departs from square', () => {
        // A parallelogram sheared by 40 px over its height: what perspective does to
        // the corners of a card held to one side.
        const sheared: Quad = [
            { x: 0, y: 0 },
            { x: 80, y: 0 },
            { x: 120, y: 112 },
            { x: 40, y: 112 },
        ];
        const value = rectangularity(sheared);
        assert.ok(value > 0.5 && value < 0.85, `expected a middling score, got ${value}`);
        assert.ok(value < rectangularity(CARD));
    });

    it('is decided by the worst corner, not the average', () => {
        // Three square corners and one badly wrong one is not a card, and averaging
        // would let the good corners hide the bad one.
        const broken: Quad = [
            { x: 0, y: 0 },
            { x: 80, y: 0 },
            { x: 300, y: 112 },
            { x: 0, y: 112 },
        ];
        assert.ok(rectangularity(broken) < 0.4, `got ${rectangularity(broken)}`);
    });
});

describe('aspectScore', () => {
    it('is 1 for a card', () => {
        assert.ok(aspectScore(CARD) > 0.999, `got ${aspectScore(CARD)}`);
    });

    it('cannot be fooled by a square, however rectangular it is', () => {
        const square: Quad = [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 100 },
            { x: 0, y: 100 },
        ];
        assert.strictEqual(rectangularity(square), 1);
        assert.ok(aspectScore(square) < 0.3, `got ${aspectScore(square)}`);
    });
});

describe('scoreQuad', () => {
    it('scores a card framed as the guide asks comfortably above the threshold', () => {
        // 0.46 of a 1920 px frame is 883 px tall, and a card is 0.716 as wide as it
        // is tall — the size the outline on screen invites the user to fit.
        const height = FRAME.height * 0.46;
        const guided: Quad = [
            { x: 400, y: 600 },
            { x: 400 + height * (1 / CARD_HEIGHT_RATIO), y: 600 },
            { x: 400 + height * (1 / CARD_HEIGHT_RATIO), y: 600 + height },
            { x: 400, y: 600 + height },
        ];

        const score = scoreQuad(guided, FRAME);
        assert.ok(
            score.score > MIN_CARD_SCORE + 0.15,
            `a framed card should be convincing, got ${score.score}`,
        );
        assert.ok(score.areaFraction > 0.15 && score.areaFraction < 0.3);
    });

    it('rejects a card-shaped quad too small to be the subject', () => {
        // A third of a card: this is a card somewhere in the background, and the
        // outline the user is aligning to is a better guess about what is being
        // scanned than this is.
        const small = move(resize(CARD, 0.35), 600, 800);
        const score = scoreQuad(small, FRAME);
        assert.ok(score.score < MIN_CARD_SCORE, `expected a rejection, got ${score.score}`);
    });

    it('rejects a large region whose proportions are not a card’s', () => {
        // A tall, narrow region as tall as the guide and half as wide: a shelf edge,
        // a doorway, the gap between two cards. It covers enough of the frame to win
        // on size alone, and its shape is what rules it out.
        const doorway = rectangle(600, 500, GUIDE_WIDTH / 2, GUIDE_HEIGHT);
        const score = scoreQuad(doorway, FRAME);

        assert.ok(score.areaFraction > 0.09, 'the region should be a sizeable one');
        assert.ok(
            score.height / score.width - CARD_HEIGHT_RATIO > 1,
            'its proportions should be nothing like a card’s',
        );
        assert.ok(score.score < MIN_CARD_SCORE, `expected a rejection, got ${score.score}`);
    });

    it('accepts a skewed card, because that is what holding one does', () => {
        // The same card seen from one side: still four corners, still card-shaped,
        // but no longer a rectangle. Rejecting this would reject most real scans.
        const skewed: Quad = [
            { x: 400, y: 600 },
            { x: 900, y: 640 },
            { x: 880, y: 1300 },
            { x: 380, y: 1260 },
        ];
        const score = scoreQuad(skewed, FRAME);
        assert.ok(score.score > MIN_CARD_SCORE, `expected an acceptance, got ${score.score}`);
    });
});

describe('chooseBestQuad', () => {
    it('returns null when nothing reaches the threshold', () => {
        const tiny = move(resize(CARD, 0.3), 700, 900);
        assert.strictEqual(chooseBestQuad([{ quad: tiny, score: scoreQuad(tiny, FRAME) }]), null);
    });

    it('picks the highest scoring candidate that is acceptable', () => {
        const small = move(resize(CARD, 3), 100, 200);
        const large = move(resize(CARD, 6), 100, 900);
        const best = chooseBestQuad([
            { quad: small, score: scoreQuad(small, FRAME) },
            { quad: large, score: scoreQuad(large, FRAME) },
        ]);
        assert.ok(best !== null);
        assert.deepStrictEqual(best.quad, large);
    });
});

describe('warpSizeForQuad', () => {
    it('keeps a card roughly the size it was found at', () => {
        const output = warpSizeForQuad(resize(CARD, 10));
        assert.strictEqual(output.width, 630);
        assert.strictEqual(output.height, Math.round(630 * CARD_HEIGHT_RATIO));
    });

    it('never goes wider than the point where more pixels stop helping', () => {
        assert.strictEqual(warpSizeForQuad(resize(CARD, 100)).width, MAX_CARD_WIDTH);
    });

    it('still produces something readable for a card found far away', () => {
        assert.strictEqual(warpSizeForQuad(CARD).width, MIN_CARD_WIDTH);
    });

    it('always produces card proportions, whatever shape the quad was', () => {
        // A trapezoid, as a card seen from the side would be. The rectified image
        // must not inherit that skew: that is the whole point of rectifying.
        const trapezoid: Quad = [
            { x: 0, y: 0 },
            { x: 300, y: 40 },
            { x: 260, y: 500 },
            { x: 40, y: 460 },
        ];
        const output = warpSizeForQuad(trapezoid);
        assert.ok(Math.abs(output.height / output.width - CARD_HEIGHT_RATIO) < 0.01);
    });
});

describe('quad helpers', () => {
    it('measures the card as the average of its opposite sides', () => {
        const trapezoid: Quad = [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 100 },
            { x: 50, y: 100 },
        ];
        const sides = quadSideLengths(trapezoid);
        // Top and bottom average 75; the two sides of a trapezoid are not the same
        // length, and the average of those is what the rectified size follows.
        assert.strictEqual(sides.width, 75);
        assert.strictEqual(sides.height, (Math.hypot(50, 100) + 100) / 2);
    });

    it('measures the area the shoelace way', () => {
        assert.strictEqual(quadArea(CARD), 63 * 88);
    });

    it('finds the centre of a quad', () => {
        assert.deepStrictEqual(quadCentre(CARD), { x: 31.5, y: 44 });
    });

    it('scales a quad back out of the detector’s shrunken image', () => {
        assert.deepStrictEqual(scaleQuad(CARD, 3), resize(CARD, 3));
    });

    it('grows a quad about its own centre, leaving the centre put', () => {
        const grown = expandQuad(CARD, 0.1);
        assert.deepStrictEqual(quadCentre(grown), quadCentre(CARD));
        assert.strictEqual(quadSideLengths(grown).width, 63 * 1.1);
        assert.strictEqual(quadSideLengths(grown).height, 88 * 1.1);
    });
});
