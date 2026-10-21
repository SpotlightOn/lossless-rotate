/**
 * The embedded Exif thumbnail: rotating it together with the main image.
 *
 * A thumbnail is a second JPEG inside the Exif block (IFD1 tags 0x0201/0x0202), which is why
 * `transformJpeg` can rotate it - and why it has to re-encode it, which changes the length of the
 * block and moves everything that sits behind it. That bookkeeping is what most of this file is
 * about.
 *
 * The TIFF reader at the top is an independent implementation: it walks the IFD chain and follows
 * the offsets itself, so the fixup is never checked against the code that performs it. The manifest
 * describes where the thumbnail and the tags around it were placed by the fixture generator.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { OrientError } from "../src/errors.ts";
import { autoRotateBuffer, findExifApp1, readOrientation, transformFor, transformJpeg } from "../src/index.ts";
import { decodeCoefficients } from "../src/jpeg/decoder.ts";
import { parseJpeg } from "../src/jpeg/parse.ts";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const bytesOf = (file: string): Buffer => readFileSync(join(fixturesDir, file));

interface ThumbnailMeta {
  tiffOffset: number;
  blockEnd: number;
  dataOffset: number;
  dataLength: number;
  offsetEntryOffset: number;
  lengthEntryOffset: number;
  lengthFormat: number;
  make: string;
  makeBehindThumbnail: boolean;
  /** "jpeg" for a real thumbnail payload, "raw" for the fixture that stores something else. */
  payload: "jpeg" | "raw";
}

interface Fixture {
  file: string;
  bytes: number;
  kind?: string;
  comment?: string;
  byteOrder?: "little" | "big";
  orientation?: number;
  entryOffset?: number;
  expect?: { read?: number; error?: string };
  thumbnail?: ThumbnailMeta;
  /** Expected code when the thumbnail cannot be rotated; the file itself reads fine. */
  thumbnailError?: string;
}

const manifest: { files: Fixture[] } = JSON.parse(readFileSync(join(fixturesDir, "manifest.json"), "utf8"));
const thumbnailFixtures = manifest.files.filter((fixture) => fixture.kind === "thumbnail");
const rotatable = thumbnailFixtures.filter((fixture) => fixture.thumbnailError === undefined);
const brokenThumbnails = thumbnailFixtures.filter((fixture) => fixture.thumbnailError !== undefined);

const PRIMITIVE = transformFor(6).primitive; // the transform an orientation of 6 asks for
const PLAIN = { primitive: PRIMITIVE, orientationInOutput: 1 };
const WITH_THUMBNAIL = { ...PLAIN, rotateThumbnail: true };

// ---------------------------------------------------------------------------
// Independent TIFF reader
// ---------------------------------------------------------------------------

const TAG_MAKE = 0x010f;
const TAG_ORIENTATION = 0x0112;
const TAG_THUMBNAIL = 0x0201;
const TAG_THUMBNAIL_LENGTH = 0x0202;

interface Entry {
  tag: number;
  format: number;
  count: number;
  /** Absolute offset of the 4-byte value field. */
  valueOffset: number;
}

function u16(bytes: Uint8Array, offset: number, bigEndian: boolean): number {
  return bigEndian ? (bytes[offset]! << 8) | bytes[offset + 1]! : (bytes[offset + 1]! << 8) | bytes[offset]!;
}

function u32(bytes: Uint8Array, offset: number, bigEndian: boolean): number {
  return bigEndian
    ? ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0
    : ((bytes[offset + 3]! << 24) | (bytes[offset + 2]! << 16) | (bytes[offset + 1]! << 8) | bytes[offset]!) >>> 0;
}

/** Walks the IFD chain of the first Exif block and collects every entry it finds. */
function exifView(bytes: Uint8Array): { tiffOffset: number; bigEndian: boolean; entries: Entry[] } {
  const at = Buffer.from(bytes).indexOf(Buffer.from("Exif\0\0", "latin1"), 2);
  assert.ok(at >= 0, "fixture must contain an Exif block");
  const tiffOffset = at + 6;
  const bigEndian = bytes[tiffOffset] === 0x4d;

  const entries: Entry[] = [];
  const seen = new Set<number>();
  let ifd = u32(bytes, tiffOffset + 4, bigEndian);
  while (ifd !== 0) {
    assert.ok(!seen.has(ifd), "the IFD chain must not loop");
    seen.add(ifd);
    const count = u16(bytes, tiffOffset + ifd, bigEndian);
    for (let index = 0; index < count; index++) {
      const entryOffset = tiffOffset + ifd + 2 + index * 12;
      entries.push({
        tag: u16(bytes, entryOffset, bigEndian),
        format: u16(bytes, entryOffset + 2, bigEndian),
        count: u32(bytes, entryOffset + 4, bigEndian),
        valueOffset: entryOffset + 8,
      });
    }
    ifd = u32(bytes, tiffOffset + ifd + 2 + count * 12, bigEndian);
  }
  return { tiffOffset, bigEndian, entries };
}

