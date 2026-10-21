/**
 * The CLI on AVIF input: what `info` reports, what `set` writes, and that `rotate` refuses.
 *
 * The CLI is one front end over two formats, so its AVIF cases live here instead of being spread
 * through the JPEG CLI tests. Everything runs as a child process with real files, like the JPEG side.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { fixturesDir, run, scratch } from "../core/helpers.ts";

test("info reports the orientation, size and properties of an AVIF, and says so in JSON", (t) => {
  const space = scratch(t);
  const file = join(fixturesDir, "avif/irot-3.avif");
  const text = run(["info", file], space);
  assert.equal(text.status, 0);
  assert.match(text.stdout, /format\s+avif/);
  assert.match(text.stdout, /size\s+64x48/);
  assert.match(text.stdout, /orientation\s+6 \(RightTop\)/);
  assert.match(text.stdout, /properties\s+ispe av1C irot/);

  const json = run(["info", file, "--json"], space);
  assert.equal(json.status, 0);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.format, "avif");
  assert.equal(parsed.orientation, 6);
  assert.equal(parsed.width, 64);
  assert.equal(parsed.height, 48);
  assert.deepEqual(parsed.properties, ["ispe", "av1C", "irot"]);
  // A metadata-only format: there is no pixel transform to apply, but the stored image is not upright.
  assert.equal(parsed.transform, "none");
  assert.equal(parsed.alreadyUpright, false);

  const none = run(["info", join(fixturesDir, "avif/base.avif")], space);
  assert.match(none.stdout, /orientation\s+0 \(none\)/, "an AVIF has no tag, only a property");
});

test("set writes the orientation of an AVIF and never touches the input", (t) => {
  const space = scratch(t);
  const file = join(fixturesDir, "avif/base.avif");
  const before = readFileSync(file);

  const tagged = run(["set", file, "6"], space);
  assert.equal(tagged.status, 0);
  assert.match(tagged.stdout, /orientation 6, \d+ bytes, image data untouched/);
  assert.match(run(["info", join(space, "tmp", "base.orientation-6.avif")], space).stdout, /orientation\s+6/);
  assert.deepEqual(readFileSync(file), before, "the input must not be modified");
});

test("rotate refuses an AVIF and points at set", (t) => {
  const space = scratch(t);
  const avif = run(["rotate", join(fixturesDir, "avif/base.avif")], space);
  assert.equal(avif.status, 1);
  assert.match(avif.stderr, /^E_UNSUPPORTED: unsupported AVIF/);
});

test("--rotate refuses to turn an AVIF, even when the angle is fine", (t) => {
  const space = scratch(t);
  const avif = run(["rotate", join(fixturesDir, "avif/base.avif"), "--rotate", "90"], space);
  assert.equal(avif.status, 1);
  assert.match(avif.stderr, /^E_UNSUPPORTED: cannot turn an AVIF by 90 degrees/);
});
