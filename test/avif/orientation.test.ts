/**
 * Reading and writing the `irot`/`imir` properties of the primary item.
 *
 * The interesting questions are "is the property the right one", "is it associated with the right
 * item", and "did the `iloc` extent keep pointing at the untouched `mdat`". The hand-built fixtures
 * are the independent implementation; the differential tests at the bottom add `avifenc` and
 * `avifdec` as external oracles and skip themselves when the tools are missing.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { readAvifOrientation, setAvifOrientation, writeAvifOrientation } from "../../src/avif/orientation.ts";
import { readOrientationFromFile } from "../../src/file.ts";
import { bytesOf, differingOffsets, errorCodeOf, errorCodeOfAsync, pathOf } from "../core/helpers.ts";
import {
  boxesIn,
  broken,
  first,
  HAVE_AVIF_TOOLS,
  HAVE_MAGICK,
  ilocExtentOf,
  imageDataOf,
  propertiesOf,
  readable,
  transformOffsetsOf,
  workDir,
} from "./helpers.ts";

test("reads the orientation of every readable AVIF fixture, from the buffer and from disk", async () => {
  for (const fixture of readable) {
    const file = bytesOf(fixture.file);
    const label = `${fixture.file} (${fixture.comment})`;
    assert.equal(readAvifOrientation(file), fixture.expect?.read, `${label}: buffer`);
    assert.equal(await readOrientationFromFile(pathOf(fixture.file)), fixture.expect?.read, `${label}: disk`);

    // The recorded layout must match what the box tree actually holds.
    const meta = fixture.avif;
    if (meta === undefined) {
      // The hand-provided sample has no recorded layout: it comes from an encoder, so its `iloc` uses a
      // base offset and its `ipco` carries a `pixi` property, which the generator's fixed-shape walker
      // does not describe (see the test below).
      assert.equal(fixture.kind, "sample", `${label}: only a provided sample may skip the layout check`);
      continue;
    }
    assert.deepEqual(propertiesOf(file), meta.properties, `${label}: property list`);
    assert.equal(ilocExtentOf(file), meta.mdatOffset, `${label}: iloc must point at mdat`);
    assert.deepEqual(
      transformOffsetsOf(file),
      { irot: meta.irotOffset, imir: meta.imirOffset },
      `${label}: transform property offsets`,
    );
  }
});

test("reads a real AVIF produced by an encoder, whatever its box layout", async () => {
  const sample = bytesOf("lenna.avif");
  assert.equal(readAvifOrientation(sample), 0);
  // This sample is not the shape the hand-built fixtures use: its `ipco` carries a `pixi` property
  // after `ispe`, so the property list is not the minimal pair, and its `iloc` stores the extent
  // relative to a base offset rather than as a plain absolute offset. The reader has to add that in.
  assert.deepEqual(propertiesOf(sample), ["av1C", "ispe", "pixi"]);
  const meta = first(boxesIn(sample, 0, sample.length), "meta");
  const iloc = first(boxesIn(sample, meta.bodyOffset + 4, meta.bodyEnd), "iloc");
  assert.ok((sample[iloc.bodyOffset + 4]! & 0x0f) > 0, "the sample stores its extents relative to a base offset");
  assert.equal(await readOrientationFromFile(pathOf("lenna.avif")), 0);
});

test("the transform property belongs to the primary item", () => {
  // An `irot` that only item 2 claims must not apply to the primary item 1.
  assert.equal(readAvifOrientation(bytesOf("avif/irot-unassociated.avif")), 0);
  // `pitm` decides which item is primary, not the position inside `ipma`.
  assert.equal(readAvifOrientation(bytesOf("avif/primary-2.avif")), 6);
});

test("rejects every malformed AVIF fixture with the documented error code", async () => {
  for (const fixture of broken) {
    const expected = fixture.expect?.error;
    const label = `${fixture.file} (${fixture.comment})`;
    assert.equal(
      errorCodeOf(() => readAvifOrientation(bytesOf(fixture.file))),
      expected,
      `${label}: buffer`,
    );
    assert.equal(
      await errorCodeOfAsync(() => readOrientationFromFile(pathOf(fixture.file))),
      expected,
      `${label}: disk`,
    );
  }
});

const ORIENTATION_FIXTURE: Record<number, string> = {
  1: "avif/irot-0.avif",
  2: "avif/imir-1.avif",
  3: "avif/irot-2.avif",
  4: "avif/imir-0.avif",
  5: "avif/irot-1-imir-0.avif",
  6: "avif/irot-3.avif",
  7: "avif/irot-1-imir-1.avif",
  8: "avif/irot-1.avif",
};

test("writing an orientation reproduces an independently built file byte for byte", () => {
  // The fixtures were assembled by scripts/make-fixtures.mjs from explicit byte arrays. Equality
  // means the writer in src/avif/orientation.ts is not merely self-consistent.
  const base = bytesOf("avif/base.avif");
  for (let value = 1; value <= 8; value++) {
    const generated = bytesOf(ORIENTATION_FIXTURE[value]!);
    const updated = setAvifOrientation(base, value);
    assert.equal(updated.length, generated.length, `orientation ${value}: size`);
    assert.deepEqual(differingOffsets(updated, generated), [], `orientation ${value}: writer output differs`);
    assert.equal(readAvifOrientation(updated), value, `orientation ${value}: read back`);
  }
});

test("the writer keeps the iloc extent correct for every iloc flavour", () => {
  // `iloc` version 2 stores a 32-bit item_ID and version 1 adds construction_method; a base offset
  // makes the extents relative to it. Getting any of that wrong rewrites the extents two bytes off,
  // which silently points the image data at nothing. Byte equality against the hand-built result is
  // the strongest statement available: it is not enough for the file to stay self-consistent.
  for (const name of ["iloc-v1", "iloc-v2", "iloc-base-offset"]) {
    const source = bytesOf(`avif/${name}.avif`);
    const expected = bytesOf(`avif/irot-3-${name}.avif`);
    const updated = setAvifOrientation(source, 6);
    assert.deepEqual(differingOffsets(updated, expected), [], `${name}: writer output differs`);
    assert.equal(
      ilocExtentOf(updated),
      first(boxesIn(updated, 0, updated.length), "mdat").bodyOffset,
      `${name}: the iloc extent must still point at mdat`,
    );
    assert.equal(readAvifOrientation(updated), 6, `${name}: read back`);
    assert.deepEqual(imageDataOf(updated), imageDataOf(source), `${name}: the image data must not change`);
  }
});

test("a pure mirror is written as imir alone, an identity as irot 0", () => {
  const base = bytesOf("avif/base.avif");
  for (const [value, expected] of [
    [1, ["ispe", "av1C", "irot"]],
    [2, ["ispe", "av1C", "imir"]],
    [3, ["ispe", "av1C", "irot"]],
    [4, ["ispe", "av1C", "imir"]],
    [5, ["ispe", "av1C", "irot", "imir"]],
    [6, ["ispe", "av1C", "irot"]],
    [7, ["ispe", "av1C", "irot", "imir"]],
    [8, ["ispe", "av1C", "irot"]],
  ] as const) {
    assert.deepEqual(propertiesOf(setAvifOrientation(base, value)), expected, `orientation ${value}`);
  }
});

test("writing keeps the image data and the iloc extent in step", () => {
  const base = bytesOf("avif/base.avif");
  const originalData = imageDataOf(base);
  for (let value = 1; value <= 8; value++) {
    const updated = setAvifOrientation(base, value);
    const label = `orientation ${value}`;
    assert.deepEqual(imageDataOf(updated), originalData, `${label}: the image data must not change`);
    assert.equal(
      ilocExtentOf(updated),
      first(boxesIn(updated, 0, updated.length), "mdat").bodyOffset,
      `${label}: iloc must point at the (shifted) mdat`,
    );
  }
});

test("writing adds an ipma entry when the primary item has none", () => {
  const file = bytesOf("avif/no-primary-ipma.avif");
  assert.equal(readAvifOrientation(file), 0);
  const updated = setAvifOrientation(file, 6);
  assert.equal(readAvifOrientation(updated), 6);
  assert.deepEqual(propertiesOf(updated), ["ispe", "av1C", "irot"]);
  assert.deepEqual(imageDataOf(updated), imageDataOf(file), "the image data must not change");
});

test("writes are validated", () => {
  const base = bytesOf("avif/base.avif");
  for (const bad of [0, 9, -1, 2.5, Number.NaN]) {
    assert.equal(
      errorCodeOf(() => writeAvifOrientation(base, bad)),
      "E_INVALID_VALUE",
      `value ${bad}`,
    );
    assert.equal(
      errorCodeOf(() => setAvifOrientation(base, bad)),
      "E_INVALID_VALUE",
      `value ${bad} (set)`,
    );
  }
  assert.deepEqual(differingOffsets(base, bytesOf("avif/base.avif")), [], "the input must stay untouched");
});

test("avifenc agrees with the reader and the writer for all eight orientations", { skip: !HAVE_AVIF_TOOLS }, () => {
  const source = pathOf("base/pattern-64x48-420.jpg");
  const encode = (name: string, args: string[]): Buffer => {
    const path = join(workDir, name);
    execFileSync("avifenc", [...args, "-q", "60", "--min", "10", "--max", "20", source, path], { stdio: "ignore" });
    return readFileSync(path);
  };

  const plain = encode("plain.avif", []);
  assert.equal(readAvifOrientation(plain), 0, "a plain avifenc output carries no orientation");

  const argumentsByOrientation: Record<number, string[]> = {
    1: ["--irot", "0"],
    2: ["--imir", "1"],
    3: ["--irot", "2"],
    4: ["--imir", "0"],
    5: ["--irot", "1", "--imir", "0"],
    6: ["--irot", "3"],
    7: ["--irot", "1", "--imir", "1"],
    8: ["--irot", "1"],
  };

  for (let value = 1; value <= 8; value++) {
    const args = argumentsByOrientation[value]!;
    const reference = encode(`ref-${value}.avif`, args);
    assert.equal(readAvifOrientation(reference), value, `libavif --irot/--imir ${value}: reading`);
    assert.deepEqual(
      differingOffsets(setAvifOrientation(plain, value), reference),
      [],
      `libavif --irot/--imir ${value}: our writer differs`,
    );
  }
});

test("avifdec applies the orientation we wrote", { skip: !HAVE_AVIF_TOOLS || !HAVE_MAGICK }, () => {
  const source = pathOf("base/pattern-64x48-420.jpg");
  const basePath = join(workDir, "decoded.avif");
  execFileSync("avifenc", ["-q", "60", "--min", "10", "--max", "20", source, basePath], { stdio: "ignore" });
  const base = readFileSync(basePath);

  const orientedPath = join(workDir, "decoded-oriented.avif");
  writeFileSync(orientedPath, setAvifOrientation(base, 6));

  const basePng = join(workDir, "decoded-base.png");
  const orientedPng = join(workDir, "decoded-oriented.png");
  execFileSync("avifdec", [basePath, basePng], { stdio: "ignore" });
  execFileSync("avifdec", [orientedPath, orientedPng], { stdio: "ignore" });

  const size = execFileSync("magick", [orientedPng, "-format", "%wx%h", "info:"], { encoding: "utf8" });
  assert.equal(size.trim(), "48x64", "orientation 6 turns the 64x48 image on its side");

  const referencePng = join(workDir, "decoded-reference.png");
  execFileSync("magick", [basePng, "-rotate", "90", referencePng], { stdio: "ignore" });

  let difference = 0;
  try {
    execFileSync("magick", ["compare", "-metric", "AE", orientedPng, referencePng, "null:"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (error) {
    const stderr = String((error as { stderr?: Buffer }).stderr ?? "");
    difference = Number(/^\d+/.exec(stderr.trim())?.[0] ?? Number.NaN);
  }
  assert.equal(difference, 0, "the decoded pixels must be the 90 degree clockwise rotation of the original");
});
