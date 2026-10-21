/**
 * EXIF orientation: read it, patch it in place, add it if missing.
 *
 * Written against the Exif 2.3 specification (TIFF header, IFD0, tag 0x0112) and JP 2.3 (the APP1
 * segment layout), so it is a from-scratch pure-JavaScript implementation with no native code. The
 * parsing rules deliberately follow what the v1 package accepted and rejected, with these
 * differences:
 *
 *  - every leading segment is walked, not just "APP0 then APP1";
 *  - a 32-bit IFD0 offset is supported instead of only the lower 16 bits;
 *  - writing to a file without an orientation tag raises E_INVALID_EXIF instead of silently
 *    doing nothing and returning 0;
 *  - the value to write must be an integer 1..8 (v1 wrote whatever it was given, including 0,
 *    which then acted as a read request).
 *
 * Like v1, the writer rewrites the whole 12-byte IFD entry as SHORT/1 and never re-encodes image
 * data, so patching a file stays lossless.
 *
 * Only finding and patching are JPEG specific (`locateOrientation`, `patchOrientation`); everything
 * below that works on any buffer that contains a TIFF block (`locateOrientationInExifBlock`,
 * `patchOrientationInExifBlock`, `buildExifTiff`). Such a block may sit inside any container that
 * carries Exif: an AVIF `Exif` item holds the same TIFF structure as an APP1 payload, without the
 * "Exif\0\0" signature the JPEG format wraps around it.
 *
 * The same is true for the embedded thumbnail (`locateExifThumbnail`, `replaceExifThumbnail`): an
 * Exif block may carry a small JPEG copy of the image in IFD1, reachable through tags 0x0201/0x0202.
 * Replacing it changes the length of the block, so every offset that points behind the thumbnail has
 * to be shifted - pure TIFF bookkeeping, which is why it lives here and not in the JPEG layer.
 */

import { OrientError } from "./errors.ts";
import { findExifApp1, jpegSegments } from "./markers.ts";

export type ByteOrder = "little" | "big";

/** Where the orientation lives inside the buffer, plus its current value. */
export interface OrientationLocation {
  byteOrder: ByteOrder;
  /** Absolute offset of the 12-byte IFD entry (the tag field). */
  entryOffset: number;
  /** Absolute offset of the entry's 4-byte value field. */
  valueOffset: number;
  /** TIFF field type of the entry as it is stored (3 = SHORT). Not validated, as in v1. */
  format: number;
  /** Number of values declared for the entry. Not validated, as in v1. */
  count: number;
  /** Orientation value as stored, decoded as a 16-bit number. */
  value: number;
  /**
   * False when the stored value would be rejected by a reader (does not fit into one byte, or is
   * greater than 8). Such a file can still be repaired by writing a valid value.
   */
  valueValid: boolean;
  /** Number of entries in IFD0. */
  tagCount: number;
}

export interface PatchResult {
  byteOrder: ByteOrder;
  entryOffset: number;
  /** Absolute offset of the first byte that was rewritten. */
  writtenOffset: number;
  /** Number of bytes rewritten (always 10, as in v1). */
  writtenLength: number;
  /** Value before the patch, or `null` when it was not a valid orientation. */
  previousValue: number | null;
  value: number;
}

const TAG_ORIENTATION = 0x0112;

function fail(code: "E_INVALID_EXIF" | "E_INVALID_VALUE", message: string): never {
  throw new OrientError(code, message);
}

function u16(buffer: Uint8Array, offset: number, byteOrder: ByteOrder): number {
  return byteOrder === "big"
    ? (buffer[offset]! << 8) | buffer[offset + 1]!
    : (buffer[offset + 1]! << 8) | buffer[offset]!;
}

