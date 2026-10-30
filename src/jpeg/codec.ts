/**
 * The lossless JPEG transformer: parse, decode coefficients, transform, re-encode.
 *
 * The output is always a baseline sequential JPEG that keeps the source's quantization tables and
 * its APPn/COM segments. Nothing is dequantized, no IDCT is performed and no coefficient is
 * modified except by transposition and sign, so the image data is preserved exactly.
 *
 * A crop is the same pipeline with a third step: the transform (if any), then a rectangle of whole
 * blocks is selected, then the result is encoded. No coefficient changes, so a crop is lossless by
 * construction - only its alignment can make the result differ from what was asked for.
 */

import { OrientError } from "../errors.ts";
import { locateExifThumbnail, patchOrientationInExifBlock, replaceExifThumbnail } from "../exif.ts";
import { MARKER } from "../markers.ts";
import { type OrientationPrimitive, transformFor } from "../orientation.ts";
import { type ComponentCoefficients, decodeCoefficients } from "./decoder.ts";
import { type EncodableComponent, encodeScan } from "./encoder.ts";
import {
  type CropRegion,
  cropGeometry,
  cropRegionToString,
  type Frame,
  type FrameComponent,
  frameGeometry,
  isPerfectTransform,
  swapsAxes,
} from "./geometry.ts";
import { type PreservedSegment, parseJpeg, type QuantizationTable } from "./parse.ts";
import { STANDARD_AC_TABLES, STANDARD_DC_TABLES, ZIGZAG_TO_NATURAL } from "./tables.ts";
import { cropPlane, transformPlane } from "./transform.ts";

export interface TransformOptions {
  /** Transform for an Exif orientation value 1..8. Ignored when `primitive` is given. */
  orientation?: number;
  /** The transform to apply, "none" for a plain re-encode. */
  primitive?: OrientationPrimitive;
  /**
   * Crop the result to this region, in the coordinates of the image *after* the transform - the same
   * way jpegtran counts `-crop`. The transform and the crop happen in one pass, so the image is
   * decoded and encoded once.
   *
   * The origin is rounded down to the MCU grid (a block cannot be cut in half) and the far edge is
   * left where it was asked for; see `cropGeometry`.
   */
  crop?: CropRegion;
  /** Value written into the Exif orientation tag of the result; `undefined` leaves it alone. */
  orientationInOutput?: number | undefined;
  /**
   * Refuse (`E_UNSUPPORTED`) instead of exceeding what is losslessly achievable: a transform whose
   * dimensions are not MCU aligned, and a crop region whose origin is not on the MCU grid.
   */
  mcuAlignedOnly?: boolean;
  /** Keep the source's APPn/COM segments. Defaults to true. */
  keepMetadata?: boolean;
  /**
   * Rotate the embedded Exif thumbnail with the same primitive, so that it keeps showing the same
   * way up as the main image. Defaults to false.
   *
   * A thumbnail is a second JPEG inside the Exif block; transforming it re-encodes that JPEG (still
   * coefficient-exact) and therefore changes the length of the block, so it is opt-in. A thumbnail
   * that cannot be transformed raises instead of being skipped silently - see the README.
   */
  rotateThumbnail?: boolean;
}

/** The crop that was applied: what was asked for, and what the MCU grid allowed. */
export interface AppliedCrop {
  requested: CropRegion;
  region: CropRegion;
}

export interface TransformResult {
  bytes: Buffer;
  /** The transform that was applied. */
  primitive: OrientationPrimitive;
  /**
   * True when the result is exactly what was asked for: the transform is MCU aligned (see
   * `isPerfectTransform`) and, if a `crop` was given, its origin was on the MCU grid.
   */
  perfect: boolean;
  /** Dimensions of the result. */
  width: number;
  height: number;
  /** The crop that was applied, when `crop` was given. */
  crop?: AppliedCrop;
  /** True when an embedded Exif thumbnail was transformed as well. */
  thumbnailRotated: boolean;
  /** Warnings about the result, e.g. a dropped restart interval or progressive input. */
  warnings: string[];
}

const u16 = (value: number): Buffer => Buffer.from([(value >> 8) & 0xff, value & 0xff]);

function segment(marker: number, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0xff, marker]), u16(payload.length + 2), payload]);
}

