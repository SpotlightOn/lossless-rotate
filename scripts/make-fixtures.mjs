// Fixture generator for the v2 test corpus.
//
// Regenerates everything under test/fixtures/ that this script owns. The hand-provided sample
// images (lenna.*) are only registered, never written - see removePreviousFixtures. The generated
// fixtures are committed, so the test suite itself never needs this script (or GraphicsMagick) to
// run.
//
// The EXIF/APP1 segments and the RIFF/WebP containers written here are built from
// explicit byte arrays on purpose: they must be an independent implementation, not a round trip
// through src/exif.ts or src/webp/*.ts, otherwise the tests would only prove that the
// code agrees with itself. Only the compressed image data comes from an encoder.
//
// Requires `gm` (GraphicsMagick) for the base images, `cjpeg` for the re-encoded thumbnails and
// `cwebp` for the WebP fixtures.
// Usage: node scripts/make-fixtures.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = join(root, "test", "fixtures");
const baseDir = join(fixturesDir, "base");

// ---------------------------------------------------------------------------
// Helpers to build JPEG/EXIF structures by hand
// ---------------------------------------------------------------------------

const u16be = (v) => Buffer.from([(v >> 8) & 0xff, v & 0xff]);
const ascii = (s) => Buffer.from(s, "latin1");

/** 16/32-bit field in the byte order of the surrounding TIFF block. */
function u16(value, byteOrder) {
  const buffer = Buffer.alloc(2);
  if (byteOrder === "big") buffer.writeUInt16BE(value, 0);
  else buffer.writeUInt16LE(value, 0);
  return buffer;
}

