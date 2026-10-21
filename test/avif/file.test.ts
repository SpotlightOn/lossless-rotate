/**
 * The AVIF side of the shared entry points: `writeOrientationToFile`, `readOrientationFromFile`,
 * `orientation()` and the `autoRotate` refusal. These are the places where a format-blind API meets
 * a format that cannot be rotated, so they are kept next to the AVIF layer rather than in the JPEG
 * file tests.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { copyFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { autoRotateBuffer, canTransform, setOrientation } from "../../src/autoRotate.ts";
import { setAvifOrientation } from "../../src/avif/orientation.ts";
import { readOrientationFromFile, writeOrientationToFile } from "../../src/file.ts";
import { orientation } from "../../src/index.ts";
import { bytesOf, differingOffsets, errorCodeOf, errorCodeOfAsync, pathOf } from "../core/helpers.ts";
import { boxesIn, first, ilocExtentOf, imageDataOf, workDir } from "./helpers.ts";

test("the file layer rewrites the whole file and keeps the image data", async () => {
  const target = join(workDir, "base.avif");
  await copyFile(pathOf("avif/base.avif"), target);
  const before = await readFile(target);
  const result = await writeOrientationToFile(target, 6);
  const after = await readFile(target);

  assert.equal(result.previousValue, null, "there was no orientation to report");
  assert.equal(result.value, 6);
  assert.equal(result.size, after.length, "the reported size must be the size on disk");
  assert.equal((await stat(target)).size, after.length);
  assert.ok(after.length > before.length, "adding irot grows the file");
  assert.equal(await readOrientationFromFile(target), 6);
  assert.deepEqual(differingOffsets(after, setAvifOrientation(before, 6)), [], "both write paths agree");
  assert.deepEqual(imageDataOf(after), imageDataOf(before), "the image data must be untouched");
  assert.equal(ilocExtentOf(after), first(boxesIn(after, 0, after.length), "mdat").bodyOffset, "iloc must be fixed up");

  // Writing the value that is already there leaves the file byte for byte alone.
  const stable = await writeOrientationToFile(target, 6);
  assert.equal(stable.size, after.length);
  assert.deepEqual(differingOffsets(await readFile(target), after), [], "a no-op write must not change bytes");

  // Back to upright: irot 0 is still a property, so the file does not shrink back to the original.
  const upright = await writeOrientationToFile(target, 1);
  assert.equal(await readOrientationFromFile(target), 1);
  assert.deepEqual(imageDataOf(await readFile(target)), imageDataOf(before));
  assert.equal(upright.size, (await readFile(target)).length);
});

test("the file layer refuses a file that only looks like an AVIF", async () => {
  const target = join(workDir, "not-avif.avif");
  await copyFile(pathOf("avif/err-not-avif.avif"), target);
  assert.equal(await errorCodeOfAsync(() => writeOrientationToFile(target, 6)), "E_UNSUPPORTED_FORMAT");
});

test("orientation() reads and writes AVIF files like it does JPEG", async () => {
  const target = join(workDir, "api.avif");
  await copyFile(pathOf("avif/irot-3.avif"), target);
  assert.equal(await orientation(target), 6);
  assert.equal(await orientation(target, 8), 8);
  assert.equal(await orientation(target), 8);

  const plain = join(workDir, "api-plain.avif");
  await copyFile(pathOf("avif/base.avif"), plain);
  assert.equal(await orientation(plain), 0);
  assert.equal(await orientation(plain, 6), 6);
  assert.equal(await orientation(plain), 6);
  assert.deepEqual(setOrientation(bytesOf("avif/base.avif"), 6), setAvifOrientation(bytesOf("avif/base.avif"), 6));
});

test("AVIF cannot be rotated", () => {
  const base = bytesOf("avif/irot-3.avif");
  assert.equal(canTransform(base), false);
  assert.equal(
    errorCodeOf(() => autoRotateBuffer(base)),
    "E_UNSUPPORTED",
  );
});

test("the thumbnail option does not change the AVIF refusal", () => {
  // `rotateThumbnail` is a JPEG concern; the option must not turn the refusal into a different error.
  const avif = readFileSync(pathOf("avif/base.avif"));
  assert.equal(
    errorCodeOf(() => autoRotateBuffer(avif, { rotateThumbnail: true })),
    "E_UNSUPPORTED",
  );
});
