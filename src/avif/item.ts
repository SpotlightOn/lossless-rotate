/**
 * The item structure of an AVIF file: `meta` with its `iprp` (item properties).
 *
 * An AVIF still image is one *item*, described by `iinf`/`infe`, located through `iloc`, and dressed
 * up by *properties* in `iprp`: `ipco` holds the properties (the image size in `ispe`, the codec
 * configuration in `av1C`, the colour information, and the two this package edits, `irot` and
 * `imir`), while `ipma` holds, for every item, the list of property indices that apply to it.
 *
 * This module reads that structure and rebuilds the boxes that hold it. It never touches `mdat`.
 */

import { OrientError } from "../errors.ts";
import {
  buildBoxHeader,
  childrenOf,
  findBox,
  type IsoBox,
  isoBoxes,
  u16be,
  u32be,
  writeU16be,
  writeU32be,
} from "./container.ts";

function invalid(message: string): never {
  throw new OrientError("E_INVALID_AVIF", `invalid AVIF structure: ${message}`);
}

/** One property index associated with an item, and whether the item cannot be shown without it. */
export interface IpmaAssociation {
  index: number;
  essential: boolean;
}

export interface IpmaEntry {
  id: number;
  associations: IpmaAssociation[];
}

export interface Ipma {
  version: number;
  flags: number;
  entries: IpmaEntry[];
}

/** The `meta` subtree this layer cares about, with the boxes still pointing into the file buffer. */
export interface AvifLayout {
  /** All top-level boxes. */
  top: IsoBox[];
  meta: IsoBox;
  metaChildren: IsoBox[];
  iprp: IsoBox;
  iprpChildren: IsoBox[];
  ipco: IsoBox;
  ipma: IsoBox;
  /** `iloc`, which has to be fixed up when `meta` changes size. */
  iloc: IsoBox | null;
  /** Children of `ipco`, in order: property `n` is `properties[n - 1]`. */
  properties: IsoBox[];
  ipmaEntries: Ipma;
  /** Item id of the primary (the displayed) image item. */
  primaryId: number;
}

function requireBytes(offset: number, length: number, limit: number, what: string): void {
  if (offset < 0 || offset + length > limit) invalid(`${what} runs past the end of its box`);
}

/** Parses an `ipma` box into its per-item property association lists. */
export function parseIpma(buffer: Uint8Array, box: IsoBox): Ipma {
  const version = buffer[box.bodyOffset]!;
  const flags = (u32be(buffer, box.bodyOffset) & 0xffffff) >>> 0;
  const wide = (flags & 1) !== 0;
  let offset = box.bodyOffset + 4;
  requireBytes(offset, 4, box.bodyEnd, "the ipma entry count");
  const entryCount = u32be(buffer, offset);
  offset += 4;

  const entries: IpmaEntry[] = [];
  for (let entry = 0; entry < entryCount; entry += 1) {
    const idSize = version < 1 ? 2 : 4;
    requireBytes(offset, idSize + 1, box.bodyEnd, `ipma entry ${entry}`);
    const id = version < 1 ? u16be(buffer, offset) : u32be(buffer, offset);
    offset += idSize;
    const count = buffer[offset]!;
    offset += 1;

    const associations: IpmaAssociation[] = [];
    for (let i = 0; i < count; i += 1) {
      if (wide) {
        requireBytes(offset, 2, box.bodyEnd, `ipma entry ${entry}`);
        const value = u16be(buffer, offset);
        offset += 2;
        const index = value & 0x7fff;
        if (index !== 0) associations.push({ index, essential: (value & 0x8000) !== 0 });
      } else {
        requireBytes(offset, 1, box.bodyEnd, `ipma entry ${entry}`);
        const value = buffer[offset]!;
        offset += 1;
        const index = value & 0x7f;
        if (index !== 0) associations.push({ index, essential: (value & 0x80) !== 0 });
      }
    }
    entries.push({ id, associations });
  }
  return { version, flags, entries };
}

/**
 * Serialises an `ipma` box.
 *
 * The index width follows the flags, exactly like the reader: seven bits per association unless bit
 * zero is set, in which case fifteen. A list that no longer fits in seven bits switches the flag on,
 * which is legal because the flag describes the whole box.
 */
