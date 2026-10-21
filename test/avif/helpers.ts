/**
 * AVIF-specific fixtures and helpers.
 *
 * The box walker below deliberately does not go through `src/avif/*.ts`, so the assertions never
 * compare the implementation with itself: the manifest and the hand-built fixtures are the
 * independent description of what a file has to look like.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { available, type Fixture, loadManifest } from "../core/helpers.ts";

export interface AvifAssociation {
  index: number;
  essential: boolean;
}

export interface AvifMeta {
  properties: string[];
  primaryId: number;
  width: number | null;
  height: number | null;
  irotOffset: number | null;
  imirOffset: number | null;
  associations: { id: number; list: AvifAssociation[] }[];
  mdatOffset: number | null;
  ilocVersion: number;
  ilocBaseOffsetSize: number;
  ilocExtentOffset: number;
  ilocExtentLength: number;
}

export interface AvifFixture extends Fixture {
  avif?: AvifMeta;
}

/** Scratch space for the tests that write files. One per test process. */
export const workDir = mkdtempSync(join(tmpdir(), "lossless-rotate-avif-"));
process.on("exit", () => rmSync(workDir, { recursive: true, force: true }));

const manifest = loadManifest<AvifFixture>();
export const avifFixtures = manifest.files.filter((fixture) => fixture.format === "avif");
export const readable = avifFixtures.filter((fixture) => fixture.expect?.read !== undefined);
export const broken = avifFixtures.filter((fixture) => fixture.expect?.error !== undefined);

export const HAVE_AVIF_TOOLS = available("avifenc") && available("avifdec");
export const HAVE_MAGICK = available("magick");

/** A bare `ftyp` box naming `brands`, enough for the brand predicates under test. */
export function ftyp(...brands: string[]): Buffer {
  const body = Buffer.concat([
    Buffer.from(brands[0] ?? "", "latin1"),
    Buffer.from([0, 0, 0, 0]),
    ...brands.slice(1).map((brand) => Buffer.from(brand, "latin1")),
  ]);
  const box = Buffer.alloc(8 + body.length);
  box.writeUInt32BE(box.length, 0);
  box.write("ftyp", 4, "latin1");
  body.copy(box, 8);
  return box;
}

export interface Box {
  type: string;
  offset: number;
  bodyOffset: number;
  bodyEnd: number;
}

export function boxesIn(buffer: Buffer, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      size = buffer.readUInt32BE(offset + 8) * 0x1_0000_0000 + buffer.readUInt32BE(offset + 12);
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    assert.ok(size >= headerSize && offset + size <= end, `box ${type} runs past its parent`);
    boxes.push({ type, offset, bodyOffset: offset + headerSize, bodyEnd: offset + size });
    offset += size;
  }
  assert.equal(offset, end, "the box walk must line up");
  return boxes;
}

export const first = (boxes: Box[], type: string): Box => {
  const box = boxes.find((candidate) => candidate.type === type);
  assert.ok(box, `expected a ${JSON.stringify(type)} box`);
  return box;
};

/** The `ipco` property boxes, in order. */
export function propertiesOf(buffer: Buffer): string[] {
  const meta = first(boxesIn(buffer, 0, buffer.length), "meta");
  const iprp = first(boxesIn(buffer, meta.bodyOffset + 4, meta.bodyEnd), "iprp");
  const ipco = first(boxesIn(buffer, iprp.bodyOffset, iprp.bodyEnd), "ipco");
  return boxesIn(buffer, ipco.bodyOffset, ipco.bodyEnd).map((box) => box.type);
}

/** The bytes of the `mdat` payload - the image data. */
export function imageDataOf(buffer: Buffer): Buffer {
  const mdat = first(boxesIn(buffer, 0, buffer.length), "mdat");
  return Buffer.from(buffer.subarray(mdat.bodyOffset, mdat.bodyEnd));
}

/** The absolute offset the `iloc` extent of the first item points at, whatever the iloc flavour. */
export function ilocExtentOf(buffer: Buffer): number {
  const meta = first(boxesIn(buffer, 0, buffer.length), "meta");
  const iloc = first(boxesIn(buffer, meta.bodyOffset + 4, meta.bodyEnd), "iloc");
  const version = buffer[iloc.bodyOffset]!;
  let cursor = iloc.bodyOffset + 4;
  const sizes = buffer[cursor]!;
  const offsetSize = sizes >> 4;
  cursor += 1;
  const baseOffsetSize = buffer[cursor]! >> 4;
  cursor += 1;
  cursor += 2; // item_count
  cursor += version === 2 ? 4 : 2; // item_ID
  if (version >= 1) cursor += 2; // construction_method
  cursor += 2; // data_reference_index
  let base = 0;
  if (baseOffsetSize > 0) {
    base = buffer.readUIntBE(cursor, baseOffsetSize);
    cursor += baseOffsetSize;
  }
  cursor += 2; // extent_count
  return base + buffer.readUIntBE(cursor, offsetSize);
}

/** The offsets the `irot`/`imir` body bytes sit at, or null when the property is absent. */
export function transformOffsetsOf(buffer: Buffer): { irot: number | null; imir: number | null } {
  const meta = first(boxesIn(buffer, 0, buffer.length), "meta");
  const iprp = first(boxesIn(buffer, meta.bodyOffset + 4, meta.bodyEnd), "iprp");
  const ipco = first(boxesIn(buffer, iprp.bodyOffset, iprp.bodyEnd), "ipco");
  const properties = boxesIn(buffer, ipco.bodyOffset, ipco.bodyEnd);
  return {
    irot: properties.find((box) => box.type === "irot")?.bodyOffset ?? null,
    imir: properties.find((box) => box.type === "imir")?.bodyOffset ?? null,
  };
}