function u32(buffer: Uint8Array, offset: number, byteOrder: ByteOrder): number {
  return byteOrder === "big"
    ? ((buffer[offset]! << 24) | (buffer[offset + 1]! << 16) | (buffer[offset + 2]! << 8) | buffer[offset + 3]!) >>> 0
    : ((buffer[offset + 3]! << 24) | (buffer[offset + 2]! << 16) | (buffer[offset + 1]! << 8) | buffer[offset]!) >>> 0;
}

function writeU16(buffer: Uint8Array, offset: number, value: number, byteOrder: ByteOrder): void {
  if (byteOrder === "big") {
    buffer[offset] = (value >> 8) & 0xff;
    buffer[offset + 1] = value & 0xff;
  } else {
    buffer[offset + 1] = (value >> 8) & 0xff;
    buffer[offset] = value & 0xff;
  }
}

function writeU32(buffer: Uint8Array, offset: number, value: number, byteOrder: ByteOrder): void {
  if (byteOrder === "big") {
    buffer[offset] = (value >>> 24) & 0xff;
    buffer[offset + 1] = (value >>> 16) & 0xff;
    buffer[offset + 2] = (value >>> 8) & 0xff;
    buffer[offset + 3] = value & 0xff;
  } else {
    buffer[offset + 3] = (value >>> 24) & 0xff;
    buffer[offset + 2] = (value >>> 16) & 0xff;
    buffer[offset + 1] = (value >>> 8) & 0xff;
    buffer[offset] = value & 0xff;
  }
}

/**
 * Locates the orientation tag inside an in-memory JPEG.
 *
 * @param options.strictValue when false, a stored value that a reader would reject (out of range or
 * wider than one byte) does not raise; the location is returned with `valueValid: false` so the
 * entry can still be repaired. Reads are strict, the writer uses the lenient mode.
 * @returns the location, or `null` when the file is a readable JPEG with a readable Exif block but
 * without an orientation tag (v1 returned 0 in that case as well).
 * @throws OrientError E_NOT_JPEG / E_PREMATURE_END / E_INVALID_EXIF.
 */
export function locateOrientation(
  buffer: Uint8Array,
  options: { strictValue?: boolean } = {},
): OrientationLocation | null {
  const exif = findExifApp1(buffer);
  if (exif === null) return null;
  return locateOrientationInExifBlock(buffer, exif.tiffOffset, exif.end, options);
}

/**
 * Locates the orientation tag in any buffer that holds a TIFF block, e.g. an AVIF `Exif` item.
 *
 * Offsets are absolute in `buffer`; `end` is the first byte behind the block, so a container can
 * hand in a payload without copying it. Everything behind the block is invisible to the parser,
 * exactly as a container chunk boundary should be.
 *
 * @throws OrientError E_INVALID_EXIF (a block that is truncated or structurally broken).
 */
