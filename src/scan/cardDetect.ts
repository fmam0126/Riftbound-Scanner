/**
 * Finding the card in the frame with OpenCV, and straightening it.
 *
 * Why this exists
 * ---------------
 * The scanner originally assumed the card was where the drawn outline said it
 * was, and cropped the collector number from a fixed fraction of that rectangle.
 * That holds only while the user lines the card up perfectly and holds it flat.
 * In practice a card is held a little crooked, a little high, or a little small,
 * and a fixed crop then reads the wrong part of the frame — the number is a few
 * characters printed in one corner, and losing it by a few percent is the
 * difference between a scan and a failure.
 *
 * So the card is *found* instead. The frame is handed to OpenCV, which traces
 * its edges, keeps the quadrilaterals, and scores them against what a card looks
 * like; the winner's four corners are then used to undo the perspective and
 * produce a straightened card image. Everything downstream — the label strip, the
 * whole-card recovery pass, and any future recogniser that does not read text —
 * works from that one image, so they all see the same upright, correctly
 * proportioned card.
 *
 * This is classical computer vision, not a trained model. Contour detection is
 * the right tool here and the reason is the shape of the problem: a card is a
 * high-contrast quadrilateral whose proportions are fixed and known (63 × 88 mm),
 * and the only thing that varies is where it sits in the frame and how it is
 * tilted. That is what the pipeline measures directly, with no model to ship, no
 * training data, no inference cost per frame, and nothing that can only be
 * explained after the fact. A detector such as YOLOv8-nano would answer a harder
 * question — *what kind* of object is this — which this app never needs to ask,
 * because there is exactly one kind of object in front of the camera and its
 * geometry is already known.
 *
 * The pipeline, in the order OpenCV's own document-scanner recipe runs it:
 *
 *   1. `cvtColor` + `GaussianBlur` — work on intensity, and drop sensor noise and
 *      card art texture before looking for edges.
 *   2. `Canny` — the card's border against its background is the strongest edge
 *      in the frame, and Canny finds edges by gradient rather than by absolute
 *      brightness, so it works on a bright table and on a dark one alike.
 *   3. `dilate` — a Canny edge is one pixel wide and can break where the border
 *      is soft; thickening it closes those gaps so the border traces as one loop.
 *   4. `findContours` + `approxPolyDP` — turn each loop into a polygon, and keep
 *      the ones that are four-sided.
 *   5. `getPerspectiveTransform` + `warpPerspective` — map the winning corners
 *      onto a rectangle of the card's true proportions.
 *
 * The scoring of step 4's candidates lives in `quad.ts`, pure and unit tested;
 * this module only supplies the pixels. Nothing here throws on a failure to find
 * a card: `no-card` is a normal answer, and the caller falls back to the guide
 * crop it used before.
 */

import { File, Paths, type Directory } from 'expo-file-system';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';

import {
    chooseBestQuad,
    expandQuad,
    orderQuad,
    scaleQuad,
    scoreQuad,
    warpSizeForQuad,
    type Point,
    type Quad,
    type QuadCandidate,
} from './quad.ts';

/**
 * Everything the native module exports: OpenCV's functions and object factories
 * under `OpenCV`, and the OpenCV constants as separate named exports.
 */
type OpenCvModule = typeof import('react-native-fast-opencv');

/** A decoded image, as the library's opaque `Mat` handle. */
type MatHandle = ReturnType<OpenCvModule['OpenCV']['Mat']['createFromBase64']>;

/**
 * Width the frame is reduced to before any of this runs.
 *
 * Chosen to line up with `MAX_CARD_WIDTH`: a card held as the guide asks fills
 * about three quarters of the frame's width, so a card detected here is
 * rectified at roughly 1:1, with neither resolution invented nor thrown away.
 * Working smaller would cost the collector number real detail; working at the
 * camera's full 12 megapixels would allocate tens of megabytes per scan to
 * produce an image no larger than this one.
 */
export const WORKING_WIDTH = 1440;

/**
 * Width the contour pass itself runs at.
 *
 * Detection only needs the card's outline, and an outline survives being shrunk:
 * a third of the working width still leaves ~350 px across the card. Running it
 * at the full working size would cost several times as much per scan for corners
 * that land within a pixel of the same place. The corners are scaled back up to
 * the working image before anything is measured or cropped, so only detection is
 * small — the rectified card keeps full detail.
 */
export const DETECTION_WIDTH = 480;

