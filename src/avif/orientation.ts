/**
 * AVIF orientation: the `irot` and `imir` item properties.
 *
 * The eight Exif orientations map onto combinations of `irot` (0..3, counter-clockwise 90° steps) and
 * `imir` (axis 0 = top-to-bottom, 1 = left-to-right) applied after rotation. The tables below were
 * derived empirically from avifenc output and Chromium rendering.
 */

import { OrientError } from "../errors.ts";
import type { PatchResult } from "../exif.ts";
import { buildBoxHeader, isAvif, isAvifSequence } from "./container.ts";
import {
  type AvifLayout,
  avifImageSize,
  avifLayout,
  buildIpma,
  parseIpma,
  propertyAt,
  propertyByte,
  propertyIndexOfType,
  rebuildMeta,
} from "./item.ts";

const ANGLE_BY_ORIENTATION = [0, 0, 0, 2, 0, 1, 3, 1, 1] as const;
const MIRROR_BY_ORIENTATION = [-1, -1, 1, -1, 0, 0, -1, 1, -1] as const;
const ORIENTATION_NO_MIRROR = [1, 8, 3, 6] as const;
const ORIENTATION_MIRROR_VERTICAL = [4, 5, 2, 7] as const;
const ORIENTATION_MIRROR_HORIZONTAL = [2, 7, 4, 5] as const;

/**
 * The `irot`/`imir` body is one byte whose transform bits sit in the *low* end, with the remaining
 * high bits reserved and zero (ISO/IEC 23008-12 / MIAF): `irot` stores `angle` in the lowest two
 * bits, `imir` stores the mirror `axis` in the least significant bit. libavif rejects any other
 * placement as "nonzero reserved bits".
 */
const irotAngle = (byte: number): number => byte & 3;
const imirAxis = (byte: number): number => byte & 1;
const irotBody = (angle: number): Buffer => Buffer.from([angle & 3]);
const imirBody = (axis: number): Buffer => Buffer.from([axis & 1]);

interface AvifTransform {
  angle: number;
  axis: number | null;
}

function transformFromOrientation(value: number): AvifTransform {
  if (!Number.isInteger(value) || value < 1 || value > 8) {
    throw new OrientError("E_INVALID_VALUE", `orientation must be a whole number from 1 to 8, got ${value}`);
  }
  const angle = ANGLE_BY_ORIENTATION[value]!;
  const axis = MIRROR_BY_ORIENTATION[value]!;
  return { angle, axis: axis < 0 ? null : axis };
}

function orientationFromTransforms(angle: number, axis: number | null): number {
  const a = angle & 3;
  if (axis === null) return ORIENTATION_NO_MIRROR[a]!;
  if (axis === 0) return ORIENTATION_MIRROR_VERTICAL[a]!;
  if (axis === 1) return ORIENTATION_MIRROR_HORIZONTAL[a]!;
  return 0;
}

/**
 * What an AVIF orientation write did.
 *
 * Unlike JPEG, an AVIF is never patched in place: the property is a box of its own, so
 * adding one grows `ipco`/`ipma` and shifts everything behind `meta` (the `iloc` extents are fixed
 * up to match). `writtenOffset`/`writtenLength` therefore point at the transform byte(s) for
 * information only; the file layer always rewrites the whole file.
 */
export interface AvifPatchResult extends PatchResult {
  /** 1-based index of the `irot` property in `ipco`, or `null` when the result has none. */
  irotProperty: number | null;
  /** 1-based index of the `imir` property in `ipco`, or `null` when the result has none. */
  imirProperty: number | null;
  /** Absolute offset of the associated `irot` body byte, or `null`. */
  irotOffset: number | null;
  /** Absolute offset of the associated `imir` body byte, or `null`. */
  imirOffset: number | null;
  /** True when `ipco`/`ipma` had to be rebuilt (a property was added or `meta` changed size). */
  rebuilt: boolean;
}

