#!/usr/bin/env node
/**
 * Command line front end for the package: look at a file, make a JPEG upright, write an orientation
 * tag, or pull the embedded Exif thumbnail out.
 *
 * Nothing here is needed for the library to work; this is the quick way to see what the codec does
 * to a real file. Every command writes into `tmp/` unless an output path is given (`-o`), so trying
 * things out never modifies the input and never leaves files that git would see (`tmp/` is ignored).
 *
 * Usage: node bin/lossless-rotate.ts <command> [options] <file...>
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  autoRotateBuffer,
  avifImageSizeFromBuffer,
  avifLayout,
  avifPropertyTypes,
  canTransform,
  composeTransforms,
  findExifApp1,
  isAvif,
  isIdentity,
  locateExifThumbnail,
  type OrientationPrimitive,
  OrientError,
  orientationToString,
  parseJpeg,
  type Rotation,
  readAvifOrientation,
  readOrientation,
  readOrientationInExifBlock,
  setOrientation,
  transformFor,
  transformForRotation,
  transformJpeg,
} from "../src/index.ts";

/**
 * The manifest is read at run time so `--version` cannot drift from package.json. The file lives at
 * the package root, but this module sits in `bin/` when run from source and in `dist/bin/` when
 * installed, so the root is found by walking up until the manifest appears.
 */
function readManifest(): { name: string; version: string } {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(directory, "package.json");
    try {
      return JSON.parse(readFileSync(candidate, "utf8"));
    } catch {
      const parent = dirname(directory);
      if (parent === directory) throw new Error("package.json not found above the CLI");
      directory = parent;
    }
  }
}

const manifest = readManifest();

/** Where results land when the caller does not say where: easy to look at, easy to delete. */
const DEFAULT_OUTPUT_DIR = "tmp";

const USAGE = `lossless-rotate - make JPEGs upright without re-encoding the image data

Usage:
  lossless-rotate info <file>                 show container, orientation, size and thumbnail
  lossless-rotate rotate <file...>            make JPEGs upright (lossless, in the DCT domain)
  lossless-rotate set <file> <orientation>    write the orientation only (no re-encode)
  lossless-rotate thumbnail <file>            extract the embedded Exif thumbnail

Options:
  -o, --output <path>    output file, or a directory when there are several inputs (default: ${DEFAULT_OUTPUT_DIR}/)
  -r, --rotate <deg>     turn the image by 90, 180 or 270 degrees clockwise on top of the stored
                         orientation, which is cleared afterwards (270 turns the other way; JPEG only)
  -t, --thumbnail        rotate the embedded Exif thumbnail together with the image (rotate)
      --strict           refuse a transform that cannot be perfect (rotate)
      --drop-metadata    do not keep the APPn/COM segments (rotate)
      --json             print the result as JSON
  -q, --quiet            print nothing but errors and warnings
  -h, --help             show this help
  -v, --version          show the package version

"rotate" without an angle makes the image upright: how far to turn is read from the orientation the
file already carries (90, 180 or 270 degrees, or a mirror). With --rotate <deg> the image is turned by
a fixed amount instead, counted from the way it is displayed. There is nothing to compute by hand -
the orientation says it, and "info" prints it.

AVIF pixels are never rotated: the AV1 bitstream has no lossless transform, so "set" writes the
orientation instead (an irot/imir property) and "rotate" refuses them.

Examples:
  lossless-rotate info photo.jpg
  lossless-rotate info photo.avif
  lossless-rotate rotate photo.jpg --thumbnail
  lossless-rotate rotate photo.jpg --rotate 90
  lossless-rotate rotate *.jpg -o upright/
  lossless-rotate set photo.jpg 6 -o tagged/photo.jpg
  lossless-rotate set photo.avif 6
  lossless-rotate thumbnail photo.jpg
`;

interface Options {
  output?: string;
  rotation?: Rotation;
  thumbnail: boolean;
  strict: boolean;
  dropMetadata: boolean;
  json: boolean;
  quiet: boolean;
}

interface ThumbnailInfo {
  offset: number;
  length: number;
  transformable: boolean;
}

interface FormatInfo {
  file: string;
  format: "jpeg" | "avif" | "unknown";
  orientation: number;
  orientationName?: string;
  transform?: OrientationPrimitive;
  alreadyUpright?: boolean;
  width?: number;
  height?: number;
  sampling?: string;
  progressive?: boolean;
  properties?: string[];
  thumbnail?: ThumbnailInfo;
}

function report(options: Options, message: string): void {
  if (!options.quiet) process.stdout.write(`${message}\n`);
}