/** Canny's hysteresis thresholds. Low enough for soft borders, high enough to ignore art. */
const CANNY_LOW = 40;
const CANNY_HIGH = 140;

/** How thick a border is made before contours are traced, to close small gaps. */
const EDGE_DILATE_SIZE = 3;

/** Polygon tolerance, as a fraction of the contour's perimeter. */
const APPROX_EPSILON_FRACTION = 0.02;

/**
 * Smallest contour worth approximating, as a fraction of the image perimeter.
 *
 * A card would have to be a sixth of the frame's width to trip this, which is
 * well below anything the scorer would accept anyway, so this only exists to
 * keep the loop off the hundreds of tiny contours that card art produces.
 */
const MIN_CONTOUR_PERIMETER_FRACTION = 0.15;

/**
 * How far the detected corners are grown outwards before rectifying.
 *
 * An outline traced from a photograph lands a pixel or two inside the true edge,
 * and the strip that gets read is printed hard against the card's left and bottom
 * edges. Growing the quad slightly guarantees those edge pixels are inside the
 * rectified image; the sliver of background it adds is not near enough to the
 * printed number to matter.
 */
const QUAD_GROWTH_FRACTION = 0.015;

/** Prefix and retention for the rectified card images written to the cache. */
const CROP_FILE_PREFIX = 'card-crop-';
const MAX_KEPT_CROPS = 3;

/**
 * The straightened card produced by detection.
 *
 * This is the image the rest of the pipeline reads: it is upright, cropped to the
 * card's edge, and in the card's true proportions, so a fixed rectangle on it
 * covers the same printed pixels on every card. It is deliberately a file the
 * screen can keep and show — and hand to an image-based recogniser later.
 */
export interface CardCrop {
    /** `file://` URI of the rectified card image, in the app's cache. */
    uri: string;
    width: number;
    height: number;
    /**
     * The detected corners, as fractions of the frame, clockwise from the card's
     * top-left. Reported so a caller can draw where the card was found.
     */
    corners: Quad;
    /** The score the winning quad reached; 1 is a card filling the guide exactly. */
    score: number;
}

export type CardDetectionStatus =
    /** A card was found and rectified. */
    | 'detected'
    /** OpenCV ran and found nothing card-shaped in the frame. */
    | 'no-card'
    /** The native module is not in this build, or the frame cannot be used. */
    | 'unavailable'
    /** Something went wrong; the reason is in `detail`. */
    | 'failed';

export interface CardDetection {
    status: CardDetectionStatus;
    /** One line for the on-screen diagnostics, so a bad scan can be explained. */
    detail: string;
    /** How many four-sided candidates were scored. */
    candidates: number;
    durationMs: number;
    /** The rectified card. Present only when the status is `detected`. */
    crop: CardCrop | null;
}

/**
 * The binding, imported on first use rather than at the top of the file.
 *
 * `react-native-fast-opencv` throws from its module body when the native half is
 * absent — which is what a dev client built before this dependency existed sees.
 * Importing it lazily turns that into a normal `unavailable` result and lets the
 * scanner keep working the old way until the app is rebuilt, instead of failing
 * at startup with a red screen.
 */
let cachedOpenCv: OpenCvModule | null | undefined;

function loadOpenCv(): OpenCvModule | null {
    if (cachedOpenCv !== undefined) return cachedOpenCv;
    try {
        cachedOpenCv = require('react-native-fast-opencv') as OpenCvModule;
    } catch (error) {
        console.warn('OpenCV card detection is unavailable:', error);
        cachedOpenCv = null;
    }
    return cachedOpenCv;
}

/** A frame reduced to a size the detector works at. */
interface WorkingImage {
    uri: string;
    width: number;
    height: number;
    /** True when this module wrote the file, and must therefore clean it up. */
    temporary: boolean;
}

/**
 * Finds the card in a captured photo and rectifies it.
 *
 * Never throws: every failure — no native module, an unreadable frame, an
 * unexpected image layout — comes back as a status the caller can act on, because
 * the caller always has a working fallback.
 */
