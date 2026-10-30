/**
 * The high level API: cut a rectangle out of a JPEG without re-encoding it.
 *
 * A crop is the easiest lossless operation a JPEG allows. The file stores quantized DCT coefficients
 * in a grid of 8x8 blocks; cutting a rectangle of whole blocks changes no coefficient at all, so the
 * result is exact by construction. The only constraint is the block grid: the region's origin has to
 * sit on an MCU boundary, because a block cannot be cut in half. `cropGeometry` owns that arithmetic,
 * this module is the file and buffer front end.
 *
 * It is a *decode of the whole image* either way: cropping does not make a big file cheap to read.
 * What it buys is that the remaining pixels are the original ones, not a re-encode of them.
 */

import { readFile, writeFile } from "node:fs/promises";
import { isAvif } from "./avif/container.ts";
import { cantOpenCause, OrientError } from "./errors.ts";
import { transformJpeg } from "./jpeg/codec.ts";
import type { CropRegion } from "./jpeg/geometry.ts";
import { parseJpeg } from "./jpeg/parse.ts";

export interface CropOptions {
  /**
   * What to do when the region's origin is not on the MCU grid, so a faithful crop of exactly that
   * rectangle is impossible.
   *
   * - "warn" (default): round the origin down, like jpegtran does, and report the region that was
   *   produced in `warnings`.
   * - "error": refuse with `E_UNSUPPORTED`.
   */
  onUnaligned?: "warn" | "error";
  /**
   * Orientation value to store in the result. `undefined` (the default) leaves the tag alone: a crop
   * does not change which way up the image is, so unlike `autoRotate` there is nothing to clear.
   */
  orientationInOutput?: number | undefined;
  /** Keep the APPn/COM segments of the source. Defaults to true. */
  keepMetadata?: boolean;
}

export interface CropResult {
  /** The rectangle that was asked for. */
  requested: CropRegion;
  /** The rectangle that was produced; its origin is on the MCU grid. */
  region: CropRegion;
  /** True when `region` is exactly `requested`, i.e. the origin was already aligned. */
  perfect: boolean;
  width: number;
  height: number;
  /** Anything the caller should know about the result. */
  warnings: string[];
  /** True when the source was copied without being re-encoded. */
  copied: boolean;
}

/**
 * Crops a JPEG buffer.
 *
 * A region that already is the whole image is copied byte for byte: there is nothing a re-encode
 * could improve, and the caller asked for exactly the image they already have.
 *
 * @throws OrientError E_NOT_JPEG / E_INVALID_JPEG / E_UNSUPPORTED / E_INVALID_VALUE / E_INVALID_EXIF.
 */
export function cropBuffer(
  bytes: Uint8Array,
  region: CropRegion,
  options: CropOptions = {},
): { result: CropResult; bytes: Buffer } {
  if (isAvif(bytes)) {
    throw new OrientError(
      "E_UNSUPPORTED",
      "unsupported AVIF: a crop of an AV1 still image would have to be re-encoded, and the codec here " +
        "only rearranges JPEG coefficients",
    );
  }

  const frame = parseJpeg(bytes).frame;
  if (region.x === 0 && region.y === 0 && region.width === frame.width && region.height === frame.height) {
    return {
      result: {
        requested: region,
        region,
        perfect: true,
        width: frame.width,
        height: frame.height,
        warnings: [],
        copied: true,
      },
      bytes: Buffer.from(bytes),
    };
  }

  const outcome = transformJpeg(bytes, {
    crop: region,
    mcuAlignedOnly: options.onUnaligned === "error",
    keepMetadata: options.keepMetadata !== false,
    orientationInOutput: options.orientationInOutput,
  });
  const applied = outcome.crop!;
  return {
    result: {
      requested: applied.requested,
      region: applied.region,
      perfect: outcome.perfect,
      width: outcome.width,
      height: outcome.height,
      warnings: outcome.warnings,
      copied: false,
    },
    bytes: outcome.bytes,
  };
}

/**
 * Crops a JPEG file.
 *
 * @param source path of the file to read
 * @param region the rectangle to keep, in pixels, from the top left corner
 * @param destination where to write the result; when omitted, nothing is written and the caller gets
 * the output in `result.bytes` instead.
 *
 * @throws OrientError E_CANT_OPEN / E_NOT_JPEG / E_INVALID_JPEG / E_INVALID_EXIF / E_UNSUPPORTED /
 * E_INVALID_VALUE.
 */
export async function crop(
  source: string,
  region: CropRegion,
  destination?: string,
  options: CropOptions = {},
): Promise<CropResult & { bytes?: Buffer }> {
  let bytes: Buffer;
  try {
    bytes = await readFile(source);
  } catch (cause) {
    throw cantOpenCause(cause);
  }

  const { result, bytes: output } = cropBuffer(bytes, region, options);
  if (destination === undefined) return { ...result, bytes: output };
  await writeFile(destination, output);
  return result;
}
