/**
 * Card outline geometry: deciding which detected contour is a card, and what its
 * four corners are.
 *
 * Everything here is pure — no React Native, no OpenCV, no image decoding — so
 * the decisions that actually matter (what counts as a card, which candidate
 * wins, what size to rectify to) are unit tested without a camera. `cardDetect.ts`
 * runs the OpenCV pipeline and hands the raw point sets to these functions.
 *
 * Coordinates are pixels of whatever image the contour was found in. Nothing here
 * assumes an image size, so the same code serves both the small image the
 * detector works on and the full-resolution frame it rectifies from.
 */

import { CARD_ASPECT } from './geometry.ts';

/** A point in image pixels. */
export interface Point {
    x: number;
    y: number;
}

/**
 * The four corners of a card, clockwise from the card's *own* top-left corner.
 *
 * "The card's own" is the point. The corners are labelled by where they sit on
 * the card, not by where they sit in the frame, so a card held slightly crooked
 * still has a top-left. Fixing that order is what lets one constant rectangle
 * (the label strip) be mapped onto the rectified result no matter how the card
 * was held, and it is also what makes "is the card upside down?" a non-question:
 * the answer is always no.
 */
export type Quad = readonly [Point, Point, Point, Point];

export const QUAD_TOP_LEFT = 0;
export const QUAD_TOP_RIGHT = 1;
export const QUAD_BOTTOM_RIGHT = 2;
export const QUAD_BOTTOM_LEFT = 3;

/** Card proportions as height ÷ width. A card is taller than it is wide. */
export const CARD_HEIGHT_RATIO = 1 / CARD_ASPECT;

/**
 * How far the height ÷ width ratio may drift from a card's before the shape
 * scores zero. Measured in log space, so being twice too tall is penalised
 * exactly as much as being twice too wide.
 *
 * Perspective is the reason this is generous: a card photographed from an angle
 * foreshortens, and rejecting that outright would reject most real scans. The
 * ratio only has to be convincing enough to beat the other candidates.
 */
export const ASPECT_TOLERANCE = Math.log(1.5);

/**
 * A quad covering this share of the frame scores full marks for size. It is the
 * share the drawn guide occupies on a typical phone, so a card held as
 * instructed lands exactly here.
 */
export const QUAD_AREA_FOR_FULL_MARKS = 0.3;

/** How the score blends size against shape. Shape carries more: see {@link scoreQuad}. */
export const QUAD_AREA_WEIGHT = 0.45;
export const QUAD_SHAPE_WEIGHT = 0.55;

/**
 * The score a quad must reach to be treated as the card.
 *
 * Calibrated so that a card framed as instructed scores ~0.9, while a large but
 * wrong region — a table edge, a shelf, a page of a book laid across the frame —
 * cannot pass no matter how much of the frame it covers: shape and size are
 * multiplied for the shape half of the score, so being big is not a substitute
 * for being card-shaped.
 */
export const MIN_CARD_SCORE = 0.6;

/** The rectified card is never wider than this: past it, detail stops helping OCR. */
export const MAX_CARD_WIDTH = 1080;
/**
 * …and never narrower, even for a card detected far away. Upscaling invents no
 * detail, but it does give the text recogniser a usable image, and a card this
 * small is a guess that other checks have already had to accept.
 */
export const MIN_CARD_WIDTH = 320;