function u32(value, byteOrder) {
  const buffer = Buffer.alloc(4);
  if (byteOrder === "big") buffer.writeUInt32BE(value >>> 0, 0);
  else buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

/** IFD entry: tag, format, count, then the 4-byte value field. */
function ifdEntry({ tag, format, count, valueOrOffset }, byteOrder) {
  const head = Buffer.alloc(8);
  if (byteOrder === "big") {
    head.writeUInt16BE(tag, 0);
    head.writeUInt16BE(format, 2);
    head.writeUInt32BE(count, 4);
  } else {
    head.writeUInt16LE(tag, 0);
    head.writeUInt16LE(format, 2);
    head.writeUInt32LE(count, 4);
  }

  const value = Buffer.alloc(4);
  if (format === 3) {
    // SHORT with count 1 is stored inline, left aligned inside the 4-byte value field:
    // big endian -> 00 <value> 00 00, little endian -> <value> 00 00 00.
    // This is the layout the v1 C addon reads and writes, so it is the one that must be produced.
    if (byteOrder === "big") value.writeUInt16BE(valueOrOffset, 0);
    else value.writeUInt16LE(valueOrOffset, 0);
  } else if (byteOrder === "big") {
    value.writeUInt32BE(valueOrOffset >>> 0, 0);
  } else {
    value.writeUInt32LE(valueOrOffset >>> 0, 0);
  }
  return Buffer.concat([head, value]);
}

/**
 * Builds a bare TIFF block: header, IFD0, next-IFD pointer, value area.
 *
 * This is the whole EXIF payload of a WebP `EXIF` chunk. A JPEG wraps the same block in
 * "Exif\0\0" plus a segment header, see `buildExifApp1`.
 * `orientation` adds tag 0x0112 (SHORT, count 1, value inline), `make` adds tag 0x010F (ASCII).
 */
function buildExifTiff({
  byteOrder = "little",
  orientation = null,
  make = null,
  tagCountOverride = null,
  magicOverride = null,
  ifdOffsetOverride = null,
}) {
  const entries = [];
  if (make !== null) {
    // Placeholder offset for the string, patched after the layout is known.
    entries.push({
      tag: 0x010f,
      format: 2,
      count: make.length + 1,
      valueOrOffset: -1,
      data: Buffer.concat([ascii(make), Buffer.from([0])]),
    });
  }
  if (orientation !== null) entries.push({ tag: 0x0112, format: 3, count: 1, valueOrOffset: orientation });

  const count = tagCountOverride ?? entries.length;
  ifdOffsetOverride ??= 8;
  const ifdStart = 8 + (ifdOffsetOverride - 8); // honours the override for malformed fixtures
  const entriesStart = ifdStart + 2;
  const dataStart = entriesStart + entries.length * 12 + 4;

  let cursor = dataStart;
  const encoded = entries.map((e) => {
    if (e.data) {
      const entry = ifdEntry({ tag: e.tag, format: e.format, count: e.count, valueOrOffset: cursor }, byteOrder);
      cursor += e.data.length;
      return { entry, data: e.data };
    }
    return { entry: ifdEntry(e, byteOrder), data: null };
  });

  const tiff = Buffer.alloc(ifdStart);
  if (byteOrder === "big") tiff.write("MM\x00\x2a", 0, "latin1");
  else tiff.write("II\x2a\x00", 0, "latin1");
  if (magicOverride !== null) tiff.writeUInt16BE(magicOverride, 2);
  if (byteOrder === "big") tiff.writeUInt32BE(ifdOffsetOverride, 4);
  else tiff.writeUInt32LE(ifdOffsetOverride, 4);

  const countBuf = Buffer.alloc(2);
  if (byteOrder === "big") countBuf.writeUInt16BE(count, 0);
  else countBuf.writeUInt16LE(count, 0);

  const dataArea = Buffer.concat(encoded.filter((e) => e.data).map((e) => e.data));
  const body = Buffer.concat([countBuf, ...encoded.map((e) => e.entry), Buffer.alloc(4), dataArea]);
  return Buffer.concat([tiff, body]);
}

/** Builds an APP1/Exif segment (marker + length + "Exif\0\0" + TIFF block). */
function buildExifApp1(options = {}) {
  const payload = Buffer.concat([ascii("Exif"), Buffer.from([0, 0]), buildExifTiff(options)]);
  return Buffer.concat([Buffer.from([0xff, 0xe1]), u16be(payload.length + 2), payload]);
}

// ---------------------------------------------------------------------------
// Helpers to build an Exif block with an embedded thumbnail
// ---------------------------------------------------------------------------

/**
 * Builds a bare TIFF block whose IFD1 declares a JPEG thumbnail through tags 0x0201/0x0202.
 *
 * This is the layout a camera writes: IFD0 holds the real tags and points at IFD1, which describes
 * the small second JPEG. `makeBehindThumbnail` stores the Make string *behind* the thumbnail, so
 * replacing the thumbnail has to shift that offset - the layout the offset walk in src/exif.ts
 * exists for. `lengthFormat` is the TIFF type of the 0x0202 entry (3 = SHORT, 4 = LONG).
 *
 * @returns the block plus the offsets of everything the tests want to look at (relative to the
 * TIFF header, as the format defines them).
 */
function buildThumbnailTiff({
  byteOrder = "little",
  orientation = 6,
  thumbnail,
  make = "TestCam",
  makeBehindThumbnail = false,
  lengthFormat = 4,
  extraTags = [],
}) {
  const makeData = make === null ? null : Buffer.concat([ascii(make), Buffer.from([0])]);
  const ifd0Tags = [
    ...(makeData ? [0x010f] : []),
    ...(orientation === null ? [] : [0x0112]),
    ...extraTags.map((tag) => tag.tag),
  ];

  const ifd0Start = 8;
  const ifd1Start = ifd0Start + 2 + ifd0Tags.length * 12 + 4;
  const ifd1EntriesStart = ifd1Start + 2;
  const valueStart = ifd1EntriesStart + 2 * 12 + 4;

  // The value area holds either "make, thumbnail" (the usual layout) or "thumbnail, make", which
  // puts the Make string behind the thumbnail and forces the fixup when the thumbnail grows.
  const thumbnailOffset = makeBehindThumbnail ? valueStart : valueStart + (makeData?.length ?? 0);
  const makeOffset = makeBehindThumbnail ? valueStart + thumbnail.length : valueStart;

  const header = Buffer.alloc(8);
  header.write(byteOrder === "big" ? "MM\x00\x2a" : "II\x2a\x00", 0, "latin1");
  if (byteOrder === "big") header.writeUInt32BE(ifd0Start, 4);
  else header.writeUInt32LE(ifd0Start, 4);

  const ifd0 = Buffer.concat([
    u16(ifd0Tags.length, byteOrder),
    ...(makeData
      ? [ifdEntry({ tag: 0x010f, format: 2, count: makeData.length, valueOrOffset: makeOffset }, byteOrder)]
      : []),
    ...(orientation === null
      ? []
      : [ifdEntry({ tag: 0x0112, format: 3, count: 1, valueOrOffset: orientation }, byteOrder)]),
    ...extraTags.map((tag) => ifdEntry(tag, byteOrder)),
    u32(ifd1Start, byteOrder), // next IFD: the thumbnail descriptions live there
  ]);

  const ifd1 = Buffer.concat([
    u16(2, byteOrder),
    ifdEntry({ tag: 0x0201, format: 4, count: 1, valueOrOffset: thumbnailOffset }, byteOrder),
    ifdEntry({ tag: 0x0202, format: lengthFormat, count: 1, valueOrOffset: thumbnail.length }, byteOrder),
    u32(0, byteOrder), // end of the IFD chain
  ]);

  const values = makeBehindThumbnail
    ? Buffer.concat([thumbnail, makeData ?? Buffer.alloc(0)])
    : Buffer.concat([makeData ?? Buffer.alloc(0), thumbnail]);

  return {
    tiff: Buffer.concat([header, ifd0, ifd1, values]),
    thumbnailOffset,
    thumbnailLength: thumbnail.length,
    /** Offsets of the two value fields, so the tests can check them without walking the block. */
    offsetValueOffset: ifd1EntriesStart + 8,
    lengthValueOffset: ifd1EntriesStart + 12 + 8,
  };
}

/** Splits a JPEG into its leading segments (everything up to and including the last pre-SOS one). */
function splitSegments(buf) {
  const out = { segments: [], tail: Buffer.alloc(0) };
  let i = 2;
  while (i < buf.length - 1) {
    if (buf[i] !== 0xff) break;
    const marker = buf[i + 1];
    if (marker === 0xda || marker === 0xd9) break;
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.segments.push(buf.subarray(i, i + 2));
      i += 2;
      continue;
    }
    const length = buf.readUInt16BE(i + 2);
    out.segments.push(buf.subarray(i, i + 2 + length));
    i += 2 + length;
  }
  out.tail = buf.subarray(i);
  return out;
}

