/**
 * Huffman coding and the entropy-coded bit stream.
 *
 * Decoding is the canonical-code lookup of ITU-T T.81 Annex C (DECODE procedure); encoding uses the
 * same canonical construction. The bit reader understands 0xFF00 byte stuffing and restart markers,
 * the writer emits stuffing and never emits a restart marker (the restart interval is dropped, which
 * is always legal).
 */

import { OrientError } from "../errors.ts";
import type { HuffmanTableSpec } from "./tables.ts";

export interface HuffmanDecoder {
  /** Largest code of each length 1..16, or -1 when no code has that length. */
  maxCode: Int32Array;
  /** Smallest code of each length 1..16. */
  minCode: Int32Array;
  /** Offset into `symbols` for the first code of each length. */
  valuePointer: Int32Array;
  symbols: Uint8Array;
}

export function buildHuffmanDecoder(table: HuffmanTableSpec): HuffmanDecoder {
  const { counts, symbols } = table;
  const maxCode = new Int32Array(17).fill(-1);
  const minCode = new Int32Array(17);
  const valuePointer = new Int32Array(17);

  let code = 0;
  let symbolIndex = 0;
  for (let length = 1; length <= 16; length++) {
    const count = counts[length - 1]!;
    valuePointer[length] = symbolIndex;
    minCode[length] = code;
    code += count;
    symbolIndex += count;
    maxCode[length] = count === 0 ? -1 : code - 1;
    code <<= 1;
  }
  return { maxCode, minCode, valuePointer, symbols };
}

export interface HuffmanEncoder {
  /** Code of each symbol, indexed by symbol value. */
  code: Uint16Array;
  /** Bit length of each symbol. */
  size: Uint8Array;
}

export function buildHuffmanEncoder(table: HuffmanTableSpec): HuffmanEncoder {
  const code = new Uint16Array(256);
  const size = new Uint8Array(256);

  let current = 0;
  let symbolIndex = 0;
  for (let length = 1; length <= 16; length++) {
    for (let i = 0; i < table.counts[length - 1]!; i++) {
      const symbol = table.symbols[symbolIndex++]!;
      code[symbol] = current;
      size[symbol] = length;
      current++;
    }
    current <<= 1;
  }
  return { code, size };
}

const RESTART_MARKER_MIN = 0xd0;
const RESTART_MARKER_MAX = 0xd7;

/**
 * Reads bits out of an entropy-coded segment.
 *
 * @param bytes the whole file
 * @param start offset of the first entropy byte
 * @param end offset just past the last entropy byte
 */
export class BitReader {
  private readonly bytes: Uint8Array;
  private readonly end: number;
  private position: number;
  private accumulator = 0;
  private bitsLeft = 0;

  /** True once a marker (other than a restart) was reached: the segment has no more data. */
  markerFound = false;

  constructor(bytes: Uint8Array, start: number, end: number) {
    this.bytes = bytes;
    this.position = start;
    this.end = end;
  }

  get offset(): number {
    return this.position;
  }

  /** Reads a single bit; returns 0 at the end of the segment. */
  getBit(): number {
    if (this.bitsLeft === 0) {
      if (!this.fill()) return 0;
    }
    this.bitsLeft--;
    return (this.accumulator >> this.bitsLeft) & 1;
  }

  /** Reads `count` bits as an unsigned value. */
  receive(count: number): number {
    if (count === 0) return 0;
    let value = 0;
    for (let i = 0; i < count; i++) value = (value << 1) | this.getBit();
    return value;
  }

  /** Reads `count` bits and sign-extends them (JPEG's `EXTEND` macro). */
  receiveExtend(count: number): number {
    if (count === 0) return 0;
    const value = this.receive(count);
    return value < 1 << (count - 1) ? value + 1 - (1 << count) : value;
  }

  /** Discards bits up to the next byte boundary. */
  alignToByte(): void {
    this.bitsLeft = 0;
  }