export function locateOrientationInExifBlock(
  buffer: Uint8Array,
  tiffOffset: number,
  end: number,
  options: { strictValue?: boolean } = {},
): OrientationLocation | null {
  const strictValue = options.strictValue ?? true;
  if (tiffOffset + 8 > end) fail("E_INVALID_EXIF", "invalid Exif data: TIFF header is truncated");

  const orderMark = [buffer[tiffOffset], buffer[tiffOffset + 1]];
  let byteOrder: ByteOrder;
  if (orderMark[0] === 0x49 && orderMark[1] === 0x49) byteOrder = "little";
  else if (orderMark[0] === 0x4d && orderMark[1] === 0x4d) byteOrder = "big";
  else fail("E_INVALID_EXIF", "invalid Exif data: byte order mark is neither II nor MM");

  if (u16(buffer, tiffOffset + 2, byteOrder) !== 42) {
    fail("E_INVALID_EXIF", "invalid Exif data: TIFF magic is not 42");
  }

  const ifd0Start = tiffOffset + u32(buffer, tiffOffset + 4, byteOrder);
  if (ifd0Start + 2 > end) fail("E_INVALID_EXIF", "invalid Exif data: IFD0 starts past the Exif block");

  const tagCount = u16(buffer, ifd0Start, byteOrder);
  if (tagCount === 0) fail("E_INVALID_EXIF", "invalid Exif data: IFD0 declares zero tags");

  const entriesStart = ifd0Start + 2;
  for (let index = 0; index < tagCount; index++) {
    const entryOffset = entriesStart + index * 12;
    // v1 stops here and reports "no orientation" instead of an error.
    if (entryOffset + 12 > end) return null;

    if (u16(buffer, entryOffset, byteOrder) !== TAG_ORIENTATION) continue;

    const valueOffset = entryOffset + 8;
    const lowByte = byteOrder === "big" ? buffer[valueOffset + 1]! : buffer[valueOffset]!;
    const highByte = byteOrder === "big" ? buffer[valueOffset]! : buffer[valueOffset + 1]!;
    const valueValid = highByte === 0 && lowByte <= 8;

    if (strictValue && !valueValid) {
      if (highByte !== 0) fail("E_INVALID_EXIF", "invalid Exif data: orientation value does not fit into one byte");
      fail("E_INVALID_EXIF", `invalid Exif data: orientation value ${lowByte} is out of range`);
    }

    return {
      byteOrder,
      entryOffset,
      valueOffset,
      format: u16(buffer, entryOffset + 2, byteOrder),
      count: u32(buffer, entryOffset + 4, byteOrder),
      value: lowByte,
      valueValid,
      tagCount,
    };
  }

  return null;
}

/** Reads the orientation, or 0 when there is no orientation tag (v1 semantics). */
export function readOrientation(buffer: Uint8Array): number {
  return locateOrientation(buffer)?.value ?? 0;
}

/** Reads the orientation out of any buffer that holds a TIFF block; 0 when there is no tag. */
export function readOrientationInExifBlock(buffer: Uint8Array, tiffOffset: number, end: number): number {
  return locateOrientationInExifBlock(buffer, tiffOffset, end)?.value ?? 0;
}

function assertWritableValue(value: number): asserts value is number {
  if (!Number.isInteger(value) || value < 1 || value > 8) {
    fail("E_INVALID_VALUE", `orientation must be an integer between 1 and 8, got ${value}`);
  }
}

function patchLocation(buffer: Uint8Array, location: OrientationLocation, value: number): PatchResult {
  const { byteOrder, entryOffset, value: storedValue, valueValid } = location;
  const previousValue = valueValid ? storedValue : null;
  // v1 rewrites the whole entry as SHORT/count-1 instead of only the value bytes.
  writeU16(buffer, entryOffset + 2, 3, byteOrder); // format = unsigned short
  writeU32(buffer, entryOffset + 4, 1, byteOrder); // number of components = 1
  writeU16(buffer, entryOffset + 8, value, byteOrder); // value, stored inline
  writeU16(buffer, entryOffset + 10, 0, byteOrder); // padding, kept at zero like v1

  return { byteOrder, entryOffset, writtenOffset: entryOffset + 2, writtenLength: 10, previousValue, value };
}

/**
 * Rewrites the orientation entry in place and returns what changed.
 *
 * Exactly 10 bytes are written (format, count and value of the IFD entry), matching the byte range
 * the v1 addon patched, so no image data is touched and the operation stays lossless.
 *
 * A stored value that a reader would reject (0, 9, ...) does not prevent the write: v1 could repair
 * such a file and so does this implementation. `previousValue` is then `null`.
 */
export function patchOrientation(buffer: Uint8Array, value: number): PatchResult {
  assertWritableValue(value);

  const location = locateOrientation(buffer, { strictValue: false });
  if (location === null) {
    fail("E_INVALID_EXIF", "invalid Exif data: no orientation tag to update (use insertOrientation to add one)");
  }

  return patchLocation(buffer, location, value);
}

/**
 * Rewrites the orientation entry inside any buffer that holds a TIFF block: the same ten bytes, at
 * the same absolute offsets, with the same guarantees.
 */