function isAssociated(layout: AvifLayout, index: number | null): boolean {
  if (index === null) return false;
  const prop = propertyAt(layout, index);
  if (prop === null) return false;
  const entry = layout.ipmaEntries.entries.find((e) => e.id === layout.primaryId);
  return entry?.associations.some((a) => a.index === index) ?? false;
}

/**
 * Rejects an AVIF image sequence, which `isAvif` accepts as an AVIF but which this package cannot
 * address: its pictures live in tracks and it has no item properties, so there is no `irot`/`imir`
 * to read. Calling that an unsupported format is clearer than failing on the missing `meta` later.
 *
 * Exported for the file layer, which has to apply it before its own box walk insists on a `meta`.
 */
export function assertStillImageAvif(buffer: Uint8Array): void {
  if (isAvifSequence(buffer)) {
    throw new OrientError(
      "E_UNSUPPORTED_FORMAT",
      "an AVIF image sequence (avis), not a still image: its pictures live in tracks and carry no irot/imir property",
    );
  }
}

export function readAvifOrientation(buffer: Uint8Array): number {
  if (!isAvif(buffer)) {
    throw new OrientError("E_UNSUPPORTED_FORMAT", "not an AVIF file: no ftyp box with an AVIF brand at the start");
  }
  assertStillImageAvif(buffer);
  const layout = avifLayout(buffer);
  const irot = propertyIndexOfType(layout, "irot");
  const imir = propertyIndexOfType(layout, "imir");
  const angle =
    isAssociated(layout, irot) && irot !== null ? irotAngle(propertyByte(buffer, propertyAt(layout, irot)!)) : null;
  const axis =
    isAssociated(layout, imir) && imir !== null ? imirAxis(propertyByte(buffer, propertyAt(layout, imir)!)) : null;
  if (angle === null && axis === null) return 0;
  return orientationFromTransforms(angle ?? 0, axis);
}

interface PropertySlot {
  index: number;
  added: boolean;
}

/**
 * Points an `irot`/`imir` property at a new body, adding the property when the file has none.
 *
 * Indices are stable: a property is never removed from `ipco` (that would renumber every `ipma`
 * association), it is only left unassociated when a later write no longer needs it. The returned
 * index is 1-based, matching `ipco` order.
 */
function applyProperty(
  properties: { type: string; body: Buffer }[],
  existing: number | null,
  type: string,
  body: Buffer,
): PropertySlot {
  if (existing !== null && existing >= 1 && existing <= properties.length) {
    properties[existing - 1]!.body = body;
    return { index: existing, added: false };
  }
  properties.push({ type, body });
  return { index: properties.length, added: true };
}

/**
 * Writes the orientation of an AVIF as the `irot`/`imir` property pair of its primary item.
 *
 * The property set is the minimal one libavif writes: a pure mirror (orientation 2 or 4) carries
 * only `imir`, a rotation or the identity carries `irot` (with angle 0 for orientation 1), and a
 * transpose/transverse (5/7) carries both. Any `irot`/`imir` the primary item already had is
 * dropped from `ipma` first, so a stale transform cannot survive underneath the new one.
 *
 * @throws OrientError E_INVALID_VALUE / E_UNSUPPORTED_FORMAT / E_INVALID_AVIF.
 */
