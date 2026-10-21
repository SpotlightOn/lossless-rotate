/**
 * End to end tests of the public API: make a JPEG upright and check what comes out.
 *
 * The pixel checks use `djpeg` when it is available (they are skipped otherwise); everything else
 * works with the package alone.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  autoRotate,
  autoRotateBuffer,
  canTransform,
  orientation,
  readOrientation,
  setOrientation,
} from "../../src/index.ts";
import { parseJpeg } from "../../src/jpeg/parse.ts";
import { transformFor } from "../../src/orientation.ts";
import { bytesOf, fixturesDir } from "../core/helpers.ts";

const workDir = await mkdtemp(join(tmpdir(), "lossless-rotate-api-"));
process.on("exit", () => {
  void rm(workDir, { recursive: true, force: true });
});

const padded = (value: number): string => String(value).padStart(2, "0");

function haveDjpeg(): boolean {
  try {
    execFileSync("djpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const HAVE_DJPEG = haveDjpeg();

function parsePpm(ppm: Buffer): { width: number; height: number; pixels: Buffer } {
  let position = 0;
  const token = (): string => {
    while ([0x20, 0x0a, 0x09].includes(ppm[position]!)) position++;
    const start = position;
    while (position < ppm.length && ![0x20, 0x0a, 0x09].includes(ppm[position]!)) position++;
    return ppm.subarray(start, position).toString("latin1");
  };
  token();
  const width = Number(token());
  const height = Number(token());
  token();
  position += 1;
  return { width, height, pixels: ppm.subarray(position, position + width * height * 3) };
}

/** Literal pixel rotation, independent of the package's own transform table. */
function rotateLiterally(
  image: { width: number; height: number; pixels: Buffer },
  primitive: string,
): { width: number; height: number; pixels: Buffer } {
  const { width, height, pixels } = image;
  const swaps = ["rotate90", "rotate270", "transpose", "transverse"].includes(primitive);
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
  return { width: outWidth, height: outHeight, pixels: out };
}

test("every orientation value ends up upright", () => {
  for (let value = 1; value <= 8; value++) {
    const source = bytesOf(`orient-64x48-420-${padded(value)}.jpg`);
    const { result, bytes } = autoRotateBuffer(source);

    assert.equal(result.orientation, value, `source orientation ${value}`);
    assert.equal(result.transform, transformFor(value).primitive, `transform for ${value}`);
    assert.equal(result.perfect, true, `perfect for ${value}`);
    assert.deepEqual(result.warnings, [], `warnings for ${value}`);
    // An already upright image is copied, everything else is re-encoded.
    assert.equal(result.copied, value === 1, `copied for ${value}`);
    if (value === 1) assert.deepEqual(bytes, source, "orientation 1 must be a byte exact copy");

    assert.equal(readOrientation(bytes), 1, `output orientation ${value}`);
    const output = parseJpeg(bytes);
    assert.equal(output.frame.progressive, false, `sequential output for ${value}`);
    assert.equal(output.frame.width, value >= 5 ? 48 : 64, `width for ${value}`);
    assert.equal(output.frame.height, value >= 5 ? 64 : 48, `height for ${value}`);
  }
});

test("the result is the rotation the orientation asks for", { skip: !HAVE_DJPEG }, () => {
  for (let value = 2; value <= 8; value++) {
    const source = bytesOf(`orient-64x48-420-${padded(value)}.jpg`);
    const { bytes } = autoRotateBuffer(source);
    const file = join(workDir, `out-${value}.jpg`);
    writeFileSync(file, bytes);

    const actual = parsePpm(execFileSync("djpeg", ["-ppm", file], { maxBuffer: 1 << 26 }));
    const expected = rotateLiterally(
      parsePpm(
        execFileSync("djpeg", ["-ppm", join(fixturesDir, `orient-64x48-420-${padded(value)}.jpg`)], {
          maxBuffer: 1 << 26,
        }),
      ),
      transformFor(value).primitive,
    );

    assert.equal(actual.width, expected.width, `orientation ${value} width`);
    assert.equal(actual.height, expected.height, `orientation ${value} height`);
    let worst = 0;
    for (let i = 0; i < actual.pixels.length; i++)
      worst = Math.max(worst, Math.abs(actual.pixels[i]! - expected.pixels[i]!));
    assert.ok(worst <= 3, `orientation ${value} deviates by ${worst}`);
  }
});

