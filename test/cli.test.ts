/**
 * The command line front end, driven the way a person drives it: as a child process with real files.
 *
 * The CLI is the one place where "what the library does" meets "what the user sees", so these tests
 * check the two things that can go wrong there: the output landing somewhere unexpected, and the
 * input being modified. Everything below that is covered against the library itself.
 */

import assert from "node:assert/strict";
import { type ExecFileSyncOptionsWithStringEncoding, execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, "bin", "lossless-rotate.ts");
const fixtures = join(root, "test", "fixtures");
const packageJson: { name: string; version: string } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/**
 * A scratch directory to run the CLI in. Its own `tmp/` is the CLI's default output directory, which
 * keeps the package clean and makes the "writes into tmp/" behaviour testable at the same time.
 */
function scratch(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "lossless-rotate-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Runs the CLI in `cwd` and reports the exit status instead of throwing. */
function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number } {
  // `stdio` is explicit: `execFileSync` otherwise echoes the child's stderr to the parent's stderr,
  // which would print the CLI's own error messages (and usage) into the test output.
  const options: ExecFileSyncOptionsWithStringEncoding = { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
  try {
    return { stdout: execFileSync(process.execPath, [cli, ...args], options), stderr: "", status: 0 };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", status: failed.status ?? 1 };
  }
}

test("--version and --help work without a command, and no command is an error", (t) => {
  const space = scratch(t);
  const version = run(["--version"], space);
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), `${packageJson.name} ${packageJson.version}`);

  const help = run(["--help"], space);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^lossless-rotate - make JPEGs upright/);

  const nothing = run([], space);
  assert.equal(nothing.status, 1);
  assert.match(nothing.stdout, /Usage:/);

  const unknown = run(["bogus"], space);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown command "bogus"/);
});

test("info reports the orientation and the thumbnail of a JPEG, and says so in JSON", (t) => {
  const space = scratch(t);
  const file = join(fixtures, "exif-thumbnail-06.jpg");
  const text = run(["info", file], space);
  assert.equal(text.status, 0);
  assert.match(text.stdout, /orientation\s+6 \(RightTop\)/);
  assert.match(text.stdout, /transform\s+rotate90/);
  assert.match(text.stdout, /thumbnail\s+\d+ bytes at offset \d+, can be rotated/);

  const json = run(["info", file, "--json"], space);
  assert.equal(json.status, 0);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.format, "jpeg");
  assert.equal(parsed.orientation, 6);
  assert.equal(parsed.transform, "rotate90");
  assert.equal(parsed.sampling, "4:2:0");
  assert.equal(parsed.thumbnail.transformable, true);
});

test("info on something that is not a JPEG says so instead of failing", (t) => {
  const space = scratch(t);
  const text = run(["info", join(fixtures, "lenna.png")], space);
  assert.equal(text.status, 0);
  assert.match(text.stdout, /format\s+unknown/);
  assert.match(text.stdout, /not a JPEG/);
});

test("rotate writes into tmp/ by default and never touches the input", (t) => {
  const space = scratch(t);
  const file = join(fixtures, "exif-thumbnail-06.jpg");
  const before = readFileSync(file);

  const rotated = run(["rotate", file], space);
  assert.equal(rotated.status, 0);
  const output = join(space, "tmp", "exif-thumbnail-06.upright.jpg");
  assert.match(rotated.stdout, /exif-thumbnail-06\.upright\.jpg \(rotate90, orientation 6 => 1\)/);
  assert.deepEqual(readdirSync(join(space, "tmp")), ["exif-thumbnail-06.upright.jpg"]);

  // Upright afterwards, and the source is byte for byte what it was.
  const info = run(["info", output], space);
  assert.match(info.stdout, /orientation\s+1 \(TopLeft\)/);
  assert.deepEqual(readFileSync(file), before, "the input must not be modified");
});

test("rotate --thumbnail reports the thumbnail, and an upright image is not written at all", (t) => {
  const space = scratch(t);
  const withThumbnail = run(["rotate", join(fixtures, "exif-thumbnail-06.jpg"), "--thumbnail"], space);
  assert.equal(withThumbnail.status, 0);
  assert.match(withThumbnail.stdout, /thumbnail rotated/);

  const before = readdirSync(join(space, "tmp"));
  const upright = run(["rotate", join(fixtures, "lenna.jpg")], space);
  assert.equal(upright.status, 0);
  assert.match(upright.stdout, /already upright, nothing written/);
  assert.deepEqual(readdirSync(join(space, "tmp")), before, "nothing new is written for an upright image");
});

test("rotate -o writes where it is told, also into a directory", (t) => {
  const space = scratch(t);
  const file = join(fixtures, "exif-thumbnail-06.jpg");
  const explicit = run(["rotate", file, "-o", "chosen.jpg"], space);
  assert.equal(explicit.status, 0);
  assert.deepEqual(readdirSync(space), ["chosen.jpg"]);
  assert.match(run(["info", join(space, "chosen.jpg")], space).stdout, /orientation\s+1/);

  const intoDirectory = run(["rotate", file, "-o", "upright/"], space);
  assert.equal(intoDirectory.status, 0);
  assert.deepEqual(readdirSync(join(space, "upright")), ["exif-thumbnail-06.upright.jpg"]);
});

