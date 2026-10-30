/**
 * Tests for the pure-JavaScript EXIF layer.
 *
 * The fixture manifest is the oracle: it records where the orientation entry sits in each file and
 * which value the file was built with, so the "did the writer touch anything else?" question can be
 * answered byte by byte instead of by eyeballing.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildExifApp1,
  insertOrientation,
  locateOrientation,
  orientationToString,
  patchOrientation,
  readOrientation,
} from "../../src/exif.ts";
import { bytesOf, differingOffsets, errorCodeOf, fixturesDir, pathOf } from "../core/helpers.ts";

interface Fixture {
  file: string;
  bytes: number;
  /** Media format of a hand-provided sample; absent for the generated JPEG fixtures. */
  format?: string;
  byteOrder?: "little" | "big";
  orientation?: number;
  entryOffset?: number;
  kind?: string;
  layout?: string;
  comment?: string;
  expect?: { read?: number; error?: string };
}

interface Manifest {
  files: Fixture[];
  baseSegments: { jfif: string; tail: string };
}

const manifest: Manifest = JSON.parse(readFileSync(join(fixturesDir, "manifest.json"), "utf8"));
const fixtures = manifest.files;
const orientated = fixtures.filter((f) => f.entryOffset !== undefined);
// The AVIF fixtures are read and written by their own layer (test/avif/); this file is about JPEG
// marker layouts and the TIFF code that the two formats share.
const jpegFixtures = fixtures.filter((f) => f.format !== "avif");
const brokenFiles = jpegFixtures.filter((f) => f.expect?.error !== undefined);
const readableFiles = jpegFixtures.filter((f) => f.expect !== undefined && f.expect.read !== undefined);

test("the fixture corpus is present and self-consistent", () => {
  assert.ok(fixtures.length > 30, `expected a real corpus, got ${fixtures.length} fixtures`);
  for (const fixture of fixtures) {
    assert.equal(readFileSync(pathOf(fixture.file)).length, fixture.bytes, `${fixture.file} changed size`);
  }
  assert.equal(readableFiles.length >= 20, true, "expected a good number of readable fixtures");
  assert.ok(brokenFiles.length >= 8, "expected malformed fixtures to be covered");
});

test("reads the orientation of every readable fixture", () => {
  for (const fixture of readableFiles) {
    assert.equal(
      readOrientation(bytesOf(fixture.file)),
      fixture.expect?.read,
      `${fixture.file} (${fixture.comment ?? fixture.layout ?? ""})`,
    );
  }
});

test("rejects every malformed fixture with the documented error code", () => {
  for (const fixture of brokenFiles) {
    assert.equal(
      errorCodeOf(() => readOrientation(bytesOf(fixture.file))),
      fixture.expect?.error,
      `${fixture.file} (${fixture.comment})`,
    );
  }
});

test("locateOrientation reports byte order, entry position and current value", () => {
  for (const fixture of orientated) {
    const location = locateOrientation(bytesOf(fixture.file));
    assert.notEqual(location, null, fixture.file);
    assert.equal(location?.byteOrder, fixture.byteOrder, fixture.file);
    assert.equal(location?.entryOffset, fixture.entryOffset, fixture.file);
    assert.equal(location?.valueOffset, (fixture.entryOffset ?? 0) + 8, fixture.file);
    assert.equal(location?.format, 3, fixture.file);
    assert.equal(location?.count, 1, fixture.file);
    assert.equal(location?.value, fixture.orientation, fixture.file);
  }
});

test("patching rewrites exactly the 10 bytes of the IFD entry and nothing else", () => {
  for (const fixture of orientated) {
    for (let target = 1; target <= 8; target++) {
      const original = bytesOf(fixture.file);
      const patched = Buffer.from(original);
      const result = patchOrientation(patched, target);

      const entryOffset = fixture.entryOffset ?? 0;
      const label = `${fixture.file} -> ${target}`;

      assert.equal(result.byteOrder, fixture.byteOrder, label);
      assert.equal(result.entryOffset, entryOffset, label);
      assert.equal(result.writtenOffset, entryOffset + 2, label);
      assert.equal(result.writtenLength, 10, label);
      assert.equal(result.previousValue, fixture.orientation, label);
      assert.equal(result.value, target, label);
      assert.equal(patched.length, original.length, `${label}: size changed`);

      const changed = differingOffsets(original, patched);
      if (target === fixture.orientation) {
        assert.deepEqual(changed, [], `${label}: writing the current value must not change bytes`);
      } else {
        assert.ok(changed.length > 0, `${label}: nothing changed`);
      }
      for (const offset of changed) {
        assert.ok(
          offset >= entryOffset + 2 && offset < entryOffset + 12,
          `${label}: byte ${offset} outside the orientation entry [${entryOffset + 2}, ${entryOffset + 12})`,
        );
      }

      assert.equal(readOrientation(patched), target, `${label}: read back`);
    }
  }
});

test("patching is idempotent and keeps the entry format stable", () => {
  const original = bytesOf("exif-mm-06-tag.jpg");
  const once = Buffer.from(original);
  patchOrientation(once, 3);
  const twice = Buffer.from(once);
  patchOrientation(twice, 3);
  assert.deepEqual(differingOffsets(once, twice), [], "second write with the same value must not change bytes");

  // The writer sets format = SHORT and count = 1 by hand; keep that so byte diffs stay identical.
  const location = locateOrientation(once);
  assert.equal(location?.format, 3);
  assert.equal(location?.count, 1);
});