/** Inserts `segment` after the leading SOI (+ APP0/JFIF if present), like a camera writes it. */
function injectSegment(jpeg, segment) {
  const { segments, tail } = splitSegments(jpeg);
  const head = segments.filter((s) => s[1] === 0xe0); // keep JFIF first
  const rest = segments.filter((s) => s[1] !== 0xe0);
  return Buffer.concat([jpeg.subarray(0, 2), ...head, segment, ...rest, tail]);
}

/** Absolute offset of the 12-byte orientation entry inside a file produced by injectSegment. */
function findOrientationEntryOffset(file, byteOrder) {
  const idx = file.indexOf(ascii("Exif"), 2);
  if (idx < 0) throw new Error("no Exif in generated fixture");
  return findOrientationEntryInTiff(file, idx + 6, byteOrder);
}

/** Absolute offset of the 12-byte orientation entry of the IFD0 that starts at `tiffStart`. */
function findOrientationEntryInTiff(file, tiffStart, byteOrder) {
  const ifd0Relative = byteOrder === "big" ? file.readUInt32BE(tiffStart + 4) : file.readUInt32LE(tiffStart + 4);
  const ifd0Start = tiffStart + ifd0Relative;
  const tags = byteOrder === "big" ? file.readUInt16BE(ifd0Start) : file.readUInt16LE(ifd0Start);
  for (let n = 0; n < tags; n++) {
    const off = ifd0Start + 2 + n * 12;
    const tag = byteOrder === "big" ? file.readUInt16BE(off) : file.readUInt16LE(off);
    if (tag === 0x0112) return off;
  }
  throw new Error("no orientation tag in generated fixture");
}

// ---------------------------------------------------------------------------
// Base images
// ---------------------------------------------------------------------------

const BASE_IMAGES = [
  { file: "pattern-3x2-420.jpg", size: "3x2", sampling: "2x2" },
  { file: "pattern-8x8-420.jpg", size: "8x8", sampling: "2x2" },
  { file: "pattern-8x8-422.jpg", size: "8x8", sampling: "2x1" },
  { file: "pattern-8x8-444.jpg", size: "8x8", sampling: "1x1" },
  { file: "pattern-17x9-420.jpg", size: "17x9", sampling: "2x2" },
  // Rotation tests need images that are larger than a single MCU: for anything below that the
  // coefficient-domain transforms degenerate (see DESIGN.md section 5).
  { file: "pattern-64x48-420.jpg", size: "64x48", sampling: "2x2" },
  { file: "pattern-64x48-422.jpg", size: "64x48", sampling: "2x1" },
  { file: "pattern-64x48-444.jpg", size: "64x48", sampling: "1x1" },
  { file: "pattern-41x27-420.jpg", size: "41x27", sampling: "2x2" },
];