export function writeAvifOrientation(buffer: Uint8Array, value: number): { bytes: Buffer; result: AvifPatchResult } {
  if (!Number.isInteger(value) || value < 1 || value > 8) {
    throw new OrientError("E_INVALID_VALUE", `orientation must be a whole number from 1 to 8, got ${value}`);
  }
  if (!isAvif(buffer)) {
    throw new OrientError("E_UNSUPPORTED_FORMAT", "not an AVIF file: no ftyp box with an AVIF brand at the start");
  }
  assertStillImageAvif(buffer);
  const layout = avifLayout(buffer);
  const previousOrientation = readAvifOrientation(buffer);
  const previousValue = previousOrientation === 0 ? null : previousOrientation;
  const desired = transformFromOrientation(value);

  const properties: { type: string; body: Buffer }[] = layout.properties.map((box) => ({
    type: box.type,
    body: Buffer.from(buffer.subarray(box.bodyOffset, box.bodyEnd)),
  }));

  // A rotation of 0 still needs its own property when there is no mirror, so that "orientation 1"
  // is explicit; a pure mirror does not, which is what keeps the output byte-identical to avifenc.
  const needsIrot = desired.axis === null || desired.angle !== 0;
  const needsImir = desired.axis !== null;

  let rebuilt = false;
  let irot: PropertySlot | null = null;
  let imir: PropertySlot | null = null;
  if (needsIrot) {
    irot = applyProperty(properties, propertyIndexOfType(layout, "irot"), "irot", irotBody(desired.angle));
    rebuilt = rebuilt || irot.added;
  }
  if (needsImir) {
    imir = applyProperty(properties, propertyIndexOfType(layout, "imir"), "imir", imirBody(desired.axis!));
    rebuilt = rebuilt || imir.added;
  }

  const ipcoBody = Buffer.concat(
    properties.map((property) => Buffer.concat([buildBoxHeader(property.type, property.body.length), property.body])),
  );
  const ipcoBytes = Buffer.concat([buildBoxHeader("ipco", ipcoBody.length), ipcoBody]);

  const ipma = parseIpma(buffer, layout.ipma);
  let entryFound = false;
  ipma.entries = ipma.entries.map((entry) => {
    if (entry.id !== layout.primaryId) return entry;
    entryFound = true;
    const kept = entry.associations.filter((association) => {
      const box = layout.properties[association.index - 1];
      return box === undefined || (box.type !== "irot" && box.type !== "imir");
    });
    if (irot !== null) kept.push({ index: irot.index, essential: true });
    if (imir !== null) kept.push({ index: imir.index, essential: true });
    return { id: entry.id, associations: kept };
  });
  if (!entryFound) {
    // A file whose primary item has no `ipma` entry at all: create one so the transform applies.
    const associations: { index: number; essential: boolean }[] = [];
    if (irot !== null) associations.push({ index: irot.index, essential: true });
    if (imir !== null) associations.push({ index: imir.index, essential: true });
    ipma.entries.push({ id: layout.primaryId, associations });
  }
  const ipmaBytes = buildIpma(ipma);

  const { bytes: resultBytes, delta } = rebuildMeta(buffer, layout, { ipco: ipcoBytes, ipma: ipmaBytes });
  rebuilt = rebuilt || delta !== 0;

  const layout2 = avifLayout(resultBytes);
  const irotBox = irot === null ? null : propertyAt(layout2, irot.index);
  const imirBox = imir === null ? null : propertyAt(layout2, imir.index);
  const irotOffset = irotBox === null ? null : irotBox.bodyOffset;
  const imirOffset = imirBox === null ? null : imirBox.bodyOffset;
  const firstOffset = irotOffset ?? imirOffset;
  const writtenLength = (irotOffset === null ? 0 : 1) + (imirOffset === null ? 0 : 1);

  return {
    bytes: resultBytes,
    result: {
      value,
      previousValue,
      byteOrder: "big",
      entryOffset: firstOffset ?? 0,
      writtenOffset: firstOffset ?? 0,
      writtenLength,
      irotProperty: irot === null ? null : irot.index,
      imirProperty: imir === null ? null : imir.index,
      irotOffset,
      imirOffset,
      rebuilt,
    },
  };
}

export function setAvifOrientation(buffer: Uint8Array, value: number): Buffer {
  return writeAvifOrientation(buffer, value).bytes;
}

export function avifImageSizeFromBuffer(buffer: Uint8Array): { width: number; height: number } {
  const layout = avifLayout(buffer);
  return avifImageSize(buffer, layout);
}
