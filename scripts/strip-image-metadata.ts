#!/usr/bin/env node
/**
 * Removes metadata segments from a JPEG without re-encoding it.
 *
 * Camera photos carry EXIF: make, model, software, timestamps and usually a GPS
 * position. That is a lot of personal information to publish in a repository,
 * and none of it is needed by a test fixture. This drops those segments straight
 * out of the byte stream, so the compressed image data is untouched and the
 * picture is bit-for-bit identical once decoded.
 *
 * Usage:
 *   node scripts/strip-image-metadata.ts <input.jpg> <output.jpg>
 *
 * Why not the obvious tools:
 *  - `ffmpeg -map_metadata -1 -c copy` does **not** work. EXIF lives inside the
 *    JPEG bitstream as an APP1 segment, not in container metadata, so a stream
 *    copy preserves it byte-for-byte.
 *  - Re-encoding (`-c:v mjpeg`) does strip it, but degrades the image. That
 *    matters here because `testImage/ogn-160.jpg` exists to be a genuine camera
 *    photo used to measure card geometry.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const [, , inputPath, outputPath] = process.argv;
if (inputPath === undefined || outputPath === undefined) {
  console.error('usage: node scripts/strip-image-metadata.ts <input.jpg> <output.jpg>');
  process.exit(1);
}

const buf = readFileSync(inputPath);

// APP0 (JFIF) declares the version and pixel density, and APP2 holds the ICC
// colour profile. Both are structural — dropping the ICC profile can shift
// colours — so they are deliberately preserved.
const KEEP = new Set([0xe0, 0xe2]);

if (buf[0] !== 0xff || buf[1] !== 0xd8) {
  throw new Error(`${inputPath} is not a JPEG (missing SOI marker)`);
}

const out: Buffer[] = [buf.subarray(0, 2)];
const dropped: string[] = [];
let i = 2;

while (i < buf.length - 1) {
  if (buf[i] !== 0xff) {
    throw new Error(`expected a marker at offset ${i}, found 0x${buf[i]?.toString(16)}`);
  }
  const marker = buf[i + 1] as number;

  // Start of scan: everything from here is entropy-coded image data. Copy the
  // remainder verbatim and stop.
  if (marker === 0xda) {
    out.push(buf.subarray(i));
    break;
  }
  // Standalone markers carry no payload.
  if (marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd8)) {
    out.push(buf.subarray(i, i + 2));
    i += 2;
    continue;
  }

  const length = buf.readUInt16BE(i + 2);
  const segment = buf.subarray(i, i + 2 + length);
  const isApp = marker >= 0xe0 && marker <= 0xef;

  if (isApp && !KEEP.has(marker)) {
    // APP1 = EXIF/XMP, APP13 = IPTC, APP14 = Adobe, plus anything else a camera
    // or editor attached.
    dropped.push(`APP${marker - 0xe0} (0xFF${marker.toString(16).toUpperCase()}, ${length} bytes)`);
  } else {
    out.push(segment);
  }

  i += 2 + length;
}

const result = Buffer.concat(out);
writeFileSync(outputPath, result);

console.log(`input:  ${inputPath} (${buf.length} bytes)`);
console.log(`output: ${outputPath} (${result.length} bytes)`);
if (dropped.length === 0) {
  console.log('no metadata segments found — nothing to remove');
} else {
  console.log('removed:');
  for (const entry of dropped) console.log('  ' + entry);
}