export async function detectAndRectifyCard(photo: {
    uri: string;
    width: number;
    height: number;
}): Promise<CardDetection> {
    const started = Date.now();
    const finish = (result: Omit<CardDetection, 'durationMs'>): CardDetection => ({
        ...result,
        durationMs: Date.now() - started,
    });

    const bindings = loadOpenCv();
    if (bindings === null) {
        return finish({
            status: 'unavailable',
            detail: 'OpenCV is not in this build',
            candidates: 0,
            crop: null,
        });
    }

    let working: WorkingImage | null = null;
    let source: MatHandle | null = null;

    try {
        working = await reduceFrame(photo);
        const base64 = await new File(working.uri).base64();
        source = bindings.OpenCV.Mat.createFromBase64(base64);

        // A JPEG carries its own orientation flag, and whether the decoder applies it
        // is a per-platform detail. If the decoded frame disagrees with the size the
        // camera reported, the corners found here would be right but the rectified
        // card would be rotated — and there is no way to tell from geometry alone
        // which way up a card that arrived sideways should be. Detection is skipped
        // rather than guessed at, and the caller falls back to the guide crop.
        const decodedPortrait = source.rows >= source.cols;
        const reportedPortrait = working.height >= working.width;
        if (decodedPortrait !== reportedPortrait) {
            return finish({
                status: 'unavailable',
                detail: `frame decoded as ${source.cols}×${source.rows}, camera reported ${working.width}×${working.height}`,
                candidates: 0,
                crop: null,
            });
        }

        return finish(detectFromFrame(bindings, source));
    } catch (error) {
        return finish({
            status: 'failed',
            detail: error instanceof Error ? error.message : String(error),
            candidates: 0,
            crop: null,
        });
    } finally {
        source?.release();
        if (working !== null && working.temporary) {
            // The reduced frame has served its purpose either way: a rectified card is
            // read from the card image, and a failed detection falls back to the
            // full-resolution capture, not to this.
            removeQuietly(working.uri);
        }
    }
}

/**
 * Runs the detector's passes over a decoded frame and rectifies the winner.
 *
 * Everything it allocates is released before it returns: a 1440 px frame is
 * roughly 8 MB of native memory per `Mat`, and scans run every couple of seconds
 * while Auto is on.
 */
function detectFromFrame(
    bindings: OpenCvModule,
    source: MatHandle,
): Omit<CardDetection, 'durationMs'> {
    const {
        OpenCV,
        BorderTypes,
        ColorConversionCodes,
        ContourApproximationModes,
        DataTypes,
        InterpolationFlags,
        MorphShapes,
        RetrievalModes,
    } = bindings;

    const frames: Array<{ release: () => void }> = [];
    const keep = <T extends { release: () => void }>(mat: T): T => {
        frames.push(mat);
        return mat;
    };

    try {
        const detectWidth = Math.min(DETECTION_WIDTH, source.cols);
        const detectHeight = Math.max(1, Math.round((source.rows * detectWidth) / source.cols));
        const toSourceScale = source.cols / detectWidth;

        const small = keep(OpenCV.Mat.create(0, 0, DataTypes.CV_8UC3));
        OpenCV.resize(
            source,
            small,
            OpenCV.Size.create(detectWidth, detectHeight),
            0,
            0,
            InterpolationFlags.INTER_AREA,
        );

        const gray = keep(OpenCV.Mat.create(0, 0, DataTypes.CV_8UC1));
        OpenCV.cvtColor(small, gray, ColorConversionCodes.COLOR_BGR2GRAY);

        const blurred = keep(OpenCV.Mat.create(0, 0, DataTypes.CV_8UC1));
        OpenCV.GaussianBlur(gray, blurred, OpenCV.Size.create(5, 5), 0);

        const edges = keep(OpenCV.Mat.create(0, 0, DataTypes.CV_8UC1));
        OpenCV.Canny(blurred, edges, CANNY_LOW, CANNY_HIGH);

        const kernel = keep(
            OpenCV.getStructuringElement(
                MorphShapes.MORPH_RECT,
                OpenCV.Size.create(EDGE_DILATE_SIZE, EDGE_DILATE_SIZE),
            ),
        );
        const border = keep(OpenCV.Mat.create(0, 0, DataTypes.CV_8UC1));
        OpenCV.dilate(
            edges,
            border,
            kernel,
            OpenCV.Point.create(-1, -1),
            1,
            BorderTypes.BORDER_CONSTANT,
            OpenCV.Scalar.create(0),
        );

        const contours = keep(OpenCV.PointVectorOfVectors.create());
        OpenCV.findContours(
            border,
            contours,
            RetrievalModes.RETR_EXTERNAL,
            ContourApproximationModes.CHAIN_APPROX_SIMPLE,
        );

        const candidates = collectCandidates(bindings, contours, {
            detectWidth,
            detectHeight,
            toSourceScale,
            sourceWidth: source.cols,
            sourceHeight: source.rows,
        });

        const best = chooseBestQuad(candidates);
        if (best === null) {
            return {
                status: 'no-card',
                detail:
                    candidates.length === 0
                        ? 'no four-sided shape in frame'
                        : `no card among ${candidates.length} candidate${candidates.length === 1 ? '' : 's'}`,
                candidates: candidates.length,
                crop: null,
            };
        }

        const crop = rectify(bindings, keep, source, best);
        return {
            status: 'detected',
            detail: `score ${best.score.score.toFixed(2)} · ${crop.width}×${crop.height} · ${candidates.length} candidate${candidates.length === 1 ? '' : 's'}`,
            candidates: candidates.length,
            crop,
        };
    } finally {
        for (const frame of frames) frame.release();
    }
}

