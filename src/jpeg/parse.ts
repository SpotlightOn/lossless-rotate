/**
 * JPEG segment parsing: everything the coefficient transformer needs, plus the segments it has to
 * carry over unchanged (APPn, COM).
 */

import { OrientError } from "../errors.ts";
import { type JpegSegment, MARKER } from "../markers.ts";
import type { Frame, FrameComponent } from "./geometry.ts";
import type { HuffmanTableSpec } from "./tables.ts";

export interface QuantizationTable {
  id: number;
  precision: number;
  /** 64 values in zigzag order, as stored in the file. */
  values: Uint16Array;
}

export interface ScanComponent {
  id: number;
  dcTableId: number;
  acTableId: number;
}

export interface Scan {
  components: ScanComponent[];
  /** Spectral selection start. */
  ss: number;
  /** Spectral selection end. */
  se: number;
  /** Successive approximation high bit. */
  ah: number;
  /** Successive approximation low bit. */
  al: number;
  /** Offset of the first entropy byte. */
  dataStart: number;
  /** Offset just past the last entropy byte. */
  dataEnd: number;
  /**
   * Huffman tables as they are defined at this scan.
   *
   * A progressive JPEG may (re)define a table between scans, so the definition in effect is the last
   * one *before* the scan - not the last one in the file. Keeping a snapshot per scan is what makes
   * decoding use the right table.
   */
  huffmanTables: Map<string, HuffmanTableSpec>;
  /** Quantization tables as they are defined at this scan. */
  quantizationTables: Map<number, QuantizationTable>;
}

export interface PreservedSegment {
  marker: number;
  payload: Buffer;
}

export interface ParsedJpeg {
  bytes: Uint8Array;
  frame: Frame;
  quantizationTables: Map<number, QuantizationTable>;
  /** Keyed by `${tableClass}-${id}`, where class 0 is DC and 1 is AC. */
  huffmanTables: Map<string, HuffmanTableSpec>;
  scans: Scan[];
  restartInterval: number;
  /** APPn and COM segments, in file order. */
  preserved: PreservedSegment[];
}

export const huffmanKey = (tableClass: number, id: number): string => `${tableClass}-${id}`;

function fail(message: string): never {
  throw new OrientError("E_INVALID_JPEG", message);
}

/**
 * Finds the end of the entropy-coded data that starts at `start`: the offset of the next marker
 * that is neither a stuffed byte (FF 00) nor a restart marker (FF D0..D7).
 */
function findEntropyEnd(bytes: Uint8Array, start: number): number {
  let i = start;
  while (i < bytes.length - 1) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const next = bytes[i + 1]!;
    if (next === 0x00 || (next >= 0xd0 && next <= 0xd7) || next === 0xff) {
      i += 2;
      continue;
    }
    return i;
  }
  // No trailing marker: the data runs to the end of the buffer.
  return bytes.length;
}

function parseFrame(bytes: Uint8Array, segment: JpegSegment): Frame {
  const { payloadOffset } = segment;
  if (segment.payloadLength < 6) fail("invalid JPEG: SOF segment is too short");

  const precision = bytes[payloadOffset]!;
  const height = (bytes[payloadOffset + 1]! << 8) | bytes[payloadOffset + 2]!;
  const width = (bytes[payloadOffset + 3]! << 8) | bytes[payloadOffset + 4]!;
  const componentCount = bytes[payloadOffset + 5]!;
  if (width === 0 || height === 0) fail("invalid JPEG: zero image dimensions");
  if (precision !== 8) {
    throw new OrientError(
      "E_UNSUPPORTED",
      `unsupported JPEG: ${precision}-bit sample precision, only 8-bit is supported`,
    );
  }
  if (componentCount !== 1 && componentCount !== 3) {
    throw new OrientError(
      "E_UNSUPPORTED",
      `unsupported JPEG: ${componentCount} components, only 1 (grayscale) and 3 are supported`,
    );
  }
  if (segment.payloadLength < 6 + 3 * componentCount) fail("invalid JPEG: SOF segment is truncated");

  const components: FrameComponent[] = [];
  for (let i = 0; i < componentCount; i++) {
    const base = payloadOffset + 6 + i * 3;
    const id = bytes[base]!;
    const sampling = bytes[base + 1]!;
    const h = sampling >> 4;
    const v = sampling & 15;
    if (h < 1 || h > 4 || v < 1 || v > 4) fail(`invalid JPEG: sampling factors ${h}x${v} out of range`);
    components.push({ id, h, v, quantTableId: bytes[base + 2]! });
  }

  const maxH = Math.max(...components.map((c) => c.h));
  const maxV = Math.max(...components.map((c) => c.v));

  return {
    marker: segment.marker,
    progressive: segment.marker === MARKER.SOF2,
    precision,
    width,
    height,
    components,
    maxH,
    maxV,
  };
}