  /**
   * Reads a restart marker and resets the reader.
   *
   * @returns false when the expected marker is not there (the file is then treated as if the interval
   * had ended; the caller re-aligns to the next byte and keeps going).
   */
  readRestart(expected: number): boolean {
    this.alignToByte();
    // Skip padding 0xFF bytes, then require FF D0+expected.
    while (this.position < this.end && this.bytes[this.position] === 0xff) {
      const next = this.bytes[this.position + 1];
      if (next === undefined) return false;
      if (next === 0x00) break; // stuffed data byte, not a marker
      this.position += 2;
      return next === RESTART_MARKER_MIN + expected;
    }
    return false;
  }

  /** Loads the next data byte into the accumulator. Returns false at a marker or at the end. */
  private fill(): boolean {
    if (this.position >= this.end) {
      this.markerFound = true;
      return false;
    }
    const byte = this.bytes[this.position]!;
    if (byte === 0xff) {
      const next = this.bytes[this.position + 1];
      if (next === 0x00) {
        this.position += 2;
      } else {
        // A marker: the entropy segment ends here.
        this.markerFound = true;
        return false;
      }
    } else {
      this.position += 1;
    }
    this.accumulator = byte;
    this.bitsLeft = 8;
    return true;
  }

  /** True when the next bytes are a restart marker. */
  atRestartMarker(): boolean {
    return (
      this.position + 1 < this.end &&
      this.bytes[this.position] === 0xff &&
      this.bytes[this.position + 1]! >= RESTART_MARKER_MIN &&
      this.bytes[this.position + 1]! <= RESTART_MARKER_MAX
    );
  }
}

/** Writes bits into a byte-stuffed entropy segment. */
export class BitWriter {
  private buffer: Buffer;
  private length = 0;
  private accumulator = 0;
  private bitsLeft = 0;

  constructor(initialCapacity = 1 << 16) {
    this.buffer = Buffer.alloc(initialCapacity);
  }

  putBits(value: number, count: number): void {
    if (count === 0) return;
    this.accumulator = ((this.accumulator << count) | (value & ((1 << count) - 1))) & 0xffffff;
    this.bitsLeft += count;
    while (this.bitsLeft >= 8) {
      this.bitsLeft -= 8;
      this.emitByte((this.accumulator >> this.bitsLeft) & 0xff);
    }
  }

  /** Pads the last byte with 1 bits, as the spec requires. */
  flush(): void {
    if (this.bitsLeft > 0) {
      const padding = 8 - this.bitsLeft;
      this.putBits((1 << padding) - 1, padding);
    }
    this.accumulator = 0;
    this.bitsLeft = 0;
  }

  toBuffer(): Buffer {
    return this.buffer.subarray(0, this.length);
  }

  private emitByte(byte: number): void {
    if (this.length + 2 > this.buffer.length) {
      const grown = Buffer.alloc(this.buffer.length * 2);
      this.buffer.copy(grown, 0, 0, this.length);
      this.buffer = grown;
    }
    this.buffer[this.length++] = byte;
    if (byte === 0xff) this.buffer[this.length++] = 0x00; // byte stuffing
  }
}

/** Decodes one symbol using a canonical Huffman table. */
export function decodeHuffmanSymbol(reader: BitReader, table: HuffmanDecoder): number {
  let code = 0;
  for (let length = 1; length <= 16; length++) {
    code = (code << 1) | reader.getBit();
    const max = table.maxCode[length]!;
    if (max >= 0 && code <= max) {
      const index = table.valuePointer[length]! + code - table.minCode[length]!;
      const symbol = table.symbols[index];
      if (symbol === undefined) {
        throw new OrientError("E_INVALID_JPEG", "invalid JPEG data: Huffman symbol out of range");
      }
      return symbol;
    }
  }
  throw new OrientError("E_INVALID_JPEG", "invalid JPEG data: no Huffman code matched");
}