/** 4:2:0 and friends, for the human reading the output; the raw factors otherwise. */
function samplingLabel(components: { h: number; v: number }[]): string {
  const [first] = components;
  if (components.length === 1) return "grayscale";
  const restArePlain = components.slice(1).every((component) => component.h === 1 && component.v === 1);
  if (first === undefined || !restArePlain) return components.map((c) => `${c.h}x${c.v}`).join(",");
  if (first.h === 1 && first.v === 1) return "4:4:4";
  if (first.h === 2 && first.v === 1) return "4:2:2";
  if (first.h === 2 && first.v === 2) return "4:2:0";
  return components.map((c) => `${c.h}x${c.v}`).join(",");
}

/** Reads everything the CLI reports about a file, without changing anything. */
function describe(file: string): FormatInfo {
  const bytes = readFileSync(file);

  if (isAvif(bytes)) {
    const orientation = readAvifOrientation(bytes);
    const size = avifImageSizeFromBuffer(bytes);
    return {
      file,
      format: "avif",
      orientation,
      orientationName: orientation === 0 ? undefined : orientationToString(orientation),
      transform: "none",
      alreadyUpright: orientation === 0 || isIdentity(transformFor(orientation)),
      width: size.width,
      height: size.height,
      properties: avifPropertyTypes(avifLayout(bytes)),
    };
  }

  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return { file, format: "unknown", orientation: 0 };
  }

  const parsed = parseJpeg(bytes);
  const exif = findExifApp1(bytes);
  const orientation = exif === null ? 0 : readOrientationInExifBlock(bytes, exif.tiffOffset, exif.end);
  const thumbnail = exif === null ? null : locateExifThumbnail(bytes, exif.tiffOffset, exif.end);

  return {
    file,
    format: "jpeg",
    orientation,
    orientationName: orientation === 0 ? undefined : orientationToString(orientation),
    transform: orientation === 0 ? "none" : transformFor(orientation).primitive,
    alreadyUpright: orientation === 0 || isIdentity(transformFor(orientation)),
    width: parsed.frame.width,
    height: parsed.frame.height,
    sampling: samplingLabel(parsed.frame.components),
    progressive: parsed.frame.progressive,
    ...(thumbnail === null
      ? {}
      : {
          thumbnail: {
            offset: thumbnail.dataOffset,
            length: thumbnail.dataLength,
            transformable: canTransform(
              bytes.subarray(thumbnail.dataOffset, thumbnail.dataOffset + thumbnail.dataLength),
            ),
          },
        }),
  };
}

/**
 * Resolves the output for one input: an explicit file path is used as is, an explicit directory gets
 * the generated name, and without `-o` the file lands in `tmp/`.
 */
function outputPath(output: string | undefined, input: string, suffix: string): string {
  const stem = basename(input, extname(input));
  const extension = extname(input) || ".jpg";
  let directory: string | undefined;
  if (output === undefined) directory = resolve(DEFAULT_OUTPUT_DIR);
  else if (output.endsWith("/") || statSync(output, { throwIfNoEntry: false })?.isDirectory() === true) {
    directory = output;
  }
  if (directory === undefined) return output!;
  mkdirSync(directory, { recursive: true });
  return join(directory, `${stem}${suffix}${extension}`);
}

function commandInfo(options: Options, files: string[]): number {
  if (files.length !== 1) throw new Error("info takes exactly one file");
  const info = describe(files[0]!);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
    return 0;
  }

  const rows: [string, string][] = [
    ["file", info.file],
    ["format", info.format],
  ];
  if (info.format === "unknown") {
    rows.push(["note", "not a JPEG or AVIF, so there is no orientation this package could read"]);
  } else {
    if (info.width !== undefined) rows.push(["size", `${info.width}x${info.height}`]);
    if (info.sampling !== undefined) rows.push(["sampling", info.sampling]);
    if (info.progressive !== undefined) rows.push(["progressive", info.progressive ? "yes" : "no"]);
    const none = info.format === "avif" ? "0 (none)" : "0 (no tag)";
    rows.push(["orientation", info.orientation === 0 ? none : `${info.orientation} (${info.orientationName})`]);
    if (info.properties !== undefined) rows.push(["properties", info.properties.join(" ")]);
    if (info.format === "jpeg") {
      rows.push(["transform", info.alreadyUpright ? "none (already upright)" : `${info.transform}`]);
      rows.push([
        "thumbnail",
        info.thumbnail === undefined
          ? "none"
          : `${info.thumbnail.length} bytes at offset ${info.thumbnail.offset}` +
            (info.thumbnail.transformable ? ", can be rotated" : ", cannot be transformed"),
      ]);
    }
  }

  const labelWidth = Math.max(...rows.map(([key]) => key.length));
  for (const [key, value] of rows) process.stdout.write(`${key.padEnd(labelWidth)}  ${value}\n`);
  return 0;
}

