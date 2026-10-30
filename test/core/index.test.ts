/**
 * Public API tests: the promise-only `orientation()`, error propagation and the autoRotate placeholder.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { autoRotate, OrientError, orientation, orientationToString, transformFor } from "../../src/index.ts";
import { fixturesDir } from "./helpers.ts";

const workDir = await mkdtemp(join(tmpdir(), "lossless-rotate-api-"));
process.on("exit", () => {
  void rm(workDir, { recursive: true, force: true });
});

const missing = join(fixturesDir, "does-not-exist.jpg");

test("orientation() resolves with the value", async () => {
  assert.equal(await orientation(join(fixturesDir, "exif-mm-06-tag.jpg")), 6);
  assert.equal(await orientation(join(fixturesDir, "no-exif.jpg")), 0);
});

test("orientation() writes the value and reads it back", async () => {
  const target = join(workDir, "written.jpg");
  await copyFile(join(fixturesDir, "exif-ii-01-tag.jpg"), target);
  assert.equal(await orientation(target, 7), 7);
  assert.equal(await orientation(target), 7);
});

test("a failing call rejects with the OrientError code", async () => {
  await assert.rejects(orientation(missing), (error: unknown) => OrientError.is(error) && error.code === "E_CANT_OPEN");
});

test("autoRotate is exported and usable", async () => {
  const result = await autoRotate(join(fixturesDir, "orient-64x48-420-06.jpg"), join(workDir, "rotated.jpg"));
  assert.equal(result.orientation, 6);
  assert.equal(result.perfect, true);
});

test("the package surface is re-exported as documented", () => {
  assert.equal(typeof orientationToString, "function");
  assert.equal(orientationToString(1), "TopLeft");
  assert.equal(transformFor(6).primitive, "rotate90");
  const file = readFileSync(join(fixturesDir, "exif-ii-02-tag.jpg"));
  assert.equal(file.length > 0, true);
});