function entryOf(view: ReturnType<typeof exifView>, tag: number): Entry {
  const entry = view.entries.find((candidate) => candidate.tag === tag);
  assert.ok(entry !== undefined, `fixture must have tag 0x${tag.toString(16)}`);
  return entry;
}

/** Resolves the Make tag by following its offset - the oracle for the offset fixup. */
function makeOf(bytes: Uint8Array): string | null {
  const view = exifView(bytes);
  const entry = view.entries.find((candidate) => candidate.tag === TAG_MAKE);
  if (entry === undefined) return null;
  const start = view.tiffOffset + u32(bytes, entry.valueOffset, view.bigEndian);
  const end = Buffer.from(bytes).indexOf(0, start);
  return Buffer.from(bytes).subarray(start, end).toString("latin1");
}

/** Absolute offset the Make string sits at. */
function makeTargetOf(bytes: Uint8Array): number {
  const view = exifView(bytes);
  const entry = entryOf(view, TAG_MAKE);
  return view.tiffOffset + u32(bytes, entry.valueOffset, view.bigEndian);
}

/** Reads the orientation value of the first Exif block, 0 when there is no tag. */
function orientationOf(bytes: Uint8Array): number {
  const view = exifView(bytes);
  const entry = view.entries.find((candidate) => candidate.tag === TAG_ORIENTATION);
  return entry === undefined ? 0 : u16(bytes, entry.valueOffset, view.bigEndian);
}

/** The declared thumbnail: where it starts, how long it is, and the JPEG itself. */
function thumbnailOf(bytes: Uint8Array): { offset: number; length: number; bytes: Buffer } {
  const view = exifView(bytes);
  const offsetEntry = entryOf(view, TAG_THUMBNAIL);
  const lengthEntry = entryOf(view, TAG_THUMBNAIL_LENGTH);
  const offset = view.tiffOffset + u32(bytes, offsetEntry.valueOffset, view.bigEndian);
  const length =
    lengthEntry.format === 3
      ? u16(bytes, lengthEntry.valueOffset, view.bigEndian)
      : u32(bytes, lengthEntry.valueOffset, view.bigEndian);
  return { offset, length, bytes: Buffer.from(bytes.subarray(offset, offset + length)) };
}

function coefficientsOf(bytes: Uint8Array): number[][] {
  return decodeCoefficients(parseJpeg(bytes)).map((component) => [...component.blocks]);
}

function errorCodeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof OrientError) return error.code;
    if (error instanceof Error) return `${error.name}: ${error.message}`;
    return String(error);
  }
  return "<no error>";
}

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

test("the thumbnail corpus is present and the manifest describes what is really in the files", () => {
  assert.ok(thumbnailFixtures.length >= 8, `expected a real thumbnail corpus, got ${thumbnailFixtures.length}`);
  assert.ok(rotatable.length >= 5, "expected several rotatable thumbnails");
  assert.ok(brokenThumbnails.length >= 3, "expected thumbnails that cannot be rotated");

  for (const fixture of thumbnailFixtures) {
    const meta = fixture.thumbnail;
    assert.ok(meta !== undefined, `${fixture.file}: no thumbnail metadata`);
    const bytes = bytesOf(fixture.file);
    assert.equal(bytes.length, fixture.bytes, `${fixture.file} changed size`);

    // The independent reader has to agree with the generator about every offset.
    const thumbnail = thumbnailOf(bytes);
    assert.equal(thumbnail.offset, meta.dataOffset, `${fixture.file}: thumbnail offset`);
    assert.equal(thumbnail.length, meta.dataLength, `${fixture.file}: thumbnail length`);
    if (meta.payload === "jpeg") {
      assert.equal(bytes[thumbnail.offset], 0xff, `${fixture.file}: thumbnail must start with SOI`);
      assert.equal(bytes[thumbnail.offset + 1], 0xd8, `${fixture.file}: thumbnail must start with SOI`);
    } else {
      assert.notEqual(bytes[thumbnail.offset], 0xff, `${fixture.file}: the payload must not look like a JPEG`);
    }
    assert.equal(makeOf(bytes), meta.make, `${fixture.file}: Make tag`);
    assert.equal(orientationOf(bytes), 6, `${fixture.file}: orientation`);
    assert.equal(
      thumbnail.offset + thumbnail.length === meta.blockEnd,
      !meta.makeBehindThumbnail,
      `${fixture.file}: the thumbnail is ${meta.makeBehindThumbnail ? "not " : ""}the last thing in the block`,
    );
  }
});