export function patchOrientationInExifBlock(
  buffer: Uint8Array,
  tiffOffset: number,
  end: number,
  value: number,
): PatchResult {
  assertWritableValue(value);

  const location = locateOrientationInExifBlock(buffer, tiffOffset, end, { strictValue: false });
  if (location === null) {
    fail("E_INVALID_EXIF", "invalid Exif data: no orientation tag to update");
  }

  return patchLocation(buffer, location, value);
}

/**
 * Builds a bare TIFF block that contains nothing but the orientation tag.
 *
 * `buildExifApp1` wraps the same block in an APP1 segment for JPEG.
 */
export function buildExifTiff(value: number, options: { byteOrder?: ByteOrder } = {}): Buffer {
  assertWritableValue(value);
  const byteOrder = options.byteOrder ?? "little";

  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write(byteOrder === "big" ? "MM\x00\x2a" : "II\x2a\x00", 0, "latin1");
  writeU32(tiff, 4, 8, byteOrder);
  writeU16(tiff, 8, 1, byteOrder); // one IFD0 entry
  writeU16(tiff, 10, TAG_ORIENTATION, byteOrder);
  writeU16(tiff, 12, 3, byteOrder); // SHORT
  writeU32(tiff, 14, 1, byteOrder); // count 1, value inline
  writeU16(tiff, 18, value, byteOrder);
  writeU32(tiff, 22, 0, byteOrder); // no next IFD
  return tiff;
}

/** Builds a complete APP1/Exif segment that contains nothing but the orientation tag. */
export function buildExifApp1(value: number, options: { byteOrder?: ByteOrder } = {}): Buffer {
  const tiff = buildExifTiff(value, options);

  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const segment = Buffer.alloc(payload.length + 4);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  segment.writeUInt16BE(payload.length + 2, 2);
  payload.copy(segment, 4);
  return segment;
}

/** Offset right behind SOI (and behind the leading APP0/JFIF segment, if there is one). */
function exifInsertionOffset(buffer: Uint8Array): number {
  for (const segment of jpegSegments(buffer)) {
    if (segment.marker === 0xe0 && segment.offset === 2) return segment.payloadOffset + segment.payloadLength;
    break;
  }
  return 2;
}

/**
 * Returns a copy of `jpeg` with the orientation set: an existing Exif block is patched, otherwise a
 * minimal one is inserted behind SOI/JFIF.
 */
export function insertOrientation(jpeg: Uint8Array, value: number, options: { byteOrder?: ByteOrder } = {}): Buffer {
  assertWritableValue(value);

  if (findExifApp1(jpeg) !== null) {
    const copy = Buffer.from(jpeg);
    patchOrientation(copy, value);
    return copy;
  }

  const segment = buildExifApp1(value, options);
  const offset = exifInsertionOffset(jpeg);
  return Buffer.concat([Buffer.from(jpeg.subarray(0, offset)), segment, Buffer.from(jpeg.subarray(offset))]);
}

// ---------------------------------------------------------------------------
// The embedded Exif thumbnail
// ---------------------------------------------------------------------------

/** IFD1 tag: offset of the thumbnail JPEG, relative to the TIFF header. */
const TAG_JPEG_INTERCHANGE_FORMAT = 0x0201;
/** IFD1 tag: length of the thumbnail JPEG in bytes. */
const TAG_JPEG_INTERCHANGE_FORMAT_LENGTH = 0x0202;
const TAG_EXIF_IFD_POINTER = 0x8769;
const TAG_GPS_IFD_POINTER = 0x8825;
const TAG_INTEROP_IFD_POINTER = 0xa005;
const TAG_SUB_IFDS = 0x014a;

/** Byte size of one value of a TIFF field type (Exif 2.3, table 2). */
const TIFF_TYPE_SIZES: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  12: 8, // DOUBLE
  13: 4, // IFD
};