function parseQuantizationTables(bytes: Uint8Array, segment: JpegSegment, into: Map<number, QuantizationTable>): void {
  let offset = segment.payloadOffset;
  const end = segment.payloadOffset + segment.payloadLength;
  while (offset < end) {
    const header = bytes[offset]!;
    const precision = header >> 4;
    const id = header & 15;
    const count = precision === 0 ? 64 : 128;
    if (offset + 1 + count > end) fail("invalid JPEG: truncated DQT segment");
    if (precision !== 0 && precision !== 1) fail(`invalid JPEG: unsupported quantization precision ${precision}`);
    const values = new Uint16Array(64);
    for (let i = 0; i < 64; i++) {
      values[i] =
        precision === 0 ? bytes[offset + 1 + i]! : (bytes[offset + 1 + i * 2]! << 8) | bytes[offset + 2 + i * 2]!;
    }
    into.set(id, { id, precision, values });
    offset += 1 + count;
  }
}

function parseHuffmanTables(bytes: Uint8Array, segment: JpegSegment, into: Map<string, HuffmanTableSpec>): void {
  let offset = segment.payloadOffset;
  const end = segment.payloadOffset + segment.payloadLength;
  while (offset < end) {
    const header = bytes[offset]!;
    const tableClass = header >> 4;
    const id = header & 15;
    if (tableClass > 1) fail(`invalid JPEG: unknown Huffman table class ${tableClass}`);
    if (offset + 17 > end) fail("invalid JPEG: truncated DHT segment");
    const counts = bytes.subarray(offset + 1, offset + 17);
    let symbolCount = 0;
    for (const count of counts) symbolCount += count;
    if (symbolCount > 256 || offset + 17 + symbolCount > end) fail("invalid JPEG: DHT symbol count out of range");
    into.set(huffmanKey(tableClass, id), {
      counts: Uint8Array.from(counts),
      symbols: Uint8Array.from(bytes.subarray(offset + 17, offset + 17 + symbolCount)),
    });
    offset += 17 + symbolCount;
  }
}

function parseScanHeader(
  bytes: Uint8Array,
  segment: JpegSegment,
): Omit<Scan, "dataStart" | "dataEnd" | "huffmanTables" | "quantizationTables"> {
  const { payloadOffset } = segment;
  const componentCount = bytes[payloadOffset]!;
  if (componentCount < 1 || componentCount > 4) fail(`invalid JPEG: ${componentCount} components in a scan`);
  if (segment.payloadLength < 1 + 2 * componentCount + 3) fail("invalid JPEG: truncated SOS segment");

  const components: ScanComponent[] = [];
  for (let i = 0; i < componentCount; i++) {
    const base = payloadOffset + 1 + i * 2;
    components.push({ id: bytes[base]!, dcTableId: bytes[base + 1]! >> 4, acTableId: bytes[base + 1]! & 15 });
  }
  const tail = payloadOffset + 1 + 2 * componentCount;
  return { components, ss: bytes[tail]!, se: bytes[tail + 1]!, ah: bytes[tail + 2]! >> 4, al: bytes[tail + 2]! & 15 };
}

/**
 * Parses a JPEG far enough to transform its coefficients.
 *
 * The scan loop is written out by hand instead of using the marker generator, because a progressive
 * file has several scans and each one is followed by entropy-coded data that has to be skipped
 * before the next marker.
 *
 * @throws OrientError E_NOT_JPEG / E_PREMATURE_END / E_INVALID_JPEG / E_UNSUPPORTED.
 */