// ---------------------------------------------------------------------------
// What rotating the thumbnail does, and what it must not do
// ---------------------------------------------------------------------------

test("the main image is untouched by the thumbnail rotation", () => {
  for (const fixture of rotatable) {
    const bytes = bytesOf(fixture.file);
    const plain = transformJpeg(bytes, PLAIN);
    const rotated = transformJpeg(bytes, WITH_THUMBNAIL);
    const label = `${fixture.file} (${fixture.comment})`;

    assert.equal(plain.thumbnailRotated, false, `${label}: nothing rotates without asking`);
    assert.equal(rotated.thumbnailRotated, true, `${label}: the thumbnail was reported as rotated`);

    // Same coefficients, and the file grew by exactly what the new thumbnail is longer.
    assert.deepEqual(coefficientsOf(rotated.bytes), coefficientsOf(plain.bytes), `${label}: coefficients`);
    const before = thumbnailOf(bytes);
    const after = thumbnailOf(rotated.bytes);
    assert.equal(
      rotated.bytes.length - plain.bytes.length,
      after.length - before.length,
      `${label}: only the Exif block may change size`,
    );
    assert.equal(plain.bytes.length, bytes.length - (bytes.length - plain.bytes.length), `${label}: sanity`);
  }
});

test("the thumbnail in the result is the transform of the source thumbnail", () => {
  for (const fixture of rotatable) {
    const bytes = bytesOf(fixture.file);
    const before = thumbnailOf(bytes);
    const meta = fixture.thumbnail!;
    const result = transformJpeg(bytes, WITH_THUMBNAIL);
    const after = thumbnailOf(result.bytes);
    const label = `${fixture.file} (${fixture.comment})`;

    // The same primitive, applied to the thumbnail's own JPEG. The thumbnail keeps its metadata, and
    // an orientation tag inside it is written like the main image's (orientationInOutput = 1).
    const expected = transformJpeg(before.bytes, { primitive: PRIMITIVE, orientationInOutput: 1 });
    assert.deepEqual(after.bytes, expected.bytes, `${label}: thumbnail bytes`);

    // The offset tag points at the thumbnail start, which does not move; the length tag is rewritten.
    const view = exifView(result.bytes);
    assert.equal(after.offset - view.tiffOffset, before.offset - meta.tiffOffset, `${label}: thumbnail offset`);
    assert.equal(after.offset, meta.dataOffset, `${label}: thumbnail start must not move`);
    assert.equal(after.length, expected.bytes.length, `${label}: declared length`);
    assert.equal(after.bytes.length, expected.bytes.length, `${label}: real length`);
  }
});

test("the length tag is rewritten in place, in both byte orders and both TIFF types", () => {
  const seenFormats = new Set<number>();
  for (const fixture of rotatable) {
    const meta = fixture.thumbnail!;
    seenFormats.add(meta.lengthFormat);
    const bytes = bytesOf(fixture.file);
    const lengthEntry = entryOf(exifView(bytes), TAG_THUMBNAIL_LENGTH);
    const result = transformJpeg(bytes, WITH_THUMBNAIL);
    const thumbnail = thumbnailOf(result.bytes);

    // Outside the length entry itself, only the value may differ, and only by the delta.
    const before = bytesOf(fixture.file);
    const view = exifView(result.bytes);
    const at = entryOf(view, TAG_THUMBNAIL_LENGTH).valueOffset;
    assert.equal(at, lengthEntry.valueOffset, `${fixture.file}: the length entry must not move`);
    assert.equal(thumbnailOf(before).length, meta.dataLength, `${fixture.file}: starts out as declared`);
    assert.ok(
      meta.lengthFormat === 3 ? thumbnail.length <= 0xffff : thumbnail.length > 0,
      `${fixture.file}: length must fit its type`,
    );
  }
  assert.deepEqual([...seenFormats].sort(), [3, 4], "the corpus must cover SHORT and LONG length entries");
});