/** Distance between two points. */
export function distance(a: Point, b: Point): number {
    return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Whether four points form a convex shape with no collinear corner.
 *
 * Cards are quadrilaterals seen in perspective: a projective transform maps a
 * rectangle to a convex quad, never to a dart and never to a shape with a
 * straight-through corner. Both of those are how a contour that merely *looks*
 * four-sided (a corner of two converging edges, a notch) gets rejected.
 */
export function isConvexQuad(points: readonly Point[]): boolean {
    if (points.length !== 4) return false;

    let sign = 0;
    for (let i = 0; i < 4; i += 1) {
        const a = points[i];
        const b = points[(i + 1) % 4];
        const c = points[(i + 2) % 4];
        if (a === undefined || b === undefined || c === undefined) return false;

        const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
        if (cross === 0) return false;

        const next = cross > 0 ? 1 : -1;
        if (sign === 0) sign = next;
        else if (next !== sign) return false;
    }
    return true;
}

/** True when an edge runs more vertically than horizontally. */
function isVerticalEdge(a: Point, b: Point): boolean {
    return Math.abs(b.y - a.y) >= Math.abs(b.x - a.x);
}

interface Edge {
    /** Index of the corner the edge starts at, in the input's own order. */
    from: number;
    to: number;
    midX: number;
    midY: number;
    /** True when the edge runs more vertically than horizontally. */
    vertical: boolean;
}

/**
 * Puts four arbitrary corners into card order, or returns `null` when they cannot
 * be read as an upright card.
 *
 * The points must arrive in their outline order — each consecutive pair is an
 * edge, wrapping round at the end — which is exactly how a contour comes out of
 * OpenCV. Which corner that order starts at, and which way round it runs, are
 * both free: the labelling below does not look at the order at all, only at
 * which points share an edge.
 *
 * The corners are labelled from the edges rather than from their coordinates:
 * each side of a portrait card is either mostly horizontal or mostly vertical, so
 * the sides can be sorted into a left, right, top and bottom by their midpoints,
 * and each corner is then the point shared by one vertical and one horizontal
 * edge. That is what makes the labelling independent of how the caller happened
 * to order (or reverse) the contour, and of which way the card leans.
 *
 * A card held at roughly 45° has no sides that are more vertical than
 * horizontal, so its edges cannot be classified and `null` comes back. That is
 * deliberate: it is also the point at which "which way is up?" stops having an
 * answer from geometry alone, and a card rectified upside down is worse than one
 * that was not rectified at all. For the same reason a quad that comes out wider
 * than it is tall is refused — that is a card lying on its side, and there is no
 * way to tell which end of it is the top.
 */
export function orderQuad(points: readonly Point[]): Quad | null {
    if (!isConvexQuad(points)) return null;

    const corners: Point[] = [points[0]!, points[1]!, points[2]!, points[3]!];

    const edges: Edge[] = [];
    for (let i = 0; i < 4; i += 1) {
        const from = corners[i]!;
        const to = corners[(i + 1) % 4]!;
        edges.push({
            from: i,
            to: (i + 1) % 4,
            midX: (from.x + to.x) / 2,
            midY: (from.y + to.y) / 2,
            vertical: isVerticalEdge(from, to),
        });
    }

    const vertical = edges.filter((edge) => edge.vertical);
    const horizontal = edges.filter((edge) => !edge.vertical);
    if (vertical.length !== 2 || horizontal.length !== 2) return null;

    // Every corner must join one vertical and one horizontal edge. Two vertical
    // edges meeting at a point means a shape squashed along its diagonal, which is
    // not a card seen from any angle an app can read.
    for (let i = 0; i < 4; i += 1) {
        if (edges[(i + 3) % 4]!.vertical === edges[i]!.vertical) return null;
    }

    const byMidX = [...vertical].sort((a, b) => a.midX - b.midX);
    const byMidY = [...horizontal].sort((a, b) => a.midY - b.midY);
    const left = byMidX[0]!;
    const right = byMidX[1]!;
    const top = byMidY[0]!;
    const bottom = byMidY[1]!;

    const sharedCorner = (a: Edge, b: Edge): Point | null => {
        const shared = [a.from, a.to].find((corner) => corner === b.from || corner === b.to);
        return shared === undefined ? null : corners[shared]!;
    };

    const topLeft = sharedCorner(left, top);
    const topRight = sharedCorner(right, top);
    const bottomRight = sharedCorner(right, bottom);
    const bottomLeft = sharedCorner(left, bottom);
    if (topLeft === null || topRight === null || bottomRight === null || bottomLeft === null) {
        return null;
    }

    const ordered: Quad = [topLeft, topRight, bottomRight, bottomLeft];

    // A card is taller than it is wide, and this is the only thing separating "a
    // card held upright" from "a card lying on its side". Both are four edges that
    // classify cleanly, but the sideways one is labelled with the card's *short*
    // edges as its left and right — which is not a card at that size, and would put
    // the collector number in the wrong place if it were rectified that way.
    const sides = quadSideLengths(ordered);
    if (sides.height <= sides.width) return null;

    return ordered;
}

/** Signed area in square pixels, always positive for a valid quad. */
export function quadArea(quad: Quad): number {
    let sum = 0;
    for (let i = 0; i < 4; i += 1) {
        const a = quad[i]!;
        const b = quad[(i + 1) % 4]!;
        sum += a.x * b.y - b.x * a.y;
    }
    return Math.abs(sum) / 2;
}

/**
 * The card's true width and height in pixels, as the average of its two pairs of
 * opposite sides.
 *
 * Averaging is what makes this usable for sizing a rectified image: under
 * perspective the near side of a card is longer than the far side, and either one
 * alone would stretch the result.
 */
export function quadSideLengths(quad: Quad): { width: number; height: number } {
    const [topLeft, topRight, bottomRight, bottomLeft] = quad;
    return {
        width: (distance(topLeft, topRight) + distance(bottomLeft, bottomRight)) / 2,
        height: (distance(topLeft, bottomLeft) + distance(topRight, bottomRight)) / 2,
    };
}

/** The quad's centre, used for growing and shrinking it about itself. */
export function quadCentre(quad: Quad): Point {
    const [topLeft, topRight, bottomRight, bottomLeft] = quad;
    return {
        x: (topLeft.x + topRight.x + bottomRight.x + bottomLeft.x) / 4,
        y: (topLeft.y + topRight.y + bottomRight.y + bottomLeft.y) / 4,
    };
}

/**
 * How rectangle-like the quad is, as 1 for a perfect rectangle down to 0 for a
 * shape whose worst corner is a right angle away from square.
 *
 * The *worst* corner decides, not the average: three square corners and one
 * badly wrong one is a shape that is not a card, and averaging would hide that.
 */
export function rectangularity(quad: Quad): number {
    let worst = 0;
    for (let i = 0; i < 4; i += 1) {
        const previous = quad[(i + 3) % 4]!;
        const corner = quad[i]!;
        const next = quad[(i + 1) % 4]!;

        const ax = previous.x - corner.x;
        const ay = previous.y - corner.y;
        const bx = next.x - corner.x;
        const by = next.y - corner.y;
        const lengths = Math.hypot(ax, ay) * Math.hypot(bx, by);
        if (lengths === 0) return 0;

        const cosine = Math.max(-1, Math.min(1, (ax * bx + ay * by) / lengths));
        const degrees = (Math.acos(cosine) * 180) / Math.PI;
        worst = Math.max(worst, Math.abs(degrees - 90));
    }
    return clamp01(1 - worst / 90);
}

/**
 * How card-like the quad's proportions are, as 1 for exactly a card's ratio.
 *
 * A phone camera sees a lot of rectangles. This is the check that separates a
 * card from the window, the door frame and the edge of a table, none of which
 * happen to be 63 × 88 mm.
 */
export function aspectScore(quad: Quad): number {
    const { width, height } = quadSideLengths(quad);
    if (width <= 0 || height <= 0) return 0;
    const drift = Math.abs(Math.log(height / width / CARD_HEIGHT_RATIO));
    return clamp01(1 - drift / ASPECT_TOLERANCE);
}

export interface QuadScore {
    /** 0…1, higher is more card-like. Compare against {@link MIN_CARD_SCORE}. */
    score: number;
    /** Share of the frame the quad covers. */
    areaFraction: number;
    rectangularity: number;
    aspectScore: number;
    width: number;
    height: number;
}

/**
 * Scores one candidate quad against the frame it was found in.
 *
 * Two things decide the winner, and they are combined so that neither can carry
 * a bad candidate on its own:
 *
 *  - **Size**, because of two plausible rectangles the card is the one the user
 *    pointed the camera at, and it is framed to fill a good part of the picture.
 *  - **Shape**, as rectangularity *multiplied by* card proportions, because that
 *    is the part that cannot be faked by simply being large. A big skewed region
 *    scores near zero here however much of the frame it covers, which is what
 *    keeps the shelf behind the card from winning.
 *
 * Size is measured against {@link QUAD_AREA_FOR_FULL_MARKS} rather than against
 * the whole frame so that a card framed as the guide asks scores full marks
 * without needing to fill the picture.
 */
export function scoreQuad(quad: Quad, imageSize: { width: number; height: number }): QuadScore {
    const { width, height } = quadSideLengths(quad);
    const frameArea = imageSize.width * imageSize.height;
    const areaFraction = frameArea > 0 ? clamp01(quadArea(quad) / frameArea) : 0;

    const squareness = rectangularity(quad);
    const proportions = aspectScore(quad);
    const sizeTerm = clamp01(areaFraction / QUAD_AREA_FOR_FULL_MARKS);

    return {
        score: QUAD_AREA_WEIGHT * sizeTerm + QUAD_SHAPE_WEIGHT * squareness * proportions,
        areaFraction,
        rectangularity: squareness,
        aspectScore: proportions,
        width,
        height,
    };
}

export interface QuadCandidate {
    quad: Quad;
    score: QuadScore;
}

/**
 * Picks the card out of everything the contour pass found, or `null` when
 * nothing was convincing enough to be one.
 *
 * Returning `null` is a normal outcome, not a failure: the caller falls back to
 * cropping against the guide the user was asked to align to, which is what the
 * app did before it could find the card at all. Guessing here would be worse,
 * because a wrong crop sends the text recogniser somewhere the number is not.
 */
export function chooseBestQuad(
    candidates: readonly QuadCandidate[],
    minimumScore: number = MIN_CARD_SCORE,
): QuadCandidate | null {
    let best: QuadCandidate | null = null;
    for (const candidate of candidates) {
        if (candidate.score.score < minimumScore) continue;
        if (best === null || candidate.score.score > best.score.score) best = candidate;
    }
    return best;
}

/** Scales a quad, e.g. from the detector's small image back to the real one. */
export function scaleQuad(quad: Quad, factor: number): Quad {
    const scale = (point: Point): Point => ({ x: point.x * factor, y: point.y * factor });
    return [scale(quad[0]), scale(quad[1]), scale(quad[2]), scale(quad[3])];
}

/**
 * Grows a quad outwards from its centre, as a fraction of its size.
 *
 * Corners are found to within a few pixels, and an edge that lands just *inside*
 * the card clips whatever is printed at the very edge — which, for this app, is
 * the collector number in the bottom-left corner. Growing the quad is cheap
 * insurance against that, and the extra ring of background it adds costs nothing
 * because the text recogniser reads the strip, not a fixed grid of pixels.
 */
export function expandQuad(quad: Quad, fraction: number): Quad {
    const centre = quadCentre(quad);
    const scale = 1 + fraction;
    const grow = (point: Point): Point => ({
        x: centre.x + (point.x - centre.x) * scale,
        y: centre.y + (point.y - centre.y) * scale,
    });
    return [grow(quad[0]), grow(quad[1]), grow(quad[2]), grow(quad[3])];
}

/**
 * The pixel size of the rectified card for a detected quad.
 *
 * The width follows the quad, so a card held close keeps its detail and none is
 * invented for one held far away, then it is clamped: wide enough for the text
 * recogniser to have something to read, and no wider than the point where extra
 * pixels stop changing the answer but still cost time and memory on every scan.
 *
 * The height follows from the card's true proportions rather than from the quad,
 * which is the whole point of rectifying: the perspective the photo added is
 * removed, so the label strip lands in the same place on every card.
 */
export function warpSizeForQuad(
    quad: Quad,
    options: { maxWidth?: number; minWidth?: number } = {},
): { width: number; height: number } {
    const maxWidth = options.maxWidth ?? MAX_CARD_WIDTH;
    const minWidth = options.minWidth ?? MIN_CARD_WIDTH;
    const { width } = quadSideLengths(quad);
    const target = Math.round(Math.min(maxWidth, Math.max(minWidth, width)));
    return { width: target, height: Math.round(target / CARD_ASPECT) };
}

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}