export function buildIpma(ipma: Ipma): Buffer {
  const maxIndex = ipma.entries.reduce(
    (highest, entry) => entry.associations.reduce((inner, association) => Math.max(inner, association.index), highest),
    0,
  );
  const wide = (ipma.flags & 1) !== 0 || maxIndex > 0x7f;
  const flags = (ipma.flags & 0xfffffe) | (wide ? 1 : 0);

  const parts: Buffer[] = [];
  for (const entry of ipma.entries) {
    const head = Buffer.alloc(ipma.version < 1 ? 3 : 5);
    if (ipma.version < 1) writeU16be(head, 0, entry.id);
    else writeU32be(head, 0, entry.id);
    head[head.length - 1] = entry.associations.length;
    parts.push(head);
    for (const association of entry.associations) {
      if (wide) {
        const value = Buffer.alloc(2);
        writeU16be(value, 0, association.index | (association.essential ? 0x8000 : 0));
        parts.push(value);
      } else {
        parts.push(Buffer.from([(association.index & 0x7f) | (association.essential ? 0x80 : 0)]));
      }
    }
  }

  const header = Buffer.alloc(4);
  header[0] = ipma.version;
  header[1] = (flags >> 16) & 0xff;
  header[2] = (flags >> 8) & 0xff;
  header[3] = flags & 0xff;
  const count = Buffer.alloc(4);
  writeU32be(count, 0, ipma.entries.length);

  const payload = Buffer.concat([header, count, ...parts]);
  return Buffer.concat([buildBoxHeader("ipma", payload.length), payload]);
}

/** Locates the `meta` subtree of an AVIF file. */
export function avifLayout(buffer: Uint8Array): AvifLayout {
  const top = isoBoxes(buffer, 0, buffer.length);
  const meta = findBox(top, "meta");
  if (meta === null) invalid("no meta box");
  const metaChildren = childrenOf(buffer, meta);
  const iprp = findBox(metaChildren, "iprp");
  if (iprp === null) invalid("the meta box has no iprp box");
  const iprpChildren = childrenOf(buffer, iprp);
  const ipco = findBox(iprpChildren, "ipco");
  const ipma = findBox(iprpChildren, "ipma");
  if (ipco === null) invalid("the iprp box has no ipco box");
  if (ipma === null) invalid("the iprp box has no ipma box");

  return {
    top,
    meta,
    metaChildren,
    iprp,
    iprpChildren,
    ipco,
    ipma,
    iloc: findBox(metaChildren, "iloc"),
    properties: childrenOf(buffer, ipco),
    ipmaEntries: parseIpma(buffer, ipma),
    primaryId: primaryItemId(buffer, metaChildren),
  };
}

/** The item id of the primary item, from `pitm`; 1 when the box is missing. */
export function primaryItemId(buffer: Uint8Array, metaChildren: IsoBox[]): number {
  const pitm = findBox(metaChildren, "pitm");
  if (pitm === null) return 1;
  const version = buffer[pitm.bodyOffset]!;
  return version === 0 ? u16be(buffer, pitm.bodyOffset + 4) : u32be(buffer, pitm.bodyOffset + 4);
}

/** Property indices (1-based into `ipco`) that apply to an item, in file order. */
export function associationsOf(layout: AvifLayout, itemId: number): number[] {
  const entry = layout.ipmaEntries.entries.find((candidate) => candidate.id === itemId);
  return entry === undefined ? [] : entry.associations.map((association) => association.index);
}

/** 1-based index of the first `ipco` property of the given type, or `null`. */
export function propertyIndexOfType(layout: AvifLayout, type: string): number | null {
  const index = layout.properties.findIndex((box) => box.type === type);
  return index === -1 ? null : index + 1;
}

/** The property box a 1-based index refers to, or `null` when the index is out of range. */
export function propertyAt(layout: AvifLayout, index: number): IsoBox | null {
  return layout.properties[index - 1] ?? null;
}

export interface AvifSize {
  width: number;
  height: number;
}

/**
 * Image size of the primary item, read from the `ispe` property that applies to it.
 *
 * @throws OrientError E_INVALID_AVIF when the primary item has no readable `ispe`.
 */
export function avifImageSize(buffer: Uint8Array, layout: AvifLayout): AvifSize {
  for (const index of associationsOf(layout, layout.primaryId)) {
    const property = propertyAt(layout, index);
    if (property !== null && property.type === "ispe") {
      if (property.bodyEnd - property.bodyOffset < 12) invalid("the ispe property is too short");
      return { width: u32be(buffer, property.bodyOffset + 4), height: u32be(buffer, property.bodyOffset + 8) };
    }
  }
  invalid("the primary item has no ispe property");
}

/** Types of the `ipco` properties, in file order, for a human reading `info`. */
export function avifPropertyTypes(layout: AvifLayout): string[] {
  return layout.properties.map((box) => box.type);
}

/**
 * Rewrites `iloc` so that item extents keep pointing at the same bytes after `meta` changed size.
 *
 * An AVIF that stores its image data in `mdat` records absolute file offsets (`construction_method`
 * 0, no base offset). Growing or shrinking `meta` moves everything behind it, so every extent that
 * sat behind the old `meta` moves by the same delta. Data stored in `idat` (`construction_method` 1)
 * is addressed relative to that box and needs no fix-up.
 */
