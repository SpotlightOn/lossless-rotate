/**
 * Tests for the file-level API: the replacement for the v1 addon's fopen/fread/fwrite.
 *
 * The interesting property is that a metadata update must be indistinguishable from the original
 * file except for the orientation entry - same size, same image data, no re-encode.
 */

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { OrientError } from "../src/errors.ts";
import { buildExifApp1, readOrientation } from "../src/exif.ts";
import { readOrientationFromFile, writeOrientationToFile } from "../src/file.ts";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

interface Fixture {
  file: string;
  bytes: number;
  /** Media format of a hand-provided sample; absent for the generated JPEG fixtures. */
  format?: string;
  byteOrder?: "little" | "big";
  orientation?: number;
  entryOffset?: number;
  expect?: { read?: number; error?: string };
}

const manifest: { files: Fixture[] } = JSON.parse(readFileSync(join(fixturesDir, "manifest.json"), "utf8"));

const workDir = await mkdtemp(join(tmpdir(), "jpegorientation-"));
process.on("exit", () => {
  void rm(workDir, { recursive: true, force: true });
});

async function staged(fixture: string): Promise<string> {
  const target = join(workDir, fixture);
  await copyFile(join(fixturesDir, fixture), target);
  return target;
}

function differingOffsets(left: Uint8Array, right: Uint8Array): number[] {
  const offsets: number[] = [];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] !== right[i]) offsets.push(i);
  }
  return offsets;
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (OrientError.is(error)) return error.code;
    if (error instanceof Error) return `${error.name}: ${error.message}`;
    return String(error);
  }
  return "<no error>";
}

test("reads the orientation of every readable fixture from disk", async () => {
  for (const fixture of manifest.files) {
    if (fixture.expect?.read === undefined) continue;
    assert.equal(await readOrientationFromFile(join(fixturesDir, fixture.file)), fixture.expect.read, fixture.file);
  }
});

test("surfaces missing and unreadable files as E_CANT_OPEN, like v1's -1", async () => {
  assert.equal(await codeOf(() => readOrientationFromFile(join(fixturesDir, "does-not-exist.jpg"))), "E_CANT_OPEN");
  assert.equal(await codeOf(() => writeOrientationToFile(join(fixturesDir, "does-not-exist.jpg"), 3)), "E_CANT_OPEN");
  await mkdir(join(workDir, "a-directory"), { recursive: true });
  assert.equal(await codeOf(() => readOrientationFromFile(join(workDir, "a-directory"))), "E_CANT_OPEN");
});

test("reports a truncated file as E_PREMATURE_END", async () => {
  await assert.rejects(readOrientationFromFile(join(fixturesDir, "err-soi-truncated.jpg")), (error: unknown) => {
    assert.ok(OrientError.is(error));
    assert.equal(error.code, "E_PREMATURE_END");
    return true;
  });
});

test("updates the orientation on disk without changing the file size or the image data", async () => {
  for (const fixture of manifest.files.filter((f) => f.entryOffset !== undefined)) {
    const target = await staged(fixture.file);
    const before = await readFile(target);
    const entryOffset = fixture.entryOffset ?? 0;

    for (const value of [1, 5, 8]) {
      const result = await writeOrientationToFile(target, value);
      const after = await readFile(target);
      const label = `${fixture.file} -> ${value}`;

      assert.equal(result.value, value, label);
      assert.equal(result.size, before.length, `${label}: size reported`);
      assert.equal(after.length, before.length, `${label}: size on disk`);
      assert.equal((await stat(target)).size, before.length, `${label}: stat size`);
      assert.equal(readOrientation(after), value, `${label}: read back`);

      for (const offset of differingOffsets(before, after)) {
        assert.ok(
          offset >= entryOffset + 2 && offset < entryOffset + 12,
          `${label}: byte ${offset} outside the orientation entry`,
        );
      }
    }
  }
});

test("a failed update leaves the file untouched", async () => {
  const target = await staged("exif-without-orientation.jpg");
  const before = await readFile(target);
  assert.equal(await codeOf(() => writeOrientationToFile(target, 3)), "E_INVALID_EXIF");
  assert.deepEqual(differingOffsets(before, await readFile(target)), []);
});

test("finds and updates EXIF beyond the first read window", async () => {
  // Two oversized APP2 chunks push the Exif block past the initial 64 KiB window, so both the read
  // and the write path have to widen it.
  const base = readFileSync(join(fixturesDir, "no-exif.jpg"));
  const app0Length = base.readUInt16BE(4) + 2;
  const padding = Buffer.concat([
    Buffer.from([0xff, 0xe2, 0xfe, 0x00]),
    Buffer.alloc(0xfe00 - 2, 0x42),
    Buffer.from([0xff, 0xe2, 0xfe, 0x00]),
    Buffer.alloc(0xfe00 - 2, 0x42),
  ]);
  const withExif = Buffer.concat([
    base.subarray(0, 2 + app0Length),
    padding,
    buildExifApp1(6),
    base.subarray(2 + app0Length),
  ]);
  assert.ok(withExif.length > 130_000, `expected a file beyond the first window, got ${withExif.length}`);

  const target = join(workDir, "large-padding.jpg");
  writeFileSync(target, withExif);

  assert.equal(await readOrientationFromFile(target), 6);
  const result = await writeOrientationToFile(target, 3);
  assert.equal(result.entryOffset, 2 + app0Length + padding.length + 4 + 6 + 8 + 2);
  assert.equal(await readOrientationFromFile(target), 3);
  assert.equal((await stat(target)).size, withExif.length);
});

test("reads a small file that is entirely inside the first window", async () => {
  const target = await staged("exif-ii-06-make.jpg");
  assert.equal(await readOrientationFromFile(target), 6);
});