/**
 * Transposes a quantization table.
 *
 * An axis swapping transform transposes the coefficients, so the quantization table has to follow:
 * `Q'(u,v) = Q(v,u)`, otherwise the dequantized result is wrong. Skipping it is a silent, small image
 * change - which is exactly the kind of bug the differential test against jpegtran is there to catch.
 */
function transposeQuantizationTable(values: Uint16Array): Uint16Array {
  const natural = new Uint16Array(64);
  for (let i = 0; i < 64; i++) natural[ZIGZAG_TO_NATURAL[i]!] = values[i]!;
  const transposed = new Uint16Array(64);
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      transposed[v * 8 + u] = natural[u * 8 + v]!;
    }
  }
  const zigzag = new Uint16Array(64);
  for (let i = 0; i < 64; i++) zigzag[i] = transposed[ZIGZAG_TO_NATURAL[i]!]!;
  return zigzag;
}

function buildQuantizationSegment(
  tables: Map<number, QuantizationTable>,
  usedIds: number[],
  transpose: boolean,
): Buffer {
  const parts: Buffer[] = [];
  for (const id of [...usedIds].sort((a, b) => a - b)) {
    const table = tables.get(id);
    if (table === undefined) throw new OrientError("E_INVALID_JPEG", `invalid JPEG: missing quantization table ${id}`);
    const precision = table.precision;
    const values = transpose ? transposeQuantizationTable(table.values) : table.values;
    const body = Buffer.alloc(precision === 0 ? 64 : 128);
    for (let i = 0; i < 64; i++) {
      const value = values[i]!;
      if (precision === 0) body[i] = value;
      else {
        body[i * 2] = value >> 8;
        body[i * 2 + 1] = value & 0xff;
      }
    }
    parts.push(Buffer.concat([Buffer.from([(precision << 4) | id]), body]));
  }
  return segment(0xdb, Buffer.concat(parts));
}

function buildHuffmanSegment(): Buffer {
  const parts: Buffer[] = [];
  for (const [tableClass, tables] of [
    [0, STANDARD_DC_TABLES],
    [1, STANDARD_AC_TABLES],
  ] as const) {
    for (let id = 0; id < tables.length; id++) {
      const table = tables[id]!;
      parts.push(
        Buffer.concat([Buffer.from([(tableClass << 4) | id]), Buffer.from(table.counts), Buffer.from(table.symbols)]),
      );
    }
  }
  return segment(0xc4, Buffer.concat(parts));
}

function buildFrameSegment(frame: Frame, components: FrameComponent[]): Buffer {
  const parts: Buffer[] = [
    Buffer.from([frame.precision]),
    u16(frame.height),
    u16(frame.width),
    Buffer.from([components.length]),
  ];
  for (const component of components) {
    parts.push(Buffer.from([component.id, (component.h << 4) | component.v, component.quantTableId]));
  }
  return segment(0xc0, Buffer.concat(parts));
}

function buildScanSegment(components: FrameComponent[], singleComponent: boolean): Buffer {
  const parts: Buffer[] = [Buffer.from([singleComponent ? 1 : components.length])];
  for (let i = 0; i < (singleComponent ? 1 : components.length); i++) {
    const component = components[i]!;
    const tableIndex = i === 0 ? 0 : 1;
    parts.push(Buffer.from([component.id, (tableIndex << 4) | tableIndex]));
  }
  parts.push(Buffer.from([0, 63, 0])); // Ss, Se, Ah/Al
  return segment(0xda, Buffer.concat(parts));
}

/** The `Exif\0\0` signature that precedes the TIFF block of an Exif APP1 payload. */
const EXIF_SIGNATURE = Buffer.from("Exif\0\0", "latin1");

/** Largest payload an APP1 segment can carry: the two byte length minus itself. */
const MAX_APP1_PAYLOAD = 0xffff - 2;

function isExifApp1(entry: PreservedSegment): boolean {
  if (entry.marker !== MARKER.APP1) return false;
  const { payload } = entry;
  return payload.length >= EXIF_SIGNATURE.length && EXIF_SIGNATURE.equals(payload.subarray(0, EXIF_SIGNATURE.length));
}

