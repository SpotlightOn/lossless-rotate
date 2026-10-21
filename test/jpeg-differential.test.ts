/**
 * Differential test against the reference implementation.
 *
 * jpegtran performs the same coefficient-domain transform, so for a *perfect* transform the decoded
 * result has to be byte-identical to ours - not "close", identical. That is the strongest statement
 * available about this package's core promise, and it is checked against a completely independent
 * implementation.
 *
 * The test needs `jpegtran` and `djpeg` on PATH (libjpeg-turbo); it skips itself when they are
 * missing, so `npm test` works everywhere.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { transformJpeg } from "../src/jpeg/codec.ts";
import { decodeCoefficients } from "../src/jpeg/decoder.ts";
import { parseJpeg } from "../src/jpeg/parse.ts";
import type { OrientationPrimitive } from "../src/orientation.ts";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const workDir = mkdtempSync(join(tmpdir(), "lossless-rotate-diff-"));
process.on("exit", () => rmSync(workDir, { recursive: true, force: true }));

function available(command: string): boolean {
  try {
    execFileSync(command, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    try {
      execFileSync("which", [command], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
}

const HAVE_TOOLS = available("jpegtran") && available("djpeg");

const TRANSFORMS: [OrientationPrimitive, string[]][] = [
  ["flipHorizontal", ["-flip", "horizontal"]],
  ["flipVertical", ["-flip", "vertical"]],
  ["rotate180", ["-rotate", "180"]],
  ["rotate90", ["-rotate", "90"]],
  ["rotate270", ["-rotate", "270"]],
  ["transpose", ["-transpose"]],
  ["transverse", ["-transverse"]],
];

const IMAGES = [
  "base/pattern-64x48-420.jpg",
  "base/pattern-64x48-422.jpg",
  "base/pattern-64x48-444.jpg",
  "base/pattern-64x48-progressive-420.jpg",
  "base/pattern-8x8-444.jpg",
  "base/pattern-41x27-420.jpg",
  "base/pattern-8x8-420.jpg",
];

const decode = (file: string): Buffer => execFileSync("djpeg", ["-ppm", file], { maxBuffer: 1 << 28 });

interface Ppm {
  header: string;
  width: number;
  height: number;
  pixels: Buffer;
}

function parsePpm(ppm: Buffer): Ppm {
  let position = 0;
  const token = (): string => {
    while (ppm[position] === 0x20 || ppm[position] === 0x0a || ppm[position] === 0x09) position++;
    const start = position;
    while (position < ppm.length && ![0x20, 0x0a, 0x09].includes(ppm[position]!)) position++;
    return ppm.subarray(start, position).toString("latin1");
  };
  const magic = token();
  const width = Number(token());
  const height = Number(token());
  token(); // maxval
  position += 1;
  return {
    header: `${magic} ${width} ${height}`,
    width,
    height,
    pixels: ppm.subarray(position, position + width * height * 3),
  };
}

/** A literal, pixel-domain rotation of a decoded image, used as a second, independent oracle. */
function rotatePixels(image: Ppm, primitive: OrientationPrimitive): Ppm {
  const { width, height, pixels } = image;

  const swaps =
    primitive === "rotate90" || primitive === "rotate270" || primitive === "transpose" || primitive === "transverse";
  const outWidth = swaps ? height : width;
  const outHeight = swaps ? width : height;
  const out = Buffer.alloc(outWidth * outHeight * 3);

  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      let sx: number;
      let sy: number;
      switch (primitive) {
        case "flipHorizontal":
          sx = width - 1 - x;
          sy = y;
          break;
        case "flipVertical":
          sx = x;
          sy = height - 1 - y;
          break;
        case "rotate180":
          sx = width - 1 - x;
          sy = height - 1 - y;
          break;
        case "rotate90":
          sx = y;
          sy = height - 1 - x;
          break;
        case "rotate270":
          sx = width - 1 - y;
          sy = x;
          break;
        case "transpose":
          sx = y;
          sy = x;
          break;
        default:
          sx = width - 1 - y;
          sy = height - 1 - x;
          break;
      }
      pixels.subarray((sy * width + sx) * 3, (sy * width + sx) * 3 + 3).copy(out, (y * outWidth + x) * 3);
    }
  }
  return { header: `P6 ${outWidth} ${outHeight}`, width: outWidth, height: outHeight, pixels: out };
}