test("rotate refuses what the library refuses, and says why", (t) => {
  const space = scratch(t);
  const broken = run(["rotate", join(fixtures, "err-thumbnail-arithmetic-06.jpg"), "--thumbnail"], space);
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /^E_UNSUPPORTED: unsupported Exif thumbnail/);

  const missing = run(["info", "nope.jpg"], space);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /ENOENT/, "the OS error is reported");
  assert.doesNotMatch(missing.stderr, /ENOENT: ENOENT/, "but not with a doubled code");
});

test("thumbnail extracts the embedded JPEG, and reports when there is none", (t) => {
  const space = scratch(t);
  const extracted = run(["thumbnail", join(fixtures, "exif-thumbnail-own-exif-06.jpg")], space);
  assert.equal(extracted.status, 0);
  const output = join(space, "tmp", "exif-thumbnail-own-exif-06.thumbnail.jpg");
  const data = readFileSync(output);
  assert.equal(data[0], 0xff);
  assert.equal(data[1], 0xd8);
  assert.match(extracted.stdout, new RegExp(`${data.length} bytes`));

  const none = run(["thumbnail", join(fixtures, "lenna.jpg")], space);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no embedded Exif thumbnail/);
});

test("--rotate turns the image by a fixed angle on top of the stored tag", (t) => {
  const space = scratch(t);
  // The composed transform is pinned by test/orientation.test.ts; here it is about the CLI wiring.
  // tag 1: nothing to undo, so a plain 90. tag 3: undo 180, then 90 => 270. tag 6: undo 90, then 90 => 180.
  for (const [tag, expected] of [
    ["01", "rotate90"],
    ["03", "rotate270"],
    ["06", "rotate180"],
  ] as const) {
    const file = join(fixtures, `orient-64x48-420-${tag}.jpg`);
    const result = run(["rotate", file, "--rotate", "90", "-o", `${tag}.jpg`], space);
    assert.equal(result.status, 0);
    assert.match(result.stdout, new RegExp(`\\(${expected}, orientation [0-9] => 1\\)`));
    assert.match(run(["info", join(space, `${tag}.jpg`)], space).stdout, /orientation\s+1 \(TopLeft\)/);
  }

  // tag 3 plus 180 is the identity: the image is already the way it was asked to be.
  const identity = run(["rotate", join(fixtures, "orient-64x48-420-03.jpg"), "--rotate", "180"], space);
  assert.equal(identity.status, 0);
  assert.match(identity.stdout, /already in that orientation, nothing written/);

  // A file without an orientation tag gets its pixels turned, and no tag is invented for it.
  const noTag = run(["rotate", join(fixtures, "no-exif.jpg"), "--rotate", "270", "-o", "t.jpg"], space);
  assert.equal(noTag.status, 0);
  assert.match(noTag.stdout, /\(rotate270, no orientation tag/);
  assert.match(run(["info", join(space, "t.jpg")], space).stdout, /orientation\s+0 \(no tag\)/);
});

test("--rotate rejects angles that are not a quarter turn", (t) => {
  const space = scratch(t);
  const file = join(fixtures, "orient-64x48-420-01.jpg");
  for (const value of ["45", "0", "abc", "12.5"]) {
    const result = run(["rotate", file, "--rotate", value], space);
    assert.equal(result.status, 1, `--rotate ${value} must be refused`);
    assert.match(result.stderr, /--rotate/, `--rotate ${value}`);
  }

  // Silently ignoring it on a metadata-only command would look like it had been applied.
  const onSet = run(["set", file, "6", "--rotate", "90"], space);
  assert.equal(onSet.status, 1);
  assert.match(onSet.stderr, /--rotate only applies to the "rotate" command/);
});

test("set writes only the tag, and the image data stays untouched", (t) => {
  const space = scratch(t);
  const file = join(fixtures, "lenna.jpg"); // no Exif at all: the tag has to be added
  const before = readFileSync(file);
  const tagged = run(["set", file, "6", "-o", "tagged.jpg"], space);
  assert.equal(tagged.status, 0);
  assert.match(tagged.stdout, /orientation 6, \d+ bytes, image data untouched/);

  const output = join(space, "tagged.jpg");
  assert.match(run(["info", output], space).stdout, /orientation\s+6/);
  assert.deepEqual(readFileSync(file), before, "the input must not be modified");

  // Only a small Exif block may be added in front of the entropy coded data.
  const source = readFileSync(file);
  const result = readFileSync(output);
  assert.ok(result.length - source.length < 128, "only a small Exif block may be added");
  assert.deepEqual(result.subarray(result.length - 1024), source.subarray(source.length - 1024));

  const bad = run(["set", file, "99", "-o", "bad.jpg"], space);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /orientation/);
});