/** Turns every four-sided contour into a scored candidate, to be ranked later. */
function collectCandidates(
    bindings: OpenCvModule,
    contours: ReturnType<OpenCvModule['OpenCV']['PointVectorOfVectors']['create']>,
    frame: {
        detectWidth: number;
        detectHeight: number;
        toSourceScale: number;
        sourceWidth: number;
        sourceHeight: number;
    },
): QuadCandidate[] {
    const { OpenCV } = bindings;
    const candidates: QuadCandidate[] = [];
    const minPerimeter =
        MIN_CONTOUR_PERIMETER_FRACTION * 2 * (frame.detectWidth + frame.detectHeight);

    for (let index = 0; index < contours.length; index += 1) {
        const contour = contours.get(index);
        const perimeter = OpenCV.arcLength(contour, true).value;
        if (perimeter < minPerimeter) continue;

        const approximated = OpenCV.PointVector.create();
        try {
            // A fraction of the perimeter rather than a fixed number of pixels, so the
            // same tolerance fits a card near the camera and one across the table.
            OpenCV.approxPolyDP(contour, approximated, APPROX_EPSILON_FRACTION * perimeter, true);
            if (approximated.length !== 4) continue;

            const points: Point[] = approximated.getAll().map((point) => ({ x: point.x, y: point.y }));
            const ordered = orderQuad(points);
            if (ordered === null) continue;

            // Back into the working frame's pixels: the corners are what everything
            // else is measured and cropped from, and detection ran on a shrunk copy.
            const quad = scaleQuad(ordered, frame.toSourceScale);
            candidates.push({
                quad,
                score: scoreQuad(quad, { width: frame.sourceWidth, height: frame.sourceHeight }),
            });
        } finally {
            approximated.release();
        }
    }

    return candidates;
}

/**
 * Undoes the perspective of the winning quad and writes the card to a file.
 *
 * The output size comes from the quad, and its *proportions* come from the card
 * itself — which is the whole point of doing this rather than cropping: the
 * result is not merely the card's pixels, it is the card as if photographed flat
 * and square, which is what makes one fixed label strip correct for every scan.
 */
function rectify(
    bindings: OpenCvModule,
    keep: <T extends { release: () => void }>(mat: T) => T,
    source: MatHandle,
    best: QuadCandidate,
): CardCrop {
    const { OpenCV, BorderTypes, DataTypes, DecompTypes, InterpolationFlags } = bindings;

    const size = warpSizeForQuad(best.quad);
    const grown = expandQuad(best.quad, QUAD_GROWTH_FRACTION);

    const from = keep(OpenCV.Point2fVector.create());
    const to = keep(OpenCV.Point2fVector.create());
    for (let index = 0; index < 4; index += 1) {
        const corner = grown[index]!;
        from.push(OpenCV.Point2f.create(corner.x, corner.y));
    }
    const target: ReadonlyArray<Point> = [
        { x: 0, y: 0 },
        { x: size.width, y: 0 },
        { x: size.width, y: size.height },
        { x: 0, y: size.height },
    ];
    for (const corner of target) to.push(OpenCV.Point2f.create(corner.x, corner.y));

    const transform = keep(OpenCV.getPerspectiveTransform(from, to, DecompTypes.DECOMP_LU));

    const rectified = keep(OpenCV.Mat.create(0, 0, DataTypes.CV_8UC3));
    OpenCV.warpPerspective(
        source,
        rectified,
        transform,
        OpenCV.Size.create(size.width, size.height),
        InterpolationFlags.INTER_LINEAR,
        // Anything outside the detected card is edge-of-frame background rather than
        // a hole, so extend the border instead of filling it with black: a black band
        // next to the printed number is an edge a text recogniser reacts to.
        BorderTypes.BORDER_REPLICATE,
        OpenCV.Scalar.create(0),
    );

    const cropFile = new File(Paths.cache, nextCropName());
    // PNG, not JPEG: this image is the input to text recognition on a small
    // high-contrast number, and this is the one place where re-compressing would
    // add ringing around exactly the pixels that have to be read.
    rectified.saveToFile(cropFile.uri, 'png', 1);

    // `saveToFile` reports nothing on the way out, and a crop whose file was never
    // written would fail every OCR pass that reads it. Checking here turns that
    // into one clear failure the caller can fall back from.
    if (!cropFile.exists) {
        throw new Error(`could not write the rectified card to ${cropFile.name}`);
    }
    pruneCrops(cropFile.name);

    return {
        uri: cropFile.uri,
        width: size.width,
        height: size.height,
        corners: fractionsOf(best.quad, source.cols, source.rows),
        score: best.score.score,
    };
}

