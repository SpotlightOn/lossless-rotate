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
import { cantOpenCause } from "./errors.ts";
import { readOrientationFromFile, writeOrientationToFile } from "./file.ts";

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
export function orientation(source: string, value?: number): Promise<number> {
  return value === undefined
    ? readOrientationFromFile(source)
    : writeOrientationToFile(source, value).then((result) => result.value);
}

/** Reads a whole JPEG file; exported because every other entry point works on buffers. */
export async function readJpeg(source: string): Promise<Buffer> {
  try {
    return await readFile(source);
  } catch (cause) {
    throw cantOpenCause(cause);
  }
}