/**
 * One rotation, reduced to what the CLI reports. Both ways of getting there produce this - "the tag
 * says so" and "the caller asked for these degrees" - so the output and the JSON look the same.
 */
interface Outcome {
  bytes: Buffer;
  transform: OrientationPrimitive;
  /** Orientation the source carried, 0 when it had none. */
  orientation: number;
  /** Orientation written to the result, `null` when nothing was written. */
  target: number | null;
  perfect: boolean;
  thumbnailRotated: boolean;
  warnings: string[];
  copied: boolean;
}

/** The tag decides: `autoRotateBuffer` reads it, transforms, and clears it. */
function uprightOutcome(source: Buffer, options: Options): Outcome {
  const { result, bytes } = autoRotateBuffer(source, {
    rotateThumbnail: options.thumbnail,
    onImperfect: options.strict ? "error" : "warn",
    keepMetadata: !options.dropMetadata,
  });
  return {
    bytes,
    transform: result.transform,
    orientation: result.orientation,
    target: result.copied ? null : 1,
    perfect: result.perfect,
    thumbnailRotated: result.thumbnailRotated,
    warnings: result.warnings,
    copied: result.copied,
  };
}

/** The caller decides: the stored orientation is applied first, then the requested rotation. */
function turnedOutcome(source: Buffer, options: Options): Outcome {
  const rotation = options.rotation!;
  if (isAvif(source)) {
    throw new OrientError(
      "E_UNSUPPORTED",
      `cannot turn an AVIF by ${rotation} degrees: the AV1 bitstream cannot be rotated without ` +
        "re-encoding, so use `set <file> <orientation>` to write the irot/imir property instead",
    );
  }

  const orientation = readOrientation(source);
  const combined = composeTransforms(transformFor(orientation === 0 ? 1 : orientation), transformForRotation(rotation));
  if (isIdentity(combined)) {
    return {
      bytes: Buffer.from(source),
      transform: "none",
      orientation,
      target: null,
      perfect: true,
      thumbnailRotated: false,
      warnings: [],
      copied: true,
    };
  }

  const outcome = transformJpeg(source, {
    primitive: combined.primitive,
    // Nothing to clear when the file had no tag: adding an Exif block just to store "upright" would
    // grow the file for no reason.
    orientationInOutput: orientation === 0 ? undefined : 1,
    mcuAlignedOnly: options.strict,
    keepMetadata: !options.dropMetadata,
    rotateThumbnail: options.thumbnail,
  });
  return {
    bytes: outcome.bytes,
    transform: outcome.primitive,
    orientation,
    target: orientation === 0 ? null : 1,
    perfect: outcome.perfect,
    thumbnailRotated: outcome.thumbnailRotated,
    warnings: outcome.warnings,
    copied: false,
  };
}

function commandRotate(options: Options, files: string[]): number {
  if (files.length === 0) throw new Error("rotate needs at least one input file");
  if (files.length > 1 && options.output !== undefined && !options.output.endsWith("/")) {
    throw new Error("with several inputs --output has to be a directory (trailing slash)");
  }

  const results: Record<string, unknown>[] = [];
  for (const file of files) {
    const source = readFileSync(file);
    const outcome = options.rotation === undefined ? uprightOutcome(source, options) : turnedOutcome(source, options);

    // An image that needs no transform comes back as a byte exact copy; writing it somewhere just to
    // have a file would be noise, so it only happens when the caller asked for a path.
    const destination =
      outcome.copied && options.output === undefined ? null : outputPath(options.output, file, ".upright");
    if (destination === null) {
      const state = options.rotation === undefined ? "already upright" : "already in that orientation";
      report(options, `${file}: ${state}, nothing written`);
    } else {
      writeFileSync(destination, outcome.bytes);
      report(options, `${file} -> ${destination} (${describeOutcome(outcome)})`);
    }

    for (const warning of outcome.warnings) process.stderr.write(`warning: ${warning}\n`);
    const { bytes: _bytes, ...summary } = outcome;
    results.push({ file, destination, ...summary });
  }

  if (options.json) process.stdout.write(`${JSON.stringify(results.length === 1 ? results[0] : results, null, 2)}\n`);
  return 0;
}