export function parseJpeg(bytes: Uint8Array): ParsedJpeg {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new OrientError("E_NOT_JPEG", "not a JPEG file: no SOI marker at the start");
  }

  let frame: Frame | undefined;
  const quantizationTables = new Map<number, QuantizationTable>();
  const huffmanTables = new Map<string, HuffmanTableSpec>();
  const scans: Scan[] = [];
  const preserved: PreservedSegment[] = [];
  let restartInterval = 0;

  const readU16 = (offset: number): number => (bytes[offset]! << 8) | bytes[offset + 1]!;

  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) fail(`invalid JPEG structure: expected a marker at offset ${offset}`);
    let markerOffset = offset;
    while (markerOffset < bytes.length && bytes[markerOffset] === 0xff) markerOffset++;
    if (markerOffset >= bytes.length)
      throw new OrientError("E_PREMATURE_END", "premature end of JPEG file: marker byte is missing");

    const marker = bytes[markerOffset]!;
    if (marker === MARKER.EOI) break;

    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset = markerOffset + 1;
      continue;
    }

    if (markerOffset + 3 > bytes.length) {
      throw new OrientError(
        "E_PREMATURE_END",
        `premature end of JPEG file: truncated segment header at offset ${offset}`,
      );
    }
    const length = readU16(markerOffset + 1);
    if (length < 2) fail(`invalid JPEG structure: segment length ${length} at offset ${offset}`);
    const payloadOffset = markerOffset + 3;
    const payloadLength = length - 2;
    if (payloadOffset + payloadLength > bytes.length) {
      throw new OrientError(
        "E_PREMATURE_END",
        `premature end of JPEG file: segment at offset ${offset} declares ${length} bytes`,
      );
    }

    const segment: JpegSegment = {
      marker,
      offset: markerOffset,
      lengthOffset: markerOffset + 1,
      length,
      payloadOffset,
      payloadLength,
    };

    switch (marker) {
      case MARKER.APP0:
      case MARKER.APP1:
      case MARKER.APP2:
      case 0xed: // APP13 (Photoshop IRB)
      case MARKER.COM:
        preserved.push({
          marker,
          payload: Buffer.from(bytes.subarray(payloadOffset, payloadOffset + payloadLength)),
        });
        break;
      case MARKER.DQT:
        parseQuantizationTables(bytes, segment, quantizationTables);
        break;
      case MARKER.DHT:
        parseHuffmanTables(bytes, segment, huffmanTables);
        break;
      case MARKER.SOF0:
      case MARKER.SOF1:
      case MARKER.SOF2:
        if (marker === MARKER.SOF1) {
          throw new OrientError("E_UNSUPPORTED", "unsupported JPEG: extended sequential (SOF1) is not supported");
        }
        frame = parseFrame(bytes, segment);
        break;
      case MARKER.DRI:
        restartInterval = readU16(payloadOffset);
        break;
      case MARKER.SOS: {
        const header = parseScanHeader(bytes, segment);
        const dataStart = payloadOffset + payloadLength;
        const dataEnd = findEntropyEnd(bytes, dataStart);
        scans.push({
          ...header,
          dataStart,
          dataEnd,
          // Snapshot the tables in effect here: a progressive file may redefine them between scans.
          huffmanTables: new Map(huffmanTables),
          quantizationTables: new Map(quantizationTables),
        });
        offset = dataEnd;
        continue;
      }
      case 0xcc: // DAC: arithmetic coding
        throw new OrientError("E_UNSUPPORTED", "unsupported JPEG: arithmetic coding");
      case 0xc3:
      case 0xc5:
      case 0xc6:
      case 0xc7:
      case 0xc9:
      case 0xca:
      case 0xcb:
      case 0xcd:
      case 0xce:
      case 0xcf:
        throw new OrientError(
          "E_UNSUPPORTED",
          `unsupported JPEG: SOF${marker - 0xc0} (lossless or differential coding)`,
        );
      default:
        break;
    }

    offset = payloadOffset + payloadLength;
  }

  if (frame === undefined) fail("invalid JPEG: no SOF segment found");
  if (scans.length === 0) fail("invalid JPEG: no scan found");
  if (!frame.progressive && scans.length > 1) fail("invalid JPEG: a baseline image must have exactly one scan");

  return { bytes, frame, quantizationTables, huffmanTables, scans, restartInterval, preserved };
}