/** Where the embedded thumbnail of an Exif block sits and how it is declared. */
export interface ExifThumbnail {
  byteOrder: ByteOrder;
  /** Absolute offset of the first byte of the thumbnail JPEG. */
  dataOffset: number;
  /** Length of the thumbnail JPEG, as declared by tag 0x0202. */
  dataLength: number;
  /** Absolute offset of the 0x0201 value field (the offset of the thumbnail). */
  offsetValueOffset: number;
  /** Absolute offset of the 0x0202 value field (the length of the thumbnail). */
  lengthValueOffset: number;
  /** TIFF field type of the 0x0202 entry: 3 (SHORT) or 4 (LONG). */
  lengthFormat: number;
}

/**
 * Finds the JPEG thumbnail of an Exif block.
 *
 * The block is `[tiffOffset, end)` of `buffer`, as for `locateOrientationInExifBlock`; the IFD chain
 * is walked (IFD0 usually points at IFD1, which carries the tags) and the first IFD that declares a
 * thumbnail offset wins.
 *
 * @returns the location, or `null` when no IFD declares tag 0x0201 (a valid Exif block without a
 * thumbnail).
 * @throws OrientError E_INVALID_EXIF for a broken header, a broken IFD chain, or a thumbnail whose
 * offset or length does not fit into the block.
 */
export function locateExifThumbnail(buffer: Uint8Array, tiffOffset: number, end: number): ExifThumbnail | null {
  if (tiffOffset + 8 > end) fail("E_INVALID_EXIF", "invalid Exif data: TIFF header is truncated");

  const orderMark = [buffer[tiffOffset], buffer[tiffOffset + 1]];
  let byteOrder: ByteOrder;
  if (orderMark[0] === 0x49 && orderMark[1] === 0x49) byteOrder = "little";
  else if (orderMark[0] === 0x4d && orderMark[1] === 0x4d) byteOrder = "big";
  else fail("E_INVALID_EXIF", "invalid Exif data: byte order mark is neither II nor MM");

  if (u16(buffer, tiffOffset + 2, byteOrder) !== 42) {
    fail("E_INVALID_EXIF", "invalid Exif data: TIFF magic is not 42");
  }

  const seen = new Set<number>();
  let ifd = u32(buffer, tiffOffset + 4, byteOrder);
  while (ifd !== 0) {
    if (seen.has(ifd)) fail("E_INVALID_EXIF", "invalid Exif data: the IFD chain contains a loop");
    seen.add(ifd);

    const ifdStart = tiffOffset + ifd;
    if (ifdStart + 2 > end) fail("E_INVALID_EXIF", "invalid Exif data: an IFD starts past the Exif block");
    const tagCount = u16(buffer, ifdStart, byteOrder);
    const entriesEnd = ifdStart + 2 + tagCount * 12;
    if (entriesEnd + 4 > end) fail("E_INVALID_EXIF", "invalid Exif data: an IFD runs past the Exif block");

    let offsetValueOffset = -1;
    let lengthValueOffset = -1;
    let lengthFormat = 0;
    for (let index = 0; index < tagCount; index++) {
      const entryOffset = ifdStart + 2 + index * 12;
      const tag = u16(buffer, entryOffset, byteOrder);
      if (tag === TAG_JPEG_INTERCHANGE_FORMAT) offsetValueOffset = entryOffset + 8;
      else if (tag === TAG_JPEG_INTERCHANGE_FORMAT_LENGTH) {
        lengthValueOffset = entryOffset + 8;
        lengthFormat = u16(buffer, entryOffset + 2, byteOrder);
      }
    }

    if (offsetValueOffset >= 0) {
      if (lengthValueOffset < 0) {
        fail("E_INVALID_EXIF", "invalid Exif data: the thumbnail offset has no matching length tag 0x0202");
      }
      if (lengthFormat !== 3 && lengthFormat !== 4) {
        fail(
          "E_INVALID_EXIF",
          `invalid Exif data: unexpected TIFF field type ${lengthFormat} for the thumbnail length`,
        );
      }
      const relative = u32(buffer, offsetValueOffset, byteOrder);
      const dataOffset = tiffOffset + relative;
      const dataLength =
        lengthFormat === 3 ? u16(buffer, lengthValueOffset, byteOrder) : u32(buffer, lengthValueOffset, byteOrder);
      if (dataLength === 0 || dataOffset + dataLength > end) {
        fail(
          "E_INVALID_EXIF",
          `invalid Exif data: the thumbnail at offset ${relative} with ${dataLength} bytes does not fit into the Exif block`,
        );
      }
      return { byteOrder, dataOffset, dataLength, offsetValueOffset, lengthValueOffset, lengthFormat };
    }

    ifd = u32(buffer, entriesEnd, byteOrder);
  }

  return null;
}

