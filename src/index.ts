/**
 * @chimok/lossless-rotate - make JPEGs upright, and read/write the orientation of AVIF.
 *
 * Read and write the orientation of JPEG (Exif tag) and AVIF (`irot`/`imir` property), rotate and
 * crop JPEG images losslessly in the DCT domain: no dequantization, no requantization, no quality
 * loss. Zero dependencies.
 *
 *   import { autoRotate, crop, orientation } from "@chimok/lossless-rotate";
 *
 *   await orientation("IMG_0001.jpg");                 // -> 6
 *   await orientation("IMG_0001.jpg", 1);              // metadata only, lossless
 *   await autoRotate("IMG_0001.jpg", "upright.jpg");   // lossless rotation
 *   await crop("IMG_0001.jpg", { x: 0, y: 0, width: 800, height: 600 }, "crop.jpg");
 *
 *   await orientation("photo.avif");                   // -> 6, from the irot/imir property
 *   await orientation("photo.avif", 6);                // metadata only, adds irot/imir if needed
 */

export type { AutoRotateOptions, AutoRotateResult } from "./autoRotate.ts";
export { autoRotate, autoRotateBuffer, canTransform, setOrientation } from "./autoRotate.ts";
export type { IsoBox } from "./avif/container.ts";
export { isAvif, isAvifSequence, parseLocalBoxes } from "./avif/container.ts";
export type { AvifLayout, AvifSize } from "./avif/item.ts";
export { avifImageSize, avifLayout, avifPropertyTypes } from "./avif/item.ts";
export type { AvifPatchResult } from "./avif/orientation.ts";
export {
  avifImageSizeFromBuffer,
  readAvifOrientation,
  setAvifOrientation,
  writeAvifOrientation,
} from "./avif/orientation.ts";
export type { CropOptions, CropResult } from "./crop.ts";
export { crop, cropBuffer } from "./crop.ts";
export type { ErrorCode } from "./errors.ts";
export { OrientError } from "./errors.ts";
export type { ByteOrder, ExifThumbnail, OrientationLocation, PatchResult } from "./exif.ts";
export {
  buildExifApp1,
  buildExifTiff,
  insertOrientation,
  locateExifThumbnail,
  locateOrientation,
  locateOrientationInExifBlock,
  orientationToString,
  patchOrientation,
  patchOrientationInExifBlock,
  readOrientation,
  readOrientationInExifBlock,
  replaceExifThumbnail,
} from "./exif.ts";
export type { WriteOrientationResult } from "./file.ts";
export { readOrientationFromFile, writeOrientationToFile } from "./file.ts";
export type { TransformOptions, TransformResult } from "./jpeg/codec.ts";
export { transformJpeg } from "./jpeg/codec.ts";
export type { ComponentCoefficients } from "./jpeg/decoder.ts";
export { decodeCoefficients } from "./jpeg/decoder.ts";
export type {
  ComponentCrop,
  ComponentGeometry,
  CropGeometry,
  CropRegion,
  Frame,
  FrameComponent,
  FrameGeometry,
} from "./jpeg/geometry.ts";
export { cropGeometry, cropRegionToString, frameGeometry, isPerfectTransform, swapsAxes } from "./jpeg/geometry.ts";
export type { ParsedJpeg, QuantizationTable, Scan } from "./jpeg/parse.ts";
export { parseJpeg } from "./jpeg/parse.ts";
export { findExifApp1, jpegSegments, MARKER } from "./markers.ts";
export type { OrientationPrimitive, OrientationTransform, Rotation } from "./orientation.ts";
export { composeTransforms, isIdentity, transformFor, transformForRotation } from "./orientation.ts";

import { readFile } from "node:fs/promises";
import { cantOpenCause, OrientError } from "./errors.ts";
import { readOrientationFromFile, writeOrientationToFile } from "./file.ts";

/** Callback shape of the v1 package, kept so that existing call sites keep working. */
export type OrientationCallback = (error: Error | null, orientation?: number) => void;

function withCallback<T>(promise: Promise<T>, callback?: (error: Error | null, value?: T) => void): Promise<T> {
  if (callback === undefined) return promise;
  promise.catch(() => undefined);
  promise
    .then(
      (value) => callback(null, value),
      (error: unknown) => callback(error instanceof Error ? error : new OrientError("E_INVALID_VALUE", String(error))),
    )
    .catch((error: unknown) => {
      // An exception thrown by the callback itself has to surface as an uncaught exception.
      queueMicrotask(() => {
        throw error;
      });
    });
  return promise;
}

/**
 * Reads the orientation of a JPEG or AVIF file, or sets it when a value is passed.
 *
 * Setting only rewrites metadata; it never rotates the image and never re-encodes it. For JPEG it is
 * ten bytes patched in place; an AVIF with no `irot`/`imir` property gets one, without touching the
 * image data. Use `autoRotate` to actually rotate - for JPEG, which can be rotated losslessly; AVIF
 * has no lossless rotation of its bitstream, so the orientation property is the answer there.
 *
 * @returns the orientation value, or 0 when the file has no orientation.
 */
export function orientation(source: string, callback?: OrientationCallback): Promise<number>;
export function orientation(source: string, value: number, callback?: OrientationCallback): Promise<number>;
export function orientation(
  source: string,
  valueOrCallback?: number | OrientationCallback,
  maybeCallback?: OrientationCallback,
): Promise<number> {
  const isWrite = typeof valueOrCallback === "number";
  const callback = typeof valueOrCallback === "function" ? valueOrCallback : maybeCallback;
  const promise = isWrite
    ? writeOrientationToFile(source, valueOrCallback).then((result) => result.value)
    : readOrientationFromFile(source);
  return withCallback(promise, callback);
}

/** Reads a whole JPEG file; exported because every other entry point works on buffers. */
export async function readJpeg(source: string): Promise<Buffer> {
  try {
    return await readFile(source);
  } catch (cause) {
    throw cantOpenCause(cause);
  }
}