/**
 * Reduces the capture to the size detection and rectification work at.
 *
 * The reduction happens here, before the frame is handed to OpenCV, for two
 * reasons: a 12-megapixel frame is ~36 MB once decoded, which is a lot to
 * allocate every 1.8 s while Auto is running, and passing it as base64 would mean
 * a multi-megabyte JavaScript string on every scan.
 */
async function reduceFrame(photo: {
    uri: string;
    width: number;
    height: number;
}): Promise<WorkingImage> {
    const width = Math.min(WORKING_WIDTH, photo.width);
    if (width >= photo.width) {
        // Already small enough; the capture itself is used, and is not ours to delete.
        return { uri: photo.uri, width: photo.width, height: photo.height, temporary: false };
    }

    const reduced = await manipulateAsync(photo.uri, [{ resize: { width } }], {
        // High quality, because the number is small and this is a second generation
        // of compression on an image that is about to be rectified and read.
        format: SaveFormat.JPEG,
        compress: 0.95,
    });

    return { uri: reduced.uri, width: reduced.width, height: reduced.height, temporary: true };
}

/** Converts a quad in source pixels into fractions of the frame. */
function fractionsOf(quad: Quad, width: number, height: number): Quad {
    const fraction = (point: Point): Point => ({ x: point.x / width, y: point.y / height });
    return [fraction(quad[0]), fraction(quad[1]), fraction(quad[2]), fraction(quad[3])];
}

let cropSequence = 0;

/**
 * A fresh name for a rectified card.
 *
 * The timestamp is fixed-width in base 36 until well past this app's lifetime, so
 * sorting these names sorts them chronologically — which is all {@link pruneCrops}
 * needs. The sequence suffix exists only so two crops written in the same
 * millisecond cannot claim the same name and overwrite each other.
 */
function nextCropName(): string {
    cropSequence += 1;
    return `${CROP_FILE_PREFIX}${Date.now().toString(36)}-${cropSequence.toString(36)}.png`;
}

/** True for files this module wrote, and only those. */
function isCropFile(entry: File | Directory): entry is File {
    return entry instanceof File && entry.name.startsWith(CROP_FILE_PREFIX);
}

/**
 * Deletes all but the newest few rectified cards.
 *
 * A scan produces a new file, and Auto scans every 1.8 s, so without this the
 * cache would grow by a few megabytes a minute for as long as the camera is on.
 * A couple of older crops are left in place rather than deleting everything but
 * the newest, because the screen is still showing the previous one while this
 * one is being written.
 */
function pruneCrops(keepName: string): void {
    try {
        const previous = Paths.cache
            .list()
            .filter((entry): entry is File => isCropFile(entry) && entry.name !== keepName)
            .sort((a, b) => a.name.localeCompare(b.name));

        const excess = previous.length - (MAX_KEPT_CROPS - 1);
        for (const file of previous.slice(0, Math.max(0, excess))) {
            removeQuietly(file.uri);
        }
    } catch (error) {
        // Housekeeping is not worth failing a scan over.
        console.warn('Could not prune old card crops:', error);
    }
}

/** Deletes a file, ignoring the case where it is already gone. */
function removeQuietly(uri: string): void {
    try {
        const file = new File(uri);
        if (file.exists) file.delete();
    } catch (error) {
        console.warn('Could not delete', uri, error);
    }
}