/** One 4-byte field that holds an offset relative to the TIFF header. */
interface OffsetField {
  /** Offset of the value field itself, relative to the TIFF header. */
  position: number;
  /** The offset it holds, relative to the TIFF header. */
  target: number;
}

function isIfdPointerTag(tag: number): boolean {
  return tag === TAG_EXIF_IFD_POINTER || tag === TAG_GPS_IFD_POINTER || tag === TAG_INTEROP_IFD_POINTER;
}

/**
 * Collects every field of the block whose 4-byte value is an offset relative to the TIFF header.
 *
 * Three kinds of field exist: the IFD0 pointer in the header, the 4-byte value of a tag whose data
 * does not fit inline (it is stored behind the IFDs and the value is its offset), and the pointer
 * tags that lead to a sub-IFD (`ExifIFD`, `GPS`, `Interop`), plus the next-IFD pointer at the end of
 * every IFD. The tags that describe the thumbnail itself are skipped: 0x0201 points at the thumbnail
 * start, which does not move when the thumbnail is replaced in place.
 *
 * @throws OrientError E_INVALID_EXIF for anything the walk cannot interpret, because guessing would
 * silently corrupt offsets. Callers that only want to know *where* the thumbnail is do not need this.
 */
function collectOffsetFields(block: Uint8Array, byteOrder: ByteOrder): OffsetField[] {
  const fields: OffsetField[] = [{ position: 4, target: u32(block, 4, byteOrder) }];
  const visited = new Set<number>();
  walkIfd(block, byteOrder, u32(block, 4, byteOrder), visited, fields);
  return fields;
}

function walkIfd(
  block: Uint8Array,
  byteOrder: ByteOrder,
  ifd: number,
  visited: Set<number>,
  fields: OffsetField[],
): void {
  if (ifd === 0) return;
  if (visited.has(ifd)) fail("E_INVALID_EXIF", "invalid Exif data: the IFD chain contains a loop");
  visited.add(ifd);

  if (ifd + 2 > block.length) fail("E_INVALID_EXIF", "invalid Exif data: an IFD starts past the Exif block");
  const tagCount = u16(block, ifd, byteOrder);
  const entriesEnd = ifd + 2 + tagCount * 12;
  if (entriesEnd + 4 > block.length) fail("E_INVALID_EXIF", "invalid Exif data: an IFD runs past the Exif block");

  for (let index = 0; index < tagCount; index++) {
    const entryOffset = ifd + 2 + index * 12;
    const tag = u16(block, entryOffset, byteOrder);
    if (tag === TAG_JPEG_INTERCHANGE_FORMAT || tag === TAG_JPEG_INTERCHANGE_FORMAT_LENGTH) continue;

    const format = u16(block, entryOffset + 2, byteOrder);
    const count = u32(block, entryOffset + 4, byteOrder);
    const typeSize = TIFF_TYPE_SIZES[format];
    if (typeSize === undefined) fail("E_INVALID_EXIF", `invalid Exif data: unknown TIFF field type ${format}`);
    const size = typeSize * count;
    const valueOffset = entryOffset + 8;

    if (isIfdPointerTag(tag)) {
      if (format !== 4 || count !== 1) {
        fail("E_INVALID_EXIF", `invalid Exif data: tag 0x${tag.toString(16)} is not a single LONG pointer`);
      }
      const target = u32(block, valueOffset, byteOrder);
      fields.push({ position: valueOffset, target });
      walkIfd(block, byteOrder, target, visited, fields);
      continue;
    }

    if (tag === TAG_SUB_IFDS) {
      fail("E_INVALID_EXIF", "invalid Exif data: SubIFDs cannot be fixed up when the thumbnail moves");
    }

    // A value that does not fit into the four value bytes is stored behind the IFDs, so the field
    // itself holds an offset.
    if (size > 4) fields.push({ position: valueOffset, target: u32(block, valueOffset, byteOrder) });
  }

  // The next-IFD pointer is the last four bytes of the IFD, and it is an offset as well.
  const next = u32(block, entriesEnd, byteOrder);
  fields.push({ position: entriesEnd, target: next });
  walkIfd(block, byteOrder, next, visited, fields);
}