test("perfect transforms are byte-identical to jpegtran's output", { skip: !HAVE_TOOLS }, () => {
  let compared = 0;
  for (const file of IMAGES) {
    const source = readFileSync(join(fixturesDir, file));
    for (const [primitive, args] of TRANSFORMS) {
      const result = transformJpeg(source, { primitive });
      if (!result.perfect) continue;

      const mine = join(workDir, "mine.jpg");
      const theirs = join(workDir, "theirs.jpg");
      writeFileSync(mine, result.bytes);
      execFileSync("jpegtran", [...args, "-outfile", theirs, join(fixturesDir, file)]);

      assert.deepEqual(decode(mine), decode(theirs), `${file} ${primitive} must decode exactly like jpegtran's output`);
      compared++;
    }
  }
  assert.ok(compared >= 30, `expected to compare a meaningful number of transforms, got ${compared}`);
});

test("perfect transforms reproduce a literal pixel rotation", { skip: !HAVE_TOOLS }, () => {
  for (const file of IMAGES) {
    const source = readFileSync(join(fixturesDir, file));
    const decodedSource = parsePpm(decode(join(fixturesDir, file)));
    for (const [primitive] of TRANSFORMS) {
      const result = transformJpeg(source, { primitive });
      if (!result.perfect) continue;

      const mine = join(workDir, "mine.jpg");
      writeFileSync(mine, result.bytes);
      const actual = parsePpm(decode(mine));
      const expected = rotatePixels(decodedSource, primitive);
      assert.equal(actual.header, expected.header, `${file} ${primitive} dimensions`);

      // The coefficients are exact (see jpeg-transform.test.ts); what is left is the decoder's IDCT
      // rounding, which is not perfectly symmetric under transposition. jpegtran's own output
      // shows the same deviation, so a small tolerance is the right assertion here.
      let worst = 0;
      for (let i = 0; i < actual.pixels.length; i++)
        worst = Math.max(worst, Math.abs(actual.pixels[i]! - expected.pixels[i]!));
      assert.ok(worst <= 3, `${file} ${primitive}: deviates by ${worst} from a literal pixel rotation`);
    }
  }
});

test("a progressive file decodes to jpegtran's coefficients", { skip: !HAVE_TOOLS }, () => {
  // jpegtran transcodes progressive input to sequential without touching a coefficient, so its
  // output is ground truth for the progressive decoder. Comparing coefficients - not pixels - pins
  // the decode exactly and would catch a desync (e.g. a Huffman table that is redefined between
  // scans, which this file does four times).
  const progressive = "base/pattern-64x48-progressive-420.jpg";
  const sequential = join(workDir, "transcoded.jpg");
  execFileSync("jpegtran", ["-outfile", sequential, join(fixturesDir, progressive)]);

  const mine = decodeCoefficients(parseJpeg(readFileSync(join(fixturesDir, progressive))));
  const theirs = decodeCoefficients(parseJpeg(readFileSync(sequential)));

  assert.equal(mine.length, theirs.length, "component count");
  for (let index = 0; index < mine.length; index++) {
    assert.equal(mine[index]!.component.id, theirs[index]!.component.id, `component ${index} id`);
    assert.deepEqual([...mine[index]!.blocks], [...theirs[index]!.blocks], `component ${index} coefficients`);
  }
});

test("imperfect transforms keep the geometry of jpegtran's output", { skip: !HAVE_TOOLS }, () => {
  let compared = 0;
  for (const file of IMAGES) {
    const source = readFileSync(join(fixturesDir, file));
    for (const [primitive, args] of TRANSFORMS) {
      const result = transformJpeg(source, { primitive });
      if (result.perfect) continue;

      const mine = join(workDir, "mine.jpg");
      const theirs = join(workDir, "theirs.jpg");
      writeFileSync(mine, result.bytes);
      execFileSync("jpegtran", [...args, "-outfile", theirs, join(fixturesDir, file)]);

      assert.equal(parsePpm(decode(mine)).header, parsePpm(decode(theirs)).header, `${file} ${primitive} dimensions`);
      assert.ok(
        result.warnings.some((warning) => warning.includes("not multiples of the MCU size")),
        `${file} ${primitive} warning`,
      );
      compared++;
    }
  }
  assert.ok(compared >= 5, `expected some imperfect cases, got ${compared}`);
});