/**
 * Transforms the JPEG thumbnail of an Exif payload and splices it back in.
 *
 * The thumbnail is a second JPEG of the same scene, so it has to be transformed like the main image -
 * otherwise the two disagree about which way is up. It is transformed recursively, which keeps the
 * thumbnail's own metadata and its own Exif block intact and rotates the thumbnail of the thumbnail
 * if there is one.
 *
 * @throws OrientError E_UNSUPPORTED when the thumbnail is a kind of JPEG this package cannot
 * transform, E_INVALID_EXIF when the thumbnail is not a usable JPEG or the block cannot be fixed up.
 */
function rotateExifThumbnail(
  payload: Buffer,
  options: { primitive: OrientationPrimitive; orientationInOutput: number | undefined; mcuAlignedOnly?: boolean },
): { payload: Buffer; warnings: string[]; rotated: boolean } {
  const thumbnail = locateExifThumbnail(payload, EXIF_SIGNATURE.length, payload.length);
  if (thumbnail === null) return { payload, warnings: [], rotated: false };

  const source = payload.subarray(thumbnail.dataOffset, thumbnail.dataOffset + thumbnail.dataLength);
  let transformed: TransformResult;
  try {
    transformed = transformJpeg(source, {
      primitive: options.primitive,
      orientationInOutput: options.orientationInOutput,
      mcuAlignedOnly: options.mcuAlignedOnly,
      rotateThumbnail: false,
    });
  } catch (cause) {
    // A thumbnail that cannot be transformed is an error, not a warning: the caller asked for a
    // thumbnail that matches the main image, and leaving a stale one behind would be a silent
    // mismatch of exactly the kind this option exists to avoid.
    if (OrientError.is(cause) && cause.code === "E_UNSUPPORTED") {
      throw new OrientError("E_UNSUPPORTED", `unsupported Exif thumbnail: ${cause.message}`, { cause });
    }
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new OrientError(
      "E_INVALID_EXIF",
      `invalid Exif data: the embedded thumbnail is not a usable JPEG (${detail})`,
      { cause },
    );
  }

  const updated = replaceExifThumbnail(payload, EXIF_SIGNATURE.length, payload.length, thumbnail, transformed.bytes);
  if (updated.length > MAX_APP1_PAYLOAD) {
    throw new OrientError(
      "E_UNSUPPORTED",
      `the Exif block no longer fits into an APP1 segment (${updated.length} > ${MAX_APP1_PAYLOAD} bytes)`,
    );
  }

  return {
    payload: updated,
    warnings: transformed.warnings.map((warning) => `the embedded Exif thumbnail: ${warning}`),
    rotated: true,
  };
}

/**
 * Applies the metadata changes to one preserved Exif segment and reports what came out.
 *
 * The segment is only copied when something actually changed, so the common case (a plain
 * re-encode) leaves the payload of the source untouched.
 */
function updateExifSegment(
  payload: Buffer,
  options: {
    orientationInOutput: number | undefined;
    rotateThumbnail: boolean;
    primitive: OrientationPrimitive;
    mcuAlignedOnly?: boolean;
  },
): { payload: Buffer; warnings: string[]; rotated: boolean } {
  let updated = payload;
  const warnings: string[] = [];
  let rotated = false;

  if (options.orientationInOutput !== undefined) {
    const copy = Buffer.from(updated);
    try {
      patchOrientationInExifBlock(copy, EXIF_SIGNATURE.length, copy.length, options.orientationInOutput);
      updated = copy;
    } catch {
      // No usable orientation tag in this segment: leave it untouched, as the writer always did.
    }
  }

  if (options.rotateThumbnail && options.primitive !== "none") {
    const thumbnail = rotateExifThumbnail(updated, options);
    warnings.push(...thumbnail.warnings);
    rotated = thumbnail.rotated;
    updated = thumbnail.payload;
  }

  return { payload: updated, warnings, rotated };
}

/**
 * Applies the transform for `orientation` (or an explicit primitive) to a JPEG buffer.
 *
 * @throws OrientError E_NOT_JPEG / E_INVALID_JPEG / E_UNSUPPORTED / E_INVALID_VALUE / E_INVALID_EXIF.
 */