function makeBaseImage({ size, sampling, file }) {
  const [w, h] = size.split("x").map(Number);
  // Every pixel gets a unique colour so a rotated/transposed result can be checked analytically.
  const draw = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      draw.push(
        "-fill",
        `rgb(${(x * 37) % 256},${(y * 53) % 256},${(x * y * 11 + x + y) % 256})`,
        "-draw",
        `point ${x},${y}`,
      );
    }
  }
  const args = ["convert", "-size", size, "xc:white", ...draw, "-sampling-factor", sampling, "-quality", "95", file];
  execFileSync("gm", args, { cwd: baseDir });
}

function makeProgressiveBaseImage() {
  // GraphicsMagick silently ignores -interlace for some inputs, so the progressive variant is made
  // with cjpeg, which is also what the frame check below verifies.
  const ppm = execFileSync("gm", ["convert", join(baseDir, "pattern-64x48-420.jpg"), "ppm:-"], { maxBuffer: 1 << 24 });
  execFileSync(
    "cjpeg",
    [
      "-progressive",
      "-quality",
      "90",
      "-sample",
      "2x2",
      "-outfile",
      join(baseDir, "pattern-64x48-progressive-420.jpg"),
    ],
    { input: ppm },
  );
}

/** Reads the real frame of a JPEG: dimensions, component sampling and whether it is progressive. */
function readFrame(file) {
  const bytes = readFileSync(file);
  let offset = 2;
  while (offset < bytes.length - 1) {
    const marker = bytes[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const length = bytes.readUInt16BE(offset + 2);
    if (marker === 0xc0 || marker === 0xc2) {
      const componentCount = bytes[offset + 9];
      const sampling = [];
      for (let i = 0; i < componentCount; i++) {
        const base = offset + 10 + i * 3;
        sampling.push(`${bytes[base + 1] >> 4}x${bytes[base + 1] & 15}`);
      }
      return {
        width: (bytes[offset + 7] << 8) | bytes[offset + 8],
        height: (bytes[offset + 5] << 8) | bytes[offset + 6],
        sampling: sampling.join(","),
        progressive: marker === 0xc2,
      };
    }
    offset += 2 + length;
  }
  throw new Error(`no frame in ${file}`);
}

// ---------------------------------------------------------------------------
// Fixture assembly
// ---------------------------------------------------------------------------

const manifest = { generatedBy: "scripts/make-fixtures.mjs", files: [] };
/** Verified frame of every base image, recorded in the manifest for the tests. */
const baseFrames = {};

function writeFixture(name, bytes, meta = {}) {
  writeFileSync(join(fixturesDir, name), bytes);
  manifest.files.push({ file: name, bytes: bytes.length, ...meta });
}

function orientationFixture({ byteOrder, orientation, base, extra = {} }) {
  const app1 = buildExifApp1({ byteOrder, orientation, ...extra });
  const file = injectSegment(base, app1);
  const entryOffset = findOrientationEntryOffset(file, byteOrder);
  const name = `exif-${byteOrder === "little" ? "ii" : "mm"}-${String(orientation).padStart(2, "0")}-${extra.make ? "make" : "tag"}.jpg`;
  writeFixture(name, file, {
    byteOrder,
    orientation,
    entryOffset,
    hasExif: true,
    expect: { read: orientation },
    layout: extra.make ? "make+orientation" : "orientation-only",
  });
  return file;
}

/**
 * Deletes the fixtures of the previous run, and only those.
 *
 * The previous manifest is the list of files this script owns. The hand-provided samples are
 * registered in that manifest as well, so they are skipped twice over: by kind and by name. A
 * generator that deletes the samples would be worse than no generator.
 */
function removePreviousFixtures() {
  let previous = [];
  try {
    previous = JSON.parse(readFileSync(join(fixturesDir, "manifest.json"), "utf8")).files ?? [];
  } catch {
    previous = [];
  }
  const provided = new Set(PROVIDED_SAMPLES.map(([file]) => file));
  for (const entry of previous) {
    if (entry.kind === "sample" || provided.has(entry.file)) continue;
    rmSync(join(fixturesDir, entry.file), { force: true });
  }
  mkdirSync(baseDir, { recursive: true });
}

/** Hand-provided sample images: registered in the manifest, never generated or rewritten here. */
const PROVIDED_SAMPLES = [
  ["lenna.png", "image/png"],
  ["lenna.jpg", "image/jpeg"],
];

function main() {
  removePreviousFixtures();

  for (const image of BASE_IMAGES) {
    makeBaseImage(image);
    // Fail loudly when the encoder did not produce what was asked for: a fixture that is silently
    // not what its name says is worse than no fixture (this already happened once with the sampling
    // factors and once with the progressive flag).
    const frame = readFrame(join(baseDir, image.file));
    const expected = {
      width: Number(image.size.split("x")[0]),
      height: Number(image.size.split("x")[1]),
      sampling: `${image.sampling},1x1,1x1`,
      progressive: false,
    };
    for (const key of ["width", "height", "sampling", "progressive"]) {
      if (frame[key] !== expected[key])
        throw new Error(`${image.file}: expected ${key} ${expected[key]}, got ${frame[key]}`);
    }
    baseFrames[image.file] = frame;
  }
  makeProgressiveBaseImage();
  const progressiveFrame = readFrame(join(baseDir, "pattern-64x48-progressive-420.jpg"));
  if (!progressiveFrame.progressive) throw new Error("pattern-64x48-progressive-420.jpg is not progressive");
  baseFrames["pattern-64x48-progressive-420.jpg"] = progressiveFrame;

  const base3x2 = join(baseDir, "pattern-3x2-420.jpg");
  const threeByTwo = execFileSync("cat", [base3x2], { maxBuffer: 1 << 20 });

  // Base images themselves, copied next to the EXIF variants for convenience.
  for (const file of Object.keys(baseFrames)) {
    writeFixture(`base/${file}`, execFileSync("cat", [join(baseDir, file)], { maxBuffer: 1 << 20 }), {
      kind: "base",
      frame: baseFrames[file],
    });
  }

  // 1. orientation 1..8 in both byte orders, orientation as the only tag
  for (const byteOrder of ["little", "big"]) {
    for (let orientation = 1; orientation <= 8; orientation++) {
      orientationFixture({ byteOrder, orientation, base: threeByTwo });
    }
  }

  // 2. orientation together with a non-orientation tag (entry order matters for the patcher)
  for (const byteOrder of ["little", "big"]) {
    orientationFixture({ byteOrder, orientation: 6, base: threeByTwo, extra: { make: "TestCam" } });
  }

  // 3. structural variants
  const exifOnlyLittle6 = buildExifApp1({ byteOrder: "little", orientation: 6 });
  writeFixture("exif-first.jpg", Buffer.concat([threeByTwo.subarray(0, 2), exifOnlyLittle6, threeByTwo.subarray(2)]), {
    kind: "layout",
    comment: "APP1 directly after SOI, no APP0/JFIF",
    expect: { read: 6 },
  });

  const jfif = threeByTwo.subarray(2, 2 + 2 + threeByTwo.readUInt16BE(4));
  const app2Payload = Buffer.concat([ascii("ICC_PROFILE\0"), Buffer.alloc(14)]);
  const app2 = Buffer.concat([Buffer.from([0xff, 0xe2]), u16be(app2Payload.length + 2), app2Payload]);
  writeFixture(
    "app0-app2-exif.jpg",
    Buffer.concat([threeByTwo.subarray(0, 2), jfif, app2, exifOnlyLittle6, threeByTwo.subarray(2 + jfif.length)]),
    {
      kind: "layout",
      comment: "JFIF, then an ICC APP2 chunk, then Exif",
      expect: { read: 6 },
    },
  );

  const xmpApp1 = (() => {
    const payload = Buffer.concat([ascii("http://ns.adobe.com/xap/1.0/\0"), ascii("<x:xmpmeta/>")]);
    return Buffer.concat([Buffer.from([0xff, 0xe1]), u16be(payload.length + 2), payload]);
  })();
  const xmpFile = injectSegment(threeByTwo, Buffer.concat([xmpApp1, exifOnlyLittle6]));
  writeFixture("xmp-then-exif.jpg", xmpFile, {
    kind: "layout",
    comment: "first APP1 is XMP, the Exif APP1 comes second",
    expect: { read: 6 },
  });

  writeFixture("no-exif.jpg", threeByTwo, {
    kind: "layout",
    comment: "valid JPEG, no EXIF at all",
    expect: { read: 0 },
  });

  const noOrientation = injectSegment(threeByTwo, buildExifApp1({ byteOrder: "little", make: "TestCam" }));
  writeFixture("exif-without-orientation.jpg", noOrientation, {
    kind: "layout",
    comment: "EXIF present, tag 0x0112 absent",
    expect: { read: 0 },
  });

  // 4. malformed / hostile inputs
  const malformed = (name, bytes, code, comment) =>
    writeFixture(name, bytes, { kind: "error", comment, expect: { error: code } });

  malformed("err-empty.jpg", Buffer.alloc(0), "E_NOT_JPEG", "empty file");
  malformed("err-png.jpg", Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), "E_NOT_JPEG", "PNG header");
  malformed(
    "err-soi-truncated.jpg",
    Buffer.from([0xff, 0xd8, 0xff]),
    "E_PREMATURE_END",
    "only SOI and a partial marker",
  );
  malformed(
    "err-app1-truncated.jpg",
    Buffer.concat([threeByTwo.subarray(0, 2), Buffer.from([0xff, 0xe1]), u16be(2000), ascii("Exif")]),
    "E_PREMATURE_END",
    "APP1 length runs past EOF",
  );
  const notExifApp1 = Buffer.concat([Buffer.from([0xff, 0xe1]), u16be(2 + 6), ascii("Foobar")]);
  writeFixture("app1-not-exif.jpg", injectSegment(threeByTwo, notExifApp1), {
    kind: "layout",
    comment:
      "APP1 that is not an Exif block: skipped, so the file simply has no orientation (v1 raised E_INVALID_EXIF here)",
    expect: { read: 0 },
  });
  malformed(
    "err-bad-tiff-magic.jpg",
    injectSegment(threeByTwo, buildExifApp1({ byteOrder: "little", orientation: 6, magicOverride: 0x2b })),
    "E_INVALID_EXIF",
    "TIFF magic is not 42",
  );
  malformed(
    "err-bad-byte-order.jpg",
    (() => {
      const app1 = buildExifApp1({ byteOrder: "little", orientation: 6 });
      const patched = Buffer.from(app1);
      patched.write("XY", patched.indexOf(ascii("Exif")) + 6, "latin1");
      return injectSegment(threeByTwo, patched);
    })(),
    "E_INVALID_EXIF",
    "TIFF header is neither II nor MM",
  );
  malformed(
    "err-ifd-offset-beyond-data.jpg",
    (() => {
      // Well-formed segment, but the header points at an IFD0 that is past the end of the payload.
      const app1 = buildExifApp1({ byteOrder: "little", orientation: 6 });
      app1.writeUInt32LE(60000, app1.indexOf(ascii("Exif")) + 6 + 4);
      return injectSegment(threeByTwo, app1);
    })(),
    "E_INVALID_EXIF",
    "IFD0 offset points past the APP1 payload",
  );
  malformed(
    "err-zero-tags.jpg",
    injectSegment(threeByTwo, buildExifApp1({ byteOrder: "little", orientation: 6, tagCountOverride: 0 })),
    "E_INVALID_EXIF",
    "IFD0 declares zero tags",
  );
  malformed(
    "err-orientation-value-9.jpg",
    injectSegment(threeByTwo, buildExifApp1({ byteOrder: "little", orientation: 9 })),
    "E_INVALID_EXIF",
    "orientation value 9 is out of range",
  );

  // 5. a valid but far away IFD0. v1 required the upper two bytes of the 32-bit IFD0 offset to be
  //    zero; this implementation supports the full range.
  const farIfd0 = injectSegment(
    threeByTwo,
    buildExifApp1({ byteOrder: "little", orientation: 6, ifdOffsetOverride: 2000 }),
  );
  writeFixture("exif-far-ifd0.jpg", farIfd0, {
    kind: "layout",
    byteOrder: "little",
    orientation: 6,
    entryOffset: findOrientationEntryOffset(farIfd0, "little"),
    comment: "IFD0 sits 2000 bytes behind the TIFF header",
    expect: { read: 6 },
  });

  // 6. orientation variants on images with real content, for the end to end rotation tests.
  for (const base of ["pattern-64x48-420.jpg", "pattern-41x27-420.jpg", "pattern-64x48-progressive-420.jpg"]) {
    const bytes = execFileSync("cat", [join(baseDir, base)], { maxBuffer: 1 << 24 });
    for (let orientation = 1; orientation <= 8; orientation++) {
      const file = injectSegment(bytes, buildExifApp1({ byteOrder: "little", orientation }));
      writeFixture(
        `orient-${base.replace("pattern-", "").replace(".jpg", "")}-${String(orientation).padStart(2, "0")}.jpg`,
        file,
        {
          kind: "orientation",
          byteOrder: "little",
          orientation,
          entryOffset: findOrientationEntryOffset(file, "little"),
          expect: { read: orientation },
        },
      );
    }
  }

  // 6. fixture used to prove that the built-in EXIF writer matches an independent byte layout
  const singleTag = injectSegment(threeByTwo, buildExifApp1({ byteOrder: "little", orientation: 6 }));
  writeFixture("insert-equal-ii-06.jpg", singleTag, {
    kind: "writer-equality",
    byteOrder: "little",
    orientation: 6,
    entryOffset: findOrientationEntryOffset(singleTag, "little"),
    expect: { read: 6 },
  });

  // 7. The embedded Exif thumbnail: IFD1 of the Exif block declares a second, small JPEG through
  //    tags 0x0201/0x0202. The main image and the thumbnail are different images, so a mix-up cannot
  //    hide, and both are MCU aligned under every primitive.
  const thumbnailSource = readFileSync(join(baseDir, "pattern-64x48-444.jpg"));
  const mainImage = readFileSync(join(baseDir, "pattern-64x48-420.jpg"));
  const scratchDir = mkdtempSync(join(tmpdir(), "lossless-rotate-fixtures-"));

  try {
    const thumbnailPpm = execFileSync("gm", ["convert", join(baseDir, "pattern-64x48-444.jpg"), "ppm:-"], {
      maxBuffer: 1 << 24,
    });
    /** A thumbnail encoded by an external tool, so it is not byte identical to any base image. */
    const externalThumbnail = (name, args) => {
      const path = join(scratchDir, name);
      execFileSync("cjpeg", [...args, "-quality", "90", "-sample", "2x2", "-outfile", path], { input: thumbnailPpm });
      return readFileSync(path);
    };

    const progressiveThumbnailPath = join(scratchDir, "progressive-420.jpg");
    const progressiveThumbnail = externalThumbnail("progressive-420.jpg", ["-progressive"]);
    if (!readFrame(progressiveThumbnailPath).progressive) {
      throw new Error("the progressive thumbnail fixture is not progressive");
    }
    // cjpeg -arithmetic emits SOF9, which this package refuses; verify that instead of assuming it.
    const arithmeticThumbnail = externalThumbnail("arithmetic-420.jpg", ["-arithmetic"]);
    if (!arithmeticThumbnail.includes(Buffer.from([0xff, 0xc9]))) {
      throw new Error("the arithmetic thumbnail fixture has no SOF9 marker");
    }

    /** Writes one fixture whose Exif block carries a thumbnail and records where everything sits. */
    const writeThumbnailFixture = (name, options) => {
      const byteOrder = options.byteOrder ?? "little";
      const lengthFormat = options.lengthFormat ?? 4;
      const makeBehindThumbnail = options.makeBehindThumbnail === true;
      const built = buildThumbnailTiff({
        byteOrder,
        orientation: 6,
        thumbnail: options.thumbnail,
        makeBehindThumbnail,
        lengthFormat,
        extraTags: options.extraTags ?? [],
      });

      const payload = Buffer.concat([ascii("Exif"), Buffer.from([0, 0]), built.tiff]);
      const segment = Buffer.concat([Buffer.from([0xff, 0xe1]), u16be(payload.length + 2), payload]);
      const file = injectSegment(mainImage, segment);
      const tiffOffset = file.indexOf(ascii("Exif"), 2) + 6;

      writeFixture(name, file, {
        kind: "thumbnail",
        byteOrder,
        orientation: 6,
        entryOffset: findOrientationEntryInTiff(file, tiffOffset, byteOrder),
        comment: options.comment,
        expect: { read: 6 },
        thumbnail: {
          tiffOffset,
          /** First byte behind the Exif block: whether the thumbnail is the last thing in it. */
          blockEnd: tiffOffset + built.tiff.length,
          dataOffset: tiffOffset + built.thumbnailOffset,
          dataLength: built.thumbnailLength,
          offsetEntryOffset: tiffOffset + built.offsetValueOffset,
          lengthEntryOffset: tiffOffset + built.lengthValueOffset,
          lengthFormat,
          make: "TestCam",
          makeBehindThumbnail,
          /** Whether the declared thumbnail payload really is a JPEG (one fixture stores raw bytes). */
          payload: options.thumbnailPayload ?? "jpeg",
        },
        ...(options.thumbnailError === undefined ? {} : { thumbnailError: options.thumbnailError }),
      });
    };

    writeThumbnailFixture("exif-thumbnail-06.jpg", {
      thumbnail: thumbnailSource,
      comment: "little endian, Make in front of the thumbnail, thumbnail last (the usual layout)",
    });
    writeThumbnailFixture("exif-thumbnail-shifted-06.jpg", {
      thumbnail: thumbnailSource,
      makeBehindThumbnail: true,
      comment: "little endian, Make stored behind the thumbnail: replacing it has to fix up that offset",
    });
    writeThumbnailFixture("exif-thumbnail-mm-06.jpg", {
      byteOrder: "big",
      lengthFormat: 3,
      thumbnail: thumbnailSource,
      comment: "big endian, thumbnail length stored as SHORT instead of LONG",
    });
    writeThumbnailFixture("exif-thumbnail-own-exif-06.jpg", {
      thumbnail: injectSegment(
        thumbnailSource,
        buildExifApp1({ byteOrder: "little", orientation: 6, make: "InnerCam" }),
      ),
      comment: "the thumbnail carries its own Exif block with orientation 6 and its own Make tag",
    });
    writeThumbnailFixture("exif-thumbnail-progressive-06.jpg", {
      thumbnail: progressiveThumbnail,
      comment: "the thumbnail is progressive: it is re-encoded sequentially and that is reported",
    });
    writeThumbnailFixture("exif-thumbnail-imperfect-06.jpg", {
      thumbnail: readFileSync(join(baseDir, "pattern-41x27-420.jpg")),
      comment: "the thumbnail is 41x27: its transform is not MCU aligned and that is reported",
    });
    writeThumbnailFixture("err-thumbnail-arithmetic-06.jpg", {
      thumbnail: arithmeticThumbnail,
      thumbnailError: "E_UNSUPPORTED",
      comment: "the thumbnail is arithmetic coded (SOF9): rotating it raises E_UNSUPPORTED",
    });
    writeThumbnailFixture("err-thumbnail-not-jpeg-06.jpg", {
      thumbnail: ascii("this is not a JPEG thumbnail at all"),
      thumbnailPayload: "raw",
      thumbnailError: "E_INVALID_EXIF",
      comment: "the thumbnail data is not a JPEG at all: rotating it raises E_INVALID_EXIF",
    });
    writeThumbnailFixture("err-thumbnail-subifds-06.jpg", {
      thumbnail: thumbnailSource,
      makeBehindThumbnail: true,
      // SubIFDs keep absolute offsets of their own, so the block cannot be shifted safely.
      extraTags: [{ tag: 0x014a, format: 4, count: 1, valueOrOffset: 0 }],
      thumbnailError: "E_INVALID_EXIF",
      comment: "the Exif block declares SubIFDs and the thumbnail is not the last thing in it",
    });
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }

  // Samples that were placed here by hand (the same picture in every format). They are not
  // reproducible from this script, so they are not generated - only registered, and never deleted.
  for (const [file, mediaType] of PROVIDED_SAMPLES) {
    const path = join(fixturesDir, file);
    if (!existsSync(path)) throw new Error(`the provided sample ${file} is missing: it is not generated here`);
    manifest.files.push({
      file,
      bytes: statSync(path).size,
      kind: "sample",
      mediaType,
      comment: "hand-provided sample, not generated by this script",
    });
  }

  // Body of the base image, so tests and later phases can rebuild variants without GraphicsMagick.
  manifest.baseSegments = {
    jfif: jfif.toString("base64"),
    tail: splitSegments(threeByTwo).tail.toString("base64"),
  };

  writeFileSync(join(fixturesDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  // Self-check: the manifest is the tests' oracle, so a stale description is worse than no manifest.
  const seen = new Set();
  for (const entry of manifest.files) {
    if (seen.has(entry.file)) throw new Error(`duplicate fixture name: ${entry.file}`);
    seen.add(entry.file);
    const real = statSync(join(fixturesDir, entry.file)).size;
    if (real !== entry.bytes)
      throw new Error(`fixture size mismatch for ${entry.file}: manifest ${entry.bytes}, file ${real}`);
  }

  console.log(`wrote ${manifest.files.length} fixtures to test/fixtures`);
}

main();