function shiftIloc(buffer: Uint8Array, layout: AvifLayout, iloc: IsoBox, delta: number): Buffer {
  const bytes = Buffer.from(buffer.subarray(iloc.offset, iloc.bodyEnd));
  if (delta === 0) return bytes;

  let offset = iloc.bodyOffset - iloc.offset;
  const version = bytes[offset]!;
  offset += 4;
  const offsetSize = bytes[offset]! >> 4;
  const lengthSize = bytes[offset]! & 0x0f;
  offset += 1;
  const baseOffsetSize = bytes[offset]! >> 4;
  const indexSize = bytes[offset]! & 0x0f;
  offset += 1;
  const itemCount = (bytes[offset]! << 8) | bytes[offset + 1]!;
  offset += 2;

  const shiftFrom = layout.meta.offset;
  const shift = (position: number): number => (position >= shiftFrom ? position + delta : position);

  const readUInt = (size: number): number => {
    let value = 0;
    for (let i = 0; i < size; i += 1) value = value * 256 + bytes[offset + i]!;
    return value;
  };
  const writeUInt = (size: number, value: number): void => {
    for (let i = size - 1; i >= 0; i -= 1) {
      bytes[offset + i] = value & 0xff;
      value = Math.floor(value / 256);
    }
  };

  // item_ID is 16 bits in iloc version 0 and 1, but 32 bits in version 2. Getting this wrong does
  // not fail loudly: every following field would be read two bytes early and the extents would be
  // rewritten in the wrong place, silently pointing the image data at nothing.
  const itemIdSize = version === 2 ? 4 : 2;

  for (let item = 0; item < itemCount; item += 1) {
    offset += itemIdSize; // item_ID
    let constructionMethod = 0;
    if (version >= 1) {
      constructionMethod = ((bytes[offset]! << 8) | bytes[offset + 1]!) & 0x0f;
      offset += 2;
    }
    offset += 2; // data_reference_index
    if (baseOffsetSize > 0) {
      if (constructionMethod === 0) {
        const position = readUInt(baseOffsetSize);
        writeUInt(baseOffsetSize, shift(position));
      }
      offset += baseOffsetSize;
    }
    const extentCount = (bytes[offset]! << 8) | bytes[offset + 1]!;
    offset += 2;
    for (let extent = 0; extent < extentCount; extent += 1) {
      if (indexSize > 0) offset += indexSize;
      if (constructionMethod === 0 && offsetSize > 0) {
        const position = readUInt(offsetSize);
        writeUInt(offsetSize, shift(position));
      }
      offset += offsetSize;
      offset += lengthSize;
    }
  }
  return bytes;
}

/**
 * Rebuilds the file with new `ipco` and `ipma` boxes, keeping every other byte where it was.
 *
 * `iprp`, `meta` and the top level are assembled around the replacements, and `iloc` is fixed up for
 * the size change so the image data is still found. Everything else - including `mdat` - is copied
 * verbatim.
 */
export function rebuildMeta(
  buffer: Uint8Array,
  layout: AvifLayout,
  replacements: { ipco: Buffer; ipma: Buffer },
): { bytes: Buffer; delta: number } {
  const delta = replacements.ipco.length + replacements.ipma.length - layout.ipco.size - layout.ipma.size;

  const iprpChildren = layout.iprpChildren.map((box) => {
    if (box.type === "ipco") return replacements.ipco;
    if (box.type === "ipma") return replacements.ipma;
    return Buffer.from(buffer.subarray(box.offset, box.bodyEnd));
  });
  const iprpPayload = Buffer.concat(iprpChildren);
  const iprp = Buffer.concat([buildBoxHeader("iprp", iprpPayload.length), iprpPayload]);

  const metaChildren = layout.metaChildren.map((box) => {
    if (box.type === "iprp") return iprp;
    if (box.type === "iloc") return shiftIloc(buffer, layout, box, delta);
    return Buffer.from(buffer.subarray(box.offset, box.bodyEnd));
  });
  const metaPayload = Buffer.concat([
    Buffer.from(buffer.subarray(layout.meta.bodyOffset, layout.meta.bodyOffset + 4)),
    ...metaChildren,
  ]);
  const meta = Buffer.concat([buildBoxHeader("meta", metaPayload.length), metaPayload]);

  const top = layout.top.map((box) =>
    box.type === "meta" ? meta : Buffer.from(buffer.subarray(box.offset, box.bodyEnd)),
  );
  return { bytes: Buffer.concat(top), delta };
}

/** Reads the one-byte angle/axis body of an `irot`/`imir` property. */
export function propertyByte(buffer: Uint8Array, property: IsoBox): number {
  if (property.bodyEnd - property.bodyOffset < 1) invalid(`the ${property.type} property is empty`);
  return buffer[property.bodyOffset]!;
}