test("an upright image is copied, never re-encoded", () => {
  const source = bytesOf("orient-64x48-420-01.jpg");
  const { result, bytes } = autoRotateBuffer(source);
  assert.equal(result.copied, true);
  assert.deepEqual(bytes, source);

  const withoutExif = bytesOf("base/pattern-64x48-420.jpg");
  const second = autoRotateBuffer(withoutExif);
  assert.equal(second.result.orientation, 0);
  assert.equal(second.result.copied, true);
  assert.deepEqual(second.bytes, withoutExif);
});

test("an image whose dimensions are not MCU aligned is transformed and reported", () => {
  const source = bytesOf("orient-41x27-420-06.jpg");
  const { result } = autoRotateBuffer(source);
  assert.equal(result.perfect, false);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /not multiples of the MCU size/);
  assert.match(result.warnings[0]!, /41x27/);

  assert.throws(
    () => autoRotateBuffer(source, { onImperfect: "error" }),
    (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error);
      assert.equal((error as { code: string }).code, "E_UNSUPPORTED");
      return true;
    },
  );
});

test("progressive input is decoded and written sequentially", () => {
  const source = bytesOf("orient-64x48-progressive-420-06.jpg");
  const { result, bytes } = autoRotateBuffer(source);
  assert.ok(
    result.warnings.some((warning) => warning.includes("progressive")),
    "must mention progressive",
  );
  assert.equal(result.perfect, true);
  assert.equal(parseJpeg(bytes).frame.progressive, false);
  assert.equal(readOrientation(bytes), 1);
});

test("metadata can be dropped on request", () => {
  const source = bytesOf("orient-64x48-420-06.jpg");
  const withMetadata = parseJpeg(autoRotateBuffer(source).bytes);
  assert.ok(
    withMetadata.preserved.some((segment) => segment.marker === 0xe1),
    "Exif is kept by default",
  );

  const withoutMetadata = parseJpeg(autoRotateBuffer(source, { keepMetadata: false }).bytes);
  assert.deepEqual(withoutMetadata.preserved, [], "no APPn/COM when asked to drop them");
});

test("autoRotate works on files", async () => {
  const source = join(workDir, "source.jpg");
  const destination = join(workDir, "destination.jpg");
  await copyFile(join(fixturesDir, "orient-64x48-420-06.jpg"), source);

  const result = await autoRotate(source, destination);
  assert.equal(result.orientation, 6);
  assert.equal(result.perfect, true);
  assert.equal(await orientation(destination), 1);
  assert.equal(await orientation(source), 6, "the source must not be modified");

  const buffer = await readFile(destination);
  assert.deepEqual(buffer, autoRotateBuffer(await readFile(source)).bytes);

  await assert.rejects(autoRotate(join(workDir, "missing.jpg"), destination), (error: unknown) => {
    assert.ok(error instanceof Error && "code" in error);
    assert.equal((error as { code: string }).code, "E_CANT_OPEN");
    return true;
  });
});

test("the metadata helpers work on buffers", () => {
  const source = bytesOf("base/pattern-64x48-420.jpg");
  const withTag = setOrientation(source, 6);
  assert.equal(readOrientation(withTag), 6);
  assert.equal(canTransform(withTag), true);
  assert.equal(canTransform(Buffer.from("not a jpeg")), false);
});

test("readJpeg is exported and maps a missing file onto E_CANT_OPEN", async () => {
  const { readJpeg } = await import("../../src/index.ts");
  const bytes = await readJpeg(join(fixturesDir, "orient-64x48-420-06.jpg"));
  assert.equal(readOrientation(bytes), 6);
  await assert.rejects(readJpeg(join(workDir, "nope.jpg")), (error: unknown) => {
    assert.ok(error instanceof Error && "code" in error);
    assert.equal((error as { code: string }).code, "E_CANT_OPEN");
    return true;
  });
});
