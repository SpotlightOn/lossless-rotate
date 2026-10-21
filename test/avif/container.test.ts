/**
 * The AVIF container layer: recognising a file, the brand that tells a still image from a sequence,
 * and the corpus that the rest of the AVIF tests rely on.
 *
 * This file stays at the box level on purpose; the `irot`/`imir` reading and writing lives in
 * `orientation.test.ts`, the file and API layer in `file.test.ts`, the CLI in `cli.test.ts`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { isAvif, isAvifSequence } from "../../src/avif/container.ts";
import { readAvifOrientation } from "../../src/avif/orientation.ts";
import { bytesOf, errorCodeOf } from "../core/helpers.ts";
import { avifFixtures, broken, ftyp, readable } from "./helpers.ts";

test("the AVIF corpus covers the layouts this layer has to survive", () => {
  assert.ok(avifFixtures.length >= 20, `expected a real AVIF corpus, got ${avifFixtures.length}`);
  assert.ok(readable.length >= 12, "expected a good number of readable AVIF fixtures");
  assert.ok(broken.length >= 6, "expected malformed AVIF fixtures");

  const layouts = new Set(readable.map((fixture) => fixture.avif?.properties.join("+") ?? "error"));
  for (const expected of ["ispe+av1C", "ispe+av1C+irot", "ispe+av1C+imir", "ispe+av1C+irot+imir"]) {
    assert.ok(layouts.has(expected), `corpus is missing the layout ${expected}`);
  }

  // The iloc flavours matter too: the writer rewrites the extents, so each shape has to be covered.
  const ilocFlavours = new Set(
    readable.map((fixture) => `${fixture.avif?.ilocVersion}/${fixture.avif?.ilocBaseOffsetSize}`),
  );
  for (const expected of ["1/0", "2/0", "0/4"]) {
    assert.ok(ilocFlavours.has(expected), `corpus is missing the iloc flavour ${expected}`);
  }

  for (const fixture of avifFixtures) {
    assert.equal(bytesOf(fixture.file).length, fixture.bytes, `${fixture.file} changed size`);
  }
});

test("isAvif recognises the container and nothing else", () => {
  assert.equal(isAvif(bytesOf("avif/base.avif")), true);
  assert.equal(isAvif(bytesOf("avif/err-not-avif.avif")), false, "an ftyp without an AVIF brand is not AVIF");
  assert.equal(isAvif(bytesOf("lenna.png")), false);
  assert.equal(isAvif(bytesOf("no-exif.jpg")), false);
  assert.equal(isAvif(bytesOf("err-png.jpg")), false);
  assert.equal(isAvif(Buffer.alloc(0)), false);
  assert.equal(isAvif(Buffer.from("ftypavif")), false, "a truncated header is not AVIF");
});

test("tells an AVIF image sequence from a still image", () => {
  assert.equal(isAvifSequence(bytesOf("avif/err-sequence.avif")), true);
  assert.equal(isAvifSequence(bytesOf("avif/base.avif")), false);
  assert.equal(isAvifSequence(bytesOf("lenna.avif")), false);
  assert.equal(isAvifSequence(bytesOf("no-exif.jpg")), false);

  // A file that names both brands is a still image that can also be shown as a sequence.
  assert.equal(isAvifSequence(ftyp("avis", "avif", "avis")), false, "both brands means still image");
  assert.equal(isAvifSequence(ftyp("avif", "avis")), false, "the still-image brand wins");
  assert.equal(isAvifSequence(ftyp("avis", "avis", "msf1")), true, "a sequence brand alone means a sequence");

  // A sequence is not a still image: reading an orientation must say so, not fail on the box tree.
  assert.equal(
    errorCodeOf(() => readAvifOrientation(bytesOf("avif/err-sequence.avif"))),
    "E_UNSUPPORTED_FORMAT",
  );
});

test("a JPEG and a PNG are not mistaken for an AVIF", () => {
  assert.equal(
    errorCodeOf(() => readAvifOrientation(bytesOf("lenna.jpg"))),
    "E_UNSUPPORTED_FORMAT",
  );
  assert.equal(
    errorCodeOf(() => readAvifOrientation(bytesOf("err-png.jpg"))),
    "E_UNSUPPORTED_FORMAT",
  );
  assert.equal(
    errorCodeOf(() => readAvifOrientation(Buffer.alloc(0))),
    "E_UNSUPPORTED_FORMAT",
  );
});
