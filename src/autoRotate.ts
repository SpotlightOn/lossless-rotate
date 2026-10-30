/**
 * The high level API: make a JPEG upright.
 *
 * The whole point of this package is that the rotation happens in the DCT domain, so it neither
 * dequantizes nor requantizes anything. `autoRotate` is a thin orchestration on top of the codec:
 * read the orientation, look up the transform, apply it, write the result with orientation 1.
 *
 * AVIF is a different story and this module says so instead of pretending: AV1 has no
 * coefficient-domain rotation, so `autoRotate` refuses it with `E_UNSUPPORTED` and points at the
 * `irot`/`imir` property, which is the lossless way to make the image appear upright.
 */

import { readFile, writeFile } from "node:fs/promises";
import { isAvif } from "./avif/container.ts";
import { setAvifOrientation } from "./avif/orientation.ts";
import { cantOpenCause, OrientError } from "./errors.ts";
import { insertOrientation, readOrientation } from "./exif.ts";
import { transformJpeg } from "./jpeg/codec.ts";
import type { CropRegion } from "./jpeg/geometry.ts";
import { isIdentity, type OrientationPrimitive, transformFor } from "./orientation.ts";

export interface AutoRotateOptions {
  /**
   * What to do when the image dimensions are not multiples of the MCU size, so that a faithful
   * rotation is impossible without re-encoding.
   *
   * - "warn" (default): transform anyway, like jpegtran does, and report it in `warnings`.
   * - "error": refuse with `E_UNSUPPORTED`.
   */
  onImperfect?: "warn" | "error";
  /** Orientation value to store in the result. Defaults to 1 (upright). */
  orientationInOutput?: number;
  /** Keep the APPn/COM segments of the source. Defaults to true. */
  keepMetadata?: boolean;
  /**
   * Rotate the embedded Exif thumbnail with the same transform, so that the thumbnail keeps showing
   * the same way up as the main image. Defaults to false.
   *
   * Has no effect when the source is already upright (nothing is rotated then) and when the source
   * has no thumbnail. A thumbnail that cannot be transformed is an error, not a warning - the option
   * promises a matching thumbnail, and a stale one would be a silent mismatch.
   */
  rotateThumbnail?: boolean;
  /**
   * Crop the result to this region, in the coordinates of the image as it is seen *after* the
   * rotation - the same way jpegtran counts `-crop`. Transform and crop are one decode/encode pass,
   * so the image is never encoded twice.
   *
   * The thumbnail is not cropped (a crop cannot be scaled down losslessly) and `warnings` says so.
   * A region whose origin is not on the MCU grid needs `onImperfect: "warn"` (the default).
   */
  crop?: CropRegion;
}

export interface AutoRotateResult {
  /** Orientation of the source, 0 when it had none. */
  orientation: number;
  /** Transform that was applied. */
  transform: OrientationPrimitive;
  /** False when the transform or the crop region was not exactly achievable (see `warnings`). */
  perfect: boolean;
  width: number;
  height: number;
  /** The crop that was applied, when `crop` was given. */
  crop?: { requested: CropRegion; region: CropRegion };
  /** True when the embedded Exif thumbnail was transformed as well. */
  thumbnailRotated: boolean;
  /** Anything the caller should know about the result. */
  warnings: string[];
  /** True when the source was copied without being re-encoded. */
  copied: boolean;
}

/** Rotates a JPEG buffer so that it is upright, optionally cropping it in the same pass. */
export function autoRotateBuffer(
  bytes: Uint8Array,
  options: AutoRotateOptions = {},
): { result: AutoRotateResult; bytes: Buffer } {
  if (isAvif(bytes)) {
    throw new OrientError(
      "E_UNSUPPORTED",
      "unsupported AVIF: the AV1 bitstream cannot be rotated without re-encoding, so the irot/imir " +
        "property is the lossless way to make an AVIF appear upright (see setOrientation/orientation)",
    );
  }

  const orientation = readOrientation(bytes);
  const transform = transformFor(orientation === 0 ? 1 : orientation);

  if (options.crop === undefined && isIdentity(transform)) {
    // Nothing to do: never re-encode an image that is already upright.
    return {
      result: {
        orientation,
        transform: "none",
        perfect: true,
        width: 0,
        height: 0,
        thumbnailRotated: false,
        warnings: [],
        copied: true,
      },
      bytes: Buffer.from(bytes),
    };
  }

  const outcome = transformJpeg(bytes, {
    primitive: transform.primitive,
    crop: options.crop,
    orientationInOutput: options.orientationInOutput ?? 1,
    mcuAlignedOnly: options.onImperfect === "error",
    keepMetadata: options.keepMetadata !== false,
    rotateThumbnail: options.rotateThumbnail === true,
  });

  return {
    result: {
      orientation,
      transform: outcome.primitive,
      perfect: outcome.perfect,
      width: outcome.width,
      height: outcome.height,
      ...(outcome.crop === undefined ? {} : { crop: outcome.crop }),
      thumbnailRotated: outcome.thumbnailRotated,
      warnings: outcome.warnings,
      copied: false,
    },
    bytes: outcome.bytes,
  };
}

/**
 * Makes a JPEG file upright.
 *
 * @param source path of the file to read
 * @param destination where to write the result; when omitted, nothing is written and the caller gets
 * the output in `result.bytes` instead.
 *
 * @throws OrientError E_CANT_OPEN / E_NOT_JPEG / E_INVALID_JPEG / E_INVALID_EXIF / E_UNSUPPORTED.
 */
export async function autoRotate(
  source: string,
  destination?: string,
  options: AutoRotateOptions = {},
): Promise<AutoRotateResult & { bytes?: Buffer }> {
  let bytes: Buffer;
  try {
    bytes = await readFile(source);
  } catch (cause) {
    throw cantOpenCause(cause);
  }
  const { result, bytes: output } = autoRotateBuffer(bytes, options);
  if (destination === undefined) return { ...result, bytes: output };
  await writeFile(destination, output);
  return result;
}

/**
 * Writes an orientation value into a JPEG or AVIF buffer without touching the image data.
 *
 * A JPEG without an Exif block gets a minimal one (`insertOrientation`). An AVIF gets an
 * `irot`/`imir` property (`setAvifOrientation`), which is a rebuild of `meta` with the `iloc` extents
 * fixed up; the image data is copied byte for byte.
 */
export function setOrientation(bytes: Uint8Array, value: number): Buffer {
  if (isAvif(bytes)) return setAvifOrientation(bytes, value);
  return insertOrientation(bytes, value);
}

/**
 * True when the buffer is a JPEG that this package can transform.
 *
 * Always false for AVIF: the container is understood, the pixels are not re-encodable losslessly.
 */
export function canTransform(bytes: Uint8Array): boolean {
  if (isAvif(bytes)) return false;
  try {
    transformJpeg(bytes, { primitive: "none" });
    return true;
  } catch (error) {
    if (OrientError.is(error)) return false;
    throw error;
  }
}