export function transformJpeg(bytes: Uint8Array, options: TransformOptions = {}): TransformResult {
  const primitive =
    options.primitive ?? (options.orientation === undefined ? "none" : transformFor(options.orientation).primitive);
  const parsed = parseJpeg(bytes);
  const geometry = frameGeometry(parsed.frame);
  const perfect = isPerfectTransform(geometry, primitive);

  if (options.mcuAlignedOnly === true && !perfect) {
    throw new OrientError(
      "E_UNSUPPORTED",
      `the image is ${parsed.frame.width}x${parsed.frame.height} with sampling factors ${parsed.frame.maxH}x${parsed.frame.maxV}, ` +
        `so a ${primitive} transform would move padding blocks into the visible area`,
    );
  }

  const warnings: string[] = [];
  if (!perfect) {
    warnings.push(
      `the image is ${parsed.frame.width}x${parsed.frame.height} with sampling factors ${parsed.frame.maxH}x${parsed.frame.maxV}, ` +
        `so its dimensions are not multiples of the MCU size (${geometry.mcuWidth}x${geometry.mcuHeight} pixels). ` +
        "The padding of the partial edge iMCUs moves into the visible area, which shifts the image: the result is not a faithful " +
        `rotation. Crop or pad to a multiple of ${geometry.mcuWidth}x${geometry.mcuHeight} first, or re-encode the image.`,
    );
  }
  if (parsed.frame.progressive) warnings.push("the source was progressive; the result is written as a sequential JPEG");
  if (parsed.restartInterval > 0) warnings.push("the source used restart markers; the result does not");

  const coefficients = decodeCoefficients(parsed);
  const singleComponent = parsed.frame.components.length === 1;

  // For a single component image the sampling factors are irrelevant; force 1x1 so the block grid
  // and the MCU grid coincide (this is also what jpegtran does for "funny" grayscale images).
  const destinationComponents: FrameComponent[] = parsed.frame.components.map((component) => {
    if (singleComponent) return { ...component, h: 1, v: 1 };
    if (!swapsAxes(primitive)) return { ...component };
    return { ...component, h: component.v, v: component.h };
  });

  // The transform first, then the crop: a crop region is expressed in the coordinates of the image
  // as it is seen after the transform, which is also how jpegtran counts `-crop`.
  const transformedPlanes = coefficients.map((component) => {
    const plane = singleComponent
      ? {
          blocks: cropToRealGrid(component),
          widthInBlocks: component.widthInBlocks,
          heightInBlocks: component.heightInBlocks,
        }
      : {
          blocks: component.blocks,
          widthInBlocks: component.paddedWidthInBlocks,
          heightInBlocks: component.paddedHeightInBlocks,
        };
    return transformPlane(plane, primitive);
  });

  const transformedFrame: Frame = {
    ...parsed.frame,
    marker: 0xc0,
    progressive: false,
    width: swapsAxes(primitive) ? parsed.frame.height : parsed.frame.width,
    height: swapsAxes(primitive) ? parsed.frame.width : parsed.frame.height,
    components: destinationComponents,
    maxH: Math.max(...destinationComponents.map((component) => component.h)),
    maxV: Math.max(...destinationComponents.map((component) => component.v)),
  };

  let destinationFrame = transformedFrame;
  let planes = transformedPlanes;
  let crop: AppliedCrop | undefined;
  let cropPerfect = true;

  if (options.crop !== undefined) {
    const transformedGeometry = frameGeometry(transformedFrame);
    const geometry = cropGeometry(transformedGeometry, options.crop);
    cropPerfect = geometry.perfect;
    if (!geometry.perfect) {
      const aligned = `${transformedGeometry.mcuWidth}x${transformedGeometry.mcuHeight}`;
      const detail =
        `the crop region ${cropRegionToString(options.crop)} does not start on the MCU grid (${aligned} pixels), ` +
        `so a block would have to be cut in half`;
      if (options.mcuAlignedOnly === true) {
        throw new OrientError(
          "E_UNSUPPORTED",
          `${detail}. Start the crop at a multiple of ${aligned}, or drop mcuAlignedOnly to let the origin be rounded down`,
        );
      }
      warnings.push(
        `${detail}. Its origin was rounded down, so the result covers ${cropRegionToString(geometry.region)}. ` +
          `Start the crop at a multiple of ${aligned} to get exactly ${cropRegionToString(options.crop)}.`,
      );
    }
    destinationFrame = geometry.frame;
    planes = transformedPlanes.map((plane, index) => cropPlane(plane, geometry.components[index]!));
    crop = { requested: options.crop, region: geometry.region };
  }

  const destinationGeometry = frameGeometry(destinationFrame);
  const encodable: EncodableComponent[] = planes.map((plane, index) => {
    const destination = destinationFrame.components[index]!;
    const visible = destinationGeometry.components[index]!;
    return {
      component: destination,
      blocks: plane.blocks,
      strideInBlocks: plane.widthInBlocks,
      widthInBlocks: plane.widthInBlocks,
      heightInBlocks: plane.heightInBlocks,
      blocksPerMcuX: destination.h,
      blocksPerMcuY: destination.v,
      // Only a crop can leave a partial edge iMCU whose padding blocks are entirely outside the
      // image; the transform path keeps the source's padding, as jpegtran does.
      ...(crop === undefined || singleComponent
        ? {}
        : { visibleSizeInBlocks: { width: visible.widthInBlocks, height: visible.heightInBlocks } }),
    };
  });

  const { width, height } = destinationFrame;
  const entropy = encodeScan(encodable, {
    singleComponent,
    mcuColumns: destinationGeometry.mcuColumns,
    mcuRows: destinationGeometry.mcuRows,
  });

  const usedQuantIds = [...new Set(destinationComponents.map((component) => component.quantTableId))];
  const preserved: PreservedSegment[] = [];
  let thumbnailRotated = false;
  if (options.keepMetadata !== false) {
    const rotateThumbnail = options.rotateThumbnail === true;
    for (const entry of parsed.preserved) {
      if (!isExifApp1(entry)) {
        preserved.push(entry);
        continue;
      }
      const update = updateExifSegment(entry.payload, {
        orientationInOutput: options.orientationInOutput,
        rotateThumbnail,
        primitive,
        mcuAlignedOnly: options.mcuAlignedOnly,
      });
      warnings.push(...update.warnings);
      if (update.rotated) thumbnailRotated = true;
      if (crop !== undefined && hasExifThumbnail(update.payload)) {
        warnings.push(
          "the embedded Exif thumbnail was not cropped: it still shows the uncropped image " +
            "(a crop cannot be scaled down losslessly)",
        );
      }
      preserved.push(update.payload === entry.payload ? entry : { marker: entry.marker, payload: update.payload });
    }
  }

  const output = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...preserved.map((entry) => segment(entry.marker, entry.payload)),
    buildQuantizationSegment(parsed.quantizationTables, usedQuantIds, swapsAxes(primitive)),
    buildFrameSegment(destinationFrame, destinationComponents),
    buildHuffmanSegment(),
    buildScanSegment(destinationComponents, singleComponent),
    entropy,
    Buffer.from([0xff, 0xd9]),
  ]);

  return {
    bytes: output,
    primitive,
    perfect: perfect && cropPerfect,
    width,
    height,
    ...(crop === undefined ? {} : { crop }),
    thumbnailRotated,
    warnings,
  };
}

/**
 * True when an Exif payload carries an embedded thumbnail.
 *
 * A structurally broken block cannot say, and saying "there is a stale thumbnail" about a block that
 * cannot be read would be noise, so it counts as "no thumbnail" here.
 */
function hasExifThumbnail(payload: Buffer): boolean {
  try {
    return locateExifThumbnail(payload, EXIF_SIGNATURE.length, payload.length) !== null;
  } catch {
    return false;
  }
}

/** Copies the real block grid out of a padded grid. */
function cropToRealGrid(component: ComponentCoefficients): Int16Array {
  const { blocks, strideInBlocks, widthInBlocks, heightInBlocks } = component;
  if (strideInBlocks === widthInBlocks && component.paddedHeightInBlocks === heightInBlocks) return blocks;
  const cropped = new Int16Array(widthInBlocks * heightInBlocks * 64);
  for (let row = 0; row < heightInBlocks; row++) {
    const from = row * strideInBlocks * 64;
    const to = row * widthInBlocks * 64;
    cropped.set(blocks.subarray(from, from + widthInBlocks * 64), to);
  }
  return cropped;
}