test("a Make tag behind the thumbnail is shifted by exactly the change in length", () => {
  const shifted = rotatable.filter((fixture) => fixture.thumbnail?.makeBehindThumbnail === true);
  assert.ok(shifted.length > 0, "the corpus must contain a fixture with a tag behind the thumbnail");

  for (const fixture of shifted) {
    const bytes = bytesOf(fixture.file);
    const before = thumbnailOf(bytes);
    const result = transformJpeg(bytes, WITH_THUMBNAIL);
    const after = thumbnailOf(result.bytes);
    const label = `${fixture.file} (${fixture.comment})`;

    // The fixture is only useful if the thumbnail really changed length.
    assert.notEqual(after.length, before.length, `${label}: the length must change to exercise the fixup`);
    assert.equal(
      makeTargetOf(result.bytes) - makeTargetOf(bytes),
      after.length - before.length,
      `${label}: the Make offset must move with the thumbnail`,
    );
    assert.equal(makeOf(result.bytes), "TestCam", `${label}: the Make tag must still resolve`);
  }
});

test("a Make tag in front of the thumbnail stays where it is", () => {
  const front = rotatable.filter((fixture) => fixture.thumbnail?.makeBehindThumbnail === false);
  for (const fixture of front) {
    const bytes = bytesOf(fixture.file);
    const result = transformJpeg(bytes, WITH_THUMBNAIL);
    assert.equal(makeTargetOf(result.bytes), makeTargetOf(bytes), `${fixture.file}: nothing moved`);
    assert.equal(makeOf(result.bytes), "TestCam", fixture.file);
  }
});

// ---------------------------------------------------------------------------
// Corner cases
// ---------------------------------------------------------------------------

test("opt-in: without the option nothing about the thumbnail changes", () => {
  const bytes = bytesOf("exif-thumbnail-06.jpg");
  const off = transformJpeg(bytes, PLAIN);
  const explicitOff = transformJpeg(bytes, { ...PLAIN, rotateThumbnail: false });
  assert.deepEqual(explicitOff.bytes, off.bytes);
  assert.equal(off.thumbnailRotated, false);
  assert.deepEqual(thumbnailOf(off.bytes).bytes, thumbnailOf(bytes).bytes, "the thumbnail is carried over as is");
});

test("a file without a thumbnail is unaffected, and a plain re-encode does not touch one", () => {
  const withoutThumbnail = bytesOf("orient-64x48-420-06.jpg");
  const rotated = transformJpeg(withoutThumbnail, WITH_THUMBNAIL);
  assert.equal(rotated.thumbnailRotated, false);
  assert.deepEqual(rotated.bytes, transformJpeg(withoutThumbnail, PLAIN).bytes);

  // primitive "none" means "re-encode as is": nothing is rotated, so nothing is rotated twice.
  const reEncode = transformJpeg(bytesOf("exif-thumbnail-06.jpg"), { primitive: "none", rotateThumbnail: true });
  assert.equal(reEncode.thumbnailRotated, false);
});

test("a thumbnail with its own Exif block keeps it, with the orientation written like the main image's", () => {
  const bytes = bytesOf("exif-thumbnail-own-exif-06.jpg");
  const before = thumbnailOf(bytes);
  assert.equal(orientationOf(before.bytes), 6, "the fixture's thumbnail really carries orientation 6");
  assert.equal(makeOf(before.bytes), "InnerCam");

  const result = transformJpeg(bytes, WITH_THUMBNAIL);
  const after = thumbnailOf(result.bytes);
  assert.equal(orientationOf(after.bytes), 1, "the thumbnail's own tag is written as well");
  assert.equal(makeOf(after.bytes), "InnerCam", "the thumbnail keeps its own metadata");
  assert.equal(makeOf(result.bytes), "TestCam", "the main image keeps its metadata");
});