test("writes are validated", () => {
  const buffer = bytesOf("exif-ii-06-tag.jpg");
  for (const bad of [0, 9, -1, 2.5, Number.NaN]) {
    assert.equal(
      errorCodeOf(() => patchOrientation(Buffer.from(buffer), bad)),
      "E_INVALID_VALUE",
      `value ${bad}`,
    );
  }
});

test("patching a file without an orientation tag fails instead of silently doing nothing", () => {
  const buffer = bytesOf("exif-without-orientation.jpg");
  assert.equal(
    errorCodeOf(() => patchOrientation(Buffer.from(buffer), 3)),
    "E_INVALID_EXIF",
  );
  assert.equal(readOrientation(buffer), 0);
});

test("a stored value that a reader rejects can still be repaired", () => {
  const original = bytesOf("err-orientation-value-9.jpg");
  assert.equal(
    errorCodeOf(() => readOrientation(original)),
    "E_INVALID_EXIF",
  );

  const patched = Buffer.from(original);
  const result = patchOrientation(patched, 3);
  assert.equal(result.previousValue, null, "an invalid stored value must be reported as null");
  assert.equal(result.value, 3);
  assert.equal(readOrientation(patched), 3, "the file must be readable again");
});

test("a value field that is wider than one byte is rejected on read but repairable", () => {
  const original = bytesOf("exif-ii-06-tag.jpg");
  const tampered = Buffer.from(original);
  const location = locateOrientation(tampered);
  assert.ok(location);
  tampered[(location?.valueOffset ?? 0) + 1] = 0x01; // high byte of the inline value

  assert.equal(
    errorCodeOf(() => readOrientation(tampered)),
    "E_INVALID_EXIF",
  );
  assert.equal(locateOrientation(tampered, { strictValue: false })?.valueValid, false);
  assert.equal(locateOrientation(tampered, { strictValue: false })?.value, 6, "the low byte is still reported");

  const repaired = Buffer.from(tampered);
  patchOrientation(repaired, 8);
  assert.equal(readOrientation(repaired), 8);
});

test("accepts any Uint8Array view, not just Buffer", () => {
  const buffer = new Uint8Array(bytesOf("exif-ii-06-tag.jpg"));
  assert.equal(readOrientation(buffer), 6);
});

test("buildExifApp1 produces a segment the reader accepts", () => {
  for (const byteOrder of ["little", "big"] as const) {
    for (let value = 1; value <= 8; value++) {
      const jpeg = insertOrientation(bytesOf("no-exif.jpg"), value, { byteOrder });
      assert.equal(readOrientation(jpeg), value, `${byteOrder} ${value}`);
    }
  }
});

test("the built-in EXIF writer reproduces an independently built byte layout", () => {
  // test/fixtures/insert-equal-ii-06.jpg was assembled by scripts/make-fixtures.mjs from explicit
  // byte arrays. Equality here means the writer in src/exif.ts is not merely self-consistent.
  const generated = bytesOf("insert-equal-ii-06.jpg");
  const rebuilt = insertOrientation(bytesOf("no-exif.jpg"), 6, { byteOrder: "little" });
  assert.equal(rebuilt.length, generated.length);
  assert.deepEqual(differingOffsets(rebuilt, generated), [], "writer output differs from the fixture");
});

test("inserting into a file that already has EXIF patches instead of adding a second APP1", () => {
  const original = bytesOf("exif-ii-02-tag.jpg");
  const updated = insertOrientation(original, 7);
  assert.equal(updated.length, original.length, "an existing Exif block must be patched in place");
  assert.equal(readOrientation(updated), 7);
});

test("inserted EXIF lands behind SOI or behind APP0, and survives a re-read", () => {
  const jpeg = insertOrientation(bytesOf("no-exif.jpg"), 5);
  assert.deepEqual([...jpeg.subarray(0, 2)], [0xff, 0xd8], "must start with SOI");
  assert.deepEqual([...jpeg.subarray(2, 4)], [0xff, 0xe0], "JFIF APP0 keeps the lead position");
  assert.deepEqual([...jpeg.subarray(20, 22)], [0xff, 0xe1], "APP1 follows the APP0 segment");
  assert.equal(readOrientation(jpeg), 5);

  const patched = Buffer.from(jpeg);
  patchOrientation(patched, 1);
  assert.equal(readOrientation(patched), 1);
});

test("buildExifApp1 output is self-describing", () => {
  const segment = buildExifApp1(8, { byteOrder: "big" });
  assert.equal(segment[0], 0xff);
  assert.equal(segment[1], 0xe1);
  assert.equal(segment.readUInt16BE(2), segment.length - 2, "declared length covers the whole segment");
  assert.equal(segment.subarray(4, 10).toString("latin1"), "Exif\0\0");
});

test("orientationToString returns the eight documented names", () => {
  const expected = [
    "TopLeft",
    "TopRight",
    "BottomRight",
    "BottomLeft",
    "LeftTop",
    "RightTop",
    "RightBottom",
    "LeftBottom",
  ];
  for (let value = 1; value <= 8; value++) {
    assert.equal(orientationToString(value), expected[value - 1]);
  }
  // Unknown values have no name.
  assert.equal(orientationToString(0), undefined);
  assert.equal(orientationToString(9), undefined);
});

test("jpegSegments walks every leading segment layout", () => {
  // Layouts covered by the corpus: APP1 first, APP0+APP2+APP1, XMP APP1 before the Exif APP1.
  for (const file of ["exif-first.jpg", "app0-app2-exif.jpg", "xmp-then-exif.jpg"]) {
    assert.equal(readOrientation(bytesOf(file)), 6, file);
  }
});
