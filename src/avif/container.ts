/**
 * Minimal ISOBMFF layer for AVIF.
 *
 * An AVIF file is a tree of ISO base media file format (ISOBMFF) boxes: a 32-bit size, a four
 * character type, then the body. `isAvif` looks at the `ftyp` box, `isoBoxes` walks one level of the
 * tree, and everything the orientation layer needs to know about the structure lives here. No image
 * data is ever decoded: the rotation this package understands for AVIF is a container property.
 *
 * Three box details matter:
 *
 *  - a box may carry a 64-bit size (`size == 1`, the real size follows the type) or mean "to the end
 *    of the enclosing box" (`size == 0`); both are handled;
 *  - some boxes are *full* boxes, so their four version/flags bytes sit in front of their children
 *    (`meta`, `iinf`, `iloc`, `ipma`, `pitm`), while `iprp` and `ipco` are plain containers;
 *  - `meta` is a full box, which is why `childrenOf` has to skip those four bytes for it.
 */

import { OrientError } from "../errors.ts";

/** Brands that mark a file as an AVIF image (`avif`) or an AVIF image sequence (`avis`). */
const AVIF_BRANDS = new Set(["avif", "avis"]);

/** The brand of a still-image AVIF: one item, one picture. */
const STILL_IMAGE_BRANDS = new Set(["avif"]);

/** The brand of an AVIF image sequence: track based, not an item based still image. */
const SEQUENCE_BRANDS = new Set(["avis"]);

/** Boxes whose body starts with a four byte version/flags field. */
const FULL_BOXES = new Set(["meta", "iinf", "ipma", "pitm", "iloc", "hdlr"]);

export interface IsoBox {
  type: string;
  /** Absolute offset of the box header (the size field). */
  offset: number;
  /** Total box size, header included. */
  size: number;
  /** Bytes the header occupies: 8, or 16 when the size is stored as a 64-bit value. */
  headerSize: number;
  /** Absolute offset of the first body byte. */
  bodyOffset: number;
  /** Absolute offset of the first byte behind the body. */
  bodyEnd: number;
  /** True when the box carries a version/flags field in front of its body. */
  full: boolean;
}

function invalid(message: string): never {
  throw new OrientError("E_INVALID_AVIF", `invalid AVIF structure: ${message}`);
}

export function latin1(buffer: Uint8Array, start: number, end: number): string {
  let text = "";
  for (let i = start; i < end; i += 1) text += String.fromCharCode(buffer[i]!);
  return text;
}

export function u16be(buffer: Uint8Array, offset: number): number {
  return ((buffer[offset]! << 8) | buffer[offset + 1]!) >>> 0;
}

export function u32be(buffer: Uint8Array, offset: number): number {
  return (
    ((buffer[offset]! << 24) | (buffer[offset + 1]! << 16) | (buffer[offset + 2]! << 8) | buffer[offset + 3]!) >>> 0
  );
}

/** 64-bit field, read as a number: box sizes above 2^53 do not exist in practice. */
export function u64be(buffer: Uint8Array, offset: number): number {
  return u32be(buffer, offset) * 0x100000000 + u32be(buffer, offset + 4);
}

export function writeU16be(buffer: Uint8Array, offset: number, value: number): void {
  buffer[offset] = (value >> 8) & 0xff;
  buffer[offset + 1] = value & 0xff;
}

export function writeU32be(buffer: Uint8Array, offset: number, value: number): void {
  buffer[offset] = (value >>> 24) & 0xff;
  buffer[offset + 1] = (value >>> 16) & 0xff;
  buffer[offset + 2] = (value >>> 8) & 0xff;
  buffer[offset + 3] = value & 0xff;
}

/** True when the buffer starts with a `ftyp` box that names an AVIF brand. */
export function isAvif(buffer: Uint8Array): boolean {
  if (buffer.length < 16) return false;
  const size = u32be(buffer, 0);
  if (size < 16 || size > buffer.length) return false;
  if (latin1(buffer, 4, 8) !== "ftyp") return false;
  return namesBrand(buffer, size, AVIF_BRANDS);
}

/**
 * True when the file is an AVIF *image sequence* (`avis`) and not a still image.
 *
 * A sequence stores its pictures in tracks and has no item based `meta` (`pitm`/`iinf`/`iloc`/
 * `iprp`), so there is no `irot`/`imir` property to read or write. A file that names both `avis` and
 * `avif` is a still image that can also be shown as a sequence; it is treated as still.
 */
export function isAvifSequence(buffer: Uint8Array): boolean {
  if (!isAvif(buffer)) return false;
  const size = u32be(buffer, 0);
  return namesBrand(buffer, size, SEQUENCE_BRANDS) && !namesBrand(buffer, size, STILL_IMAGE_BRANDS);
}

/** True when the `ftyp` box names one of `brands`, as major or as a compatible brand. */
function namesBrand(buffer: Uint8Array, size: number, brands: Set<string>): boolean {
  if (brands.has(latin1(buffer, 8, 12))) return true;
  // The major brand may be a generic one (`mif1`); the compatible brands then name the real format.
  for (let offset = 16; offset + 4 <= size; offset += 4) {
    if (brands.has(latin1(buffer, offset, offset + 4))) return true;
  }
  return false;
}

/**
 * Walks the boxes that sit directly inside `[start, end)`.
 *
 * The walk has to line up with the end of the range; a box that runs past it is a broken file, not a
 * partial answer. This matches the strictness of the JPEG and RIFF walkers.
 *
 * @throws OrientError E_INVALID_AVIF for a box size that does not fit the range.
 */
export function isoBoxes(buffer: Uint8Array, start: number, end: number): IsoBox[] {
  const boxes: IsoBox[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = u32be(buffer, offset);
    const type = latin1(buffer, offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) invalid(`box ${JSON.stringify(type)} at offset ${offset} has a truncated 64-bit size`);
      size = u64be(buffer, offset + 8);
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) {
      invalid(`box ${JSON.stringify(type)} at offset ${offset} declares ${size} bytes`);
    }
    boxes.push({
      type,
      offset,
      size,
      headerSize,
      bodyOffset: offset + headerSize,
      bodyEnd: offset + size,
      full: FULL_BOXES.has(type),
    });
    offset += size;
  }
  if (offset !== end) invalid(`${end - offset} trailing byte(s) after the last box`);
  return boxes;
}

/** The first box of the given type in a list, or `null`. */
export function findBox(boxes: IsoBox[], type: string): IsoBox | null {
  return boxes.find((box) => box.type === type) ?? null;
}

/** The boxes directly inside a container box, skipping the version/flags field of a full box. */
export function childrenOf(buffer: Uint8Array, box: IsoBox): IsoBox[] {
  return isoBoxes(buffer, box.bodyOffset + (box.full ? 4 : 0), box.bodyEnd);
}

/** Builds a box header (8 or 16 bytes) for a body of the given size. */
export function buildBoxHeader(type: string, bodyLength: number): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(bodyLength + 8, 0);
  header.write(type, 4, "latin1");
  return header;
}

/**
 * Parses a box sequence out of a standalone buffer, with offsets relative to that buffer.
 *
 * The write path rebuilds box bodies in small buffers of their own, where absolute offsets do not
 * exist yet; this is the reader for those, matching `isoBoxes` byte for byte.
 */
export function parseLocalBoxes(buffer: Uint8Array): IsoBox[] {
  return isoBoxes(buffer, 0, buffer.length);
}
