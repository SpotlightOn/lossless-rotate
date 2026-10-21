/**
 * Public API tests: promise/callback duality, error propagation and the autoRotate placeholder.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { autoRotate, OrientError, orientation, orientationToString, transformFor } from "../src/index.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(testDir, "fixtures");
const packageRoot = dirname(testDir);
const workDir = await mkdtemp(join(tmpdir(), "jpegorientation-api-"));
process.on("exit", () => {
  void rm(workDir, { recursive: true, force: true });
});

const missing = join(fixturesDir, "does-not-exist.jpg");

test("orientation() resolves with the value", async () => {
  assert.equal(await orientation(join(fixturesDir, "exif-mm-06-tag.jpg")), 6);
  assert.equal(await orientation(join(fixturesDir, "no-exif.jpg")), 0);
});

test("orientation() supports the v1 callback style", async () => {
  const read = await new Promise<number | undefined>((resolve, reject) => {
    orientation(join(fixturesDir, "exif-ii-05-tag.jpg"), (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
  assert.equal(read, 5);

  const target = join(workDir, "callback-write.jpg");
  await copyFile(join(fixturesDir, "exif-ii-01-tag.jpg"), target);
  const written = await new Promise<number | undefined>((resolve, reject) => {
    orientation(target, 7, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
  assert.equal(written, 7);
  assert.equal(await orientation(target), 7);
});

test("a callback-only failure is delivered to the callback without an unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const error = await new Promise<Error | null | undefined>((resolve) => {
      void orientation(missing, (err) => resolve(err));
    });
    assert.ok(OrientError.is(error));
    assert.equal((error as OrientError).code, "E_CANT_OPEN");
    // Give the rejection a couple of turns to surface if it were unhandled.
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});

test("awaiting a failing call still throws, also when a callback is passed", async () => {
  await assert.rejects(orientation(missing), (error: unknown) => OrientError.is(error) && error.code === "E_CANT_OPEN");
  await assert.rejects(
    orientation(missing, () => {}),
    (error: unknown) => OrientError.is(error) && error.code === "E_CANT_OPEN",
  );
});

test("an exception thrown by the callback surfaces instead of being swallowed", () => {
  // Checked in a child process: the point is that the exception escapes as an uncaught exception,
  // which the test runner would otherwise report as a failure of this very test.
  const script = `
    import { orientation } from ${JSON.stringify(pathToFileURL(join(packageRoot, "src", "index.ts")).href)};
    orientation(${JSON.stringify(join(fixturesDir, "exif-ii-03-tag.jpg"))}, () => {
      throw new Error("callback bug");
    });
    keepAlive();
    function keepAlive() { setTimeout(keepAlive, 50); }
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.notEqual(child.status, 0, "the child process must fail");
  assert.match(child.stderr, /callback bug/);
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