/**
 * Returns a copy of `buffer` whose Exif block has `data` as its thumbnail.
 *
 * The thumbnail is replaced in place, so its own offset (tag 0x0201) stays valid; the length field
 * (0x0202) is rewritten, and when the new thumbnail is longer or shorter every offset that points
 * behind it is shifted by the difference. When nothing but the thumbnail follows (the usual layout)
 * the shift is skipped entirely, which is the case that needs no interpretation of the block at all.
 *
 * @throws OrientError E_INVALID_EXIF when an offset behind the thumbnail cannot be fixed up safely.
 */
export function replaceExifThumbnail(
  buffer: Uint8Array,
  tiffOffset: number,
  end: number,
  thumbnail: ExifThumbnail,
  data: Uint8Array,
): Buffer {
  const { byteOrder } = thumbnail;
  const block = buffer.subarray(tiffOffset, end);
  const start = thumbnail.dataOffset - tiffOffset;
  const delta = data.length - thumbnail.dataLength;

  const spliced = Buffer.concat([
    Buffer.from(block.subarray(0, start)),
    Buffer.from(data),
    Buffer.from(block.subarray(start + thumbnail.dataLength)),
  ]);

  if (thumbnail.lengthFormat === 3) {
    if (data.length > 0xffff) {
      fail("E_INVALID_VALUE", `the thumbnail is too large for its SHORT length entry (${data.length} bytes)`);
    }
    writeU16(spliced, thumbnail.lengthValueOffset - tiffOffset, data.length, byteOrder);
  } else {
    writeU32(spliced, thumbnail.lengthValueOffset - tiffOffset, data.length, byteOrder);
  }

  if (delta !== 0 && thumbnail.dataOffset + thumbnail.dataLength !== end) {
    for (const field of collectOffsetFields(block, byteOrder)) {
      if (field.target < start) continue; // points in front of the thumbnail, so nothing moved
      const position = field.position >= start ? field.position + delta : field.position;
      if (position + 4 > spliced.length) {
        fail("E_INVALID_EXIF", "invalid Exif data: an offset field falls outside the Exif block after the update");
      }
      writeU32(spliced, position, field.target + delta, byteOrder);
    }
  }

  return Buffer.concat([Buffer.from(buffer.subarray(0, tiffOffset)), spliced, Buffer.from(buffer.subarray(end))]);
}

const ORIENTATION_NAMES: Record<number, string> = {
  1: "TopLeft",
  2: "TopRight",
  3: "BottomRight",
  4: "BottomLeft",
  5: "LeftTop",
  6: "RightTop",
  7: "RightBottom",
  8: "LeftBottom",
};

/**
 * Friendly name of an orientation value, position of the first row then the first column.
 * Returns `undefined` for unknown values, as in v1.
 */
export function orientationToString(value: number): string | undefined {
  return ORIENTATION_NAMES[value];
}
