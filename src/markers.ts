/**
 * Minimal JPEG marker layer.
 *
 * Only leading segments are interesting here: everything from the start of scan (SOS) onwards is
 * entropy-coded image data.
 */

import { OrientError } from "./errors.ts";

export const MARKER = {
  SOI: 0xd8,
  EOI: 0xd9,
  SOS: 0xda,
  APP0: 0xe0,
  APP1: 0xe1,
  APP2: 0xe2,
  DQT: 0xdb,
  DHT: 0xc4,
  DRI: 0xdd,
  COM: 0xfe,
  SOF0: 0xc0,
  SOF1: 0xc1,
  SOF2: 0xc2,
} as const;

export interface JpegSegment {
  /** Marker byte without the 0xff prefix, e.g. 0xe1 for APP1. */
  marker: number;
  /** Absolute offset of the 0xff byte that starts the marker. */
  offset: number;
  /** Absolute offset of the two length bytes (`offset + 2`), or -1 for standalone markers. */
  lengthOffset: number;
  /** Segment length as declared, including the two length bytes. */
  length: number;
  /** Absolute offset of the first payload byte. */
  payloadOffset: number;
  payloadLength: number;
}

/** Standalone markers carry no length field. */
function isStandalone(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

/**
 * Yields the leading segments of a JPEG, stopping at SOS or EOI.
 *
 * @throws OrientError E_NOT_JPEG for a missing SOI, E_PREMATURE_END for a declared
 * length that runs past the end of the buffer, E_INVALID_EXIF for a corrupt segment structure.
 */
export function* jpegSegments(buffer: Uint8Array): Generator<JpegSegment> {
  if (buffer.length < 2 || buffer[0] !== 0xff || buffer[1] !== MARKER.SOI) {
    throw new OrientError("E_NOT_JPEG", "not a JPEG file: no SOI marker at the start");
  }

  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      throw new OrientError("E_INVALID_EXIF", `invalid JPEG structure: expected a marker at offset ${offset}`);
    }

    // Fill bytes (0xff padding before a marker) are legal.
    let markerOffset = offset;
    while (markerOffset < buffer.length && buffer[markerOffset] === 0xff) markerOffset++;
    if (markerOffset >= buffer.length) {
      throw new OrientError("E_PREMATURE_END", "premature end of JPEG file: marker byte is missing");
    }

    const marker = buffer[markerOffset]!; // markerOffset < buffer.length is checked above
    if (marker === MARKER.EOI || marker === MARKER.SOS) return;

    if (isStandalone(marker)) {
      yield { marker, offset, lengthOffset: -1, length: 0, payloadOffset: markerOffset + 1, payloadLength: 0 };
      offset = markerOffset + 1;
      continue;
    }

    if (markerOffset + 3 > buffer.length) {
      throw new OrientError(
        "E_PREMATURE_END",
        `premature end of JPEG file: truncated segment header at offset ${offset}`,
      );
    }

    const length = (buffer[markerOffset + 1]! << 8) | buffer[markerOffset + 2]!;
    if (length < 2) {
      throw new OrientError("E_INVALID_EXIF", `invalid JPEG structure: segment length ${length} at offset ${offset}`);
    }

    const payloadOffset = markerOffset + 3;
    const payloadLength = length - 2;
    if (payloadOffset + payloadLength > buffer.length) {
      throw new OrientError(
        "E_PREMATURE_END",
        `premature end of JPEG file: segment at offset ${offset} declares ${length} bytes`,
      );
    }

    yield { marker, offset, lengthOffset: markerOffset + 1, length, payloadOffset, payloadLength };
    offset = payloadOffset + payloadLength;
  }
}

const EXIF_SIGNATURE = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"

function isExifPayload(buffer: Uint8Array, segment: JpegSegment): boolean {
  if (segment.payloadLength < EXIF_SIGNATURE.length) return false;
  for (let i = 0; i < EXIF_SIGNATURE.length; i++) {
    if (buffer[segment.payloadOffset + i] !== EXIF_SIGNATURE[i]) return false;
  }
  return true;
}

export interface ExifSegment {
  segment: JpegSegment;
  /** Absolute offset of the TIFF header, i.e. right behind the "Exif\0\0" signature. */
  tiffOffset: number;
  /** Absolute offset of the first byte after the APP1 payload. */
  end: number;
}

/**
 * Finds the first APP1 segment whose payload starts with the "Exif\0\0" signature.
 *
 * Every leading segment is walked, so files with an ICC APP2 chunk or an XMP APP1 before the Exif
 * block are handled correctly (a scanner that expects APP0/JFIF then APP1 would fail).
 */
export function findExifApp1(buffer: Uint8Array): ExifSegment | null {
  for (const segment of jpegSegments(buffer)) {
    if (segment.marker === MARKER.APP1 && isExifPayload(buffer, segment)) {
      return {
        segment,
        tiffOffset: segment.payloadOffset + EXIF_SIGNATURE.length,
        end: segment.payloadOffset + segment.payloadLength,
      };
    }
  }
  return null;
}