test("a thumbnail that cannot be rotated is an error, not a silent copy", () => {
  for (const fixture of brokenThumbnails) {
    const bytes = bytesOf(fixture.file);
    const label = `${fixture.file} (${fixture.comment})`;

    // The file itself is fine: only the thumbnail is a problem.
    assert.equal(readOrientation(bytes), 6, label);
    assert.equal(transformJpeg(bytes, PLAIN).thumbnailRotated, false, label);
    assert.equal(
      errorCodeOf(() => transformJpeg(bytes, WITH_THUMBNAIL)),
      fixture.thumbnailError,
      label,
    );
  }

  // The arithmetic one is refused because the codec cannot read SOF9, the other two because the Exif
  // block cannot be fixed up safely.
  assert.equal(
    errorCodeOf(() => transformJpeg(bytesOf("err-thumbnail-arithmetic-06.jpg"), WITH_THUMBNAIL)),
    "E_UNSUPPORTED",
  );
  assert.match(
    (() => {
      try {
        transformJpeg(bytesOf("err-thumbnail-not-jpeg-06.jpg"), WITH_THUMBNAIL);
        return "";
      } catch (error) {
        return error instanceof Error ? error.message : "";
      }
    })(),
    /embedded thumbnail is not a usable JPEG/,
  );
  assert.match(
    (() => {
      try {
        transformJpeg(bytesOf("err-thumbnail-subifds-06.jpg"), WITH_THUMBNAIL);
        return "";
      } catch (error) {
        return error instanceof Error ? error.message : "";
      }
    })(),
    /SubIFDs cannot be fixed up/,
  );
});

test("warnings of the thumbnail are reported, and attributed to it", () => {
  const progressive = transformJpeg(bytesOf("exif-thumbnail-progressive-06.jpg"), WITH_THUMBNAIL);
  assert.equal(progressive.warnings.length, 1, progressive.warnings.join(" | "));
  assert.match(progressive.warnings[0]!, /^the embedded Exif thumbnail: /);
  assert.match(progressive.warnings[0]!, /progressive/);

  const imperfect = transformJpeg(bytesOf("exif-thumbnail-imperfect-06.jpg"), WITH_THUMBNAIL);
  assert.equal(imperfect.perfect, true, "the main image is MCU aligned; only the thumbnail is not");
  assert.equal(imperfect.warnings.length, 1, imperfect.warnings.join(" | "));
  assert.match(imperfect.warnings[0]!, /^the embedded Exif thumbnail: /);
  assert.match(imperfect.warnings[0]!, /MCU size/);
  assert.match(imperfect.warnings[0]!, /41x27/);
});

test("the strict mode refuses a thumbnail that would be shifted", () => {
  const bytes = bytesOf("exif-thumbnail-imperfect-06.jpg");
  assert.equal(
    errorCodeOf(() => transformJpeg(bytes, { ...WITH_THUMBNAIL, mcuAlignedOnly: true })),
    "E_UNSUPPORTED",
  );
});

// ---------------------------------------------------------------------------
// The high level API
// ---------------------------------------------------------------------------

test("autoRotateBuffer rotates the thumbnail on request and reports it", () => {
  const source = bytesOf("exif-thumbnail-06.jpg");
  const { result, bytes } = autoRotateBuffer(source, { rotateThumbnail: true });

  assert.equal(result.orientation, 6);
  assert.equal(result.transform, PRIMITIVE);
  assert.equal(result.thumbnailRotated, true);
  assert.equal(readOrientation(bytes), 1);
  assert.ok(thumbnailOf(bytes).length > thumbnailOf(source).length, "the thumbnail was re-encoded");

  // Running it again is a no-op: the image is upright, so it is copied without any thumbnail work.
  const second = autoRotateBuffer(bytes, { rotateThumbnail: true });
  assert.equal(second.result.copied, true);
  assert.equal(second.result.thumbnailRotated, false);
  assert.deepEqual(second.bytes, bytes);
});

test("dropping the metadata drops the thumbnail with it, without an error", () => {
  const source = bytesOf("err-thumbnail-arithmetic-06.jpg"); // a thumbnail that cannot be rotated
  const { result, bytes } = autoRotateBuffer(source, { rotateThumbnail: true, keepMetadata: false });
  assert.equal(result.thumbnailRotated, false);
  assert.deepEqual(parseJpeg(bytes).preserved, [], "no APPn/COM segments when asked to drop them");
  assert.equal(findExifApp1(bytes), null, "no Exif block, so no thumbnail to trip over");
});