function describeOutcome(outcome: Outcome): string {
  if (outcome.copied) return `copied unchanged, orientation ${outcome.orientation}`;
  const parts: string[] = [outcome.transform];
  if (outcome.orientation === 0) parts.push("no orientation tag");
  else parts.push(`orientation ${outcome.orientation} => ${outcome.target ?? "unchanged"}`);
  if (outcome.thumbnailRotated) parts.push("thumbnail rotated");
  if (!outcome.perfect) parts.push("NOT perfect");
  return parts.join(", ");
}

/**
 * `--rotate` in degrees, as the group of quarter turns: 90/180/270, or a negative value counting the
 * other way. Anything that is not a quarter turn (including 0, which is what "no --rotate" already
 * means) is a mistake worth saying out loud.
 */
function parseRotation(value: string): Rotation {
  const degrees = Number(value);
  if (!Number.isInteger(degrees)) throw new Error(`--rotate needs a whole number of degrees, got "${value}"`);
  const normalized = ((degrees % 360) + 360) % 360;
  if (normalized === 0) {
    throw new Error(`--rotate ${degrees} would not turn the image; leave the option out to keep the tag`);
  }
  if (normalized !== 90 && normalized !== 180 && normalized !== 270) {
    throw new Error(`--rotate must be 90, 180 or 270 (a quarter turn), got ${degrees}`);
  }
  return normalized as Rotation;
}

function commandSet(options: Options, files: string[]): number {
  if (files.length !== 2) throw new Error("set takes a file and an orientation value");
  const value = Number(files[1]);
  const bytes = setOrientation(readFileSync(files[0]!), value);
  const destination = outputPath(options.output, files[0]!, `.orientation-${value}`);
  writeFileSync(destination, bytes);
  report(options, `${files[0]} -> ${destination} (orientation ${value}, ${bytes.length} bytes, image data untouched)`);
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ file: files[0], destination, orientation: value, bytes: bytes.length })}\n`,
    );
  }
  return 0;
}

function commandThumbnail(options: Options, files: string[]): number {
  if (files.length !== 1) throw new Error("thumbnail takes exactly one file");
  const bytes = readFileSync(files[0]!);
  const exif = findExifApp1(bytes);
  const thumbnail = exif === null ? null : locateExifThumbnail(bytes, exif.tiffOffset, exif.end);
  if (thumbnail === null) {
    process.stderr.write(`${files[0]}: no embedded Exif thumbnail\n`);
    return 1;
  }

  const data = bytes.subarray(thumbnail.dataOffset, thumbnail.dataOffset + thumbnail.dataLength);
  const destination = outputPath(options.output, files[0]!, ".thumbnail");
  writeFileSync(destination, data);
  report(options, `${files[0]} -> ${destination} (${data.length} bytes)`);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ file: files[0], destination, bytes: data.length }, null, 2)}\n`);
  }
  return 0;
}

function main(): number {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o" },
      rotate: { type: "string", short: "r" },
      thumbnail: { type: "boolean", short: "t" },
      strict: { type: "boolean" },
      "drop-metadata": { type: "boolean" },
      json: { type: "boolean" },
      quiet: { type: "boolean", short: "q" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  if (values.version === true) {
    process.stdout.write(`${manifest.name} ${manifest.version}\n`);
    return 0;
  }
  if (values.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (positionals.length === 0) {
    process.stdout.write(USAGE);
    return 1;
  }

  const options: Options = {
    thumbnail: values.thumbnail === true,
    strict: values.strict === true,
    dropMetadata: values["drop-metadata"] === true,
    json: values.json === true,
    quiet: values.quiet === true,
  };
  if (typeof values.output === "string") options.output = values.output;
  if (typeof values.rotate === "string") options.rotation = parseRotation(values.rotate);

  const [command, ...rest] = positionals;
  switch (command) {
    case "info":
      return commandInfo(options, rest);
    case "rotate":
      return commandRotate(options, rest);
    case "set":
    case "thumbnail":
      // Both write metadata only; silently ignoring --rotate would look like it had been applied.
      if (options.rotation !== undefined) throw new Error(`--rotate only applies to the "rotate" command`);
      return command === "set" ? commandSet(options, rest) : commandThumbnail(options, rest);
    default:
      process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
      return 1;
  }
}

try {
  process.exitCode = main();
} catch (error) {
  const code = error !== null && typeof error === "object" && "code" in error ? String(error.code) : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const prefix = code === undefined || message.startsWith(`${code}: `) ? "" : `${code}: `;
  process.stderr.write(`${prefix}${message}\n`);
  process.exitCode = 1;
}
