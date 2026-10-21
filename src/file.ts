/**
 * File-level operations: the modern replacement for the v1 addon's `fopen`/`fread`/`fwrite` pair.
 *
 * The container is detected from the first bytes, so the same functions serve JPEG and AVIF.
 *
 * For JPEG, reading only touches the head of the file (the Exif block is required to live in the
 * first segments) and writing is a 10-byte in-place patch at an absolute offset, so a file keeps its
 * exact size and all of its image data.
 *
 * For AVIF, the orientation is not a tag in a metadata block but the `irot`/`imir` property of the
 * primary item, so the file is parsed as an ISOBMFF box tree. Reading walks the top-level box headers
 * to find `meta` (which sits in front of `mdat`) and loads only the head up to the end of that box,
 * so the image is never read. Writing always holds the whole file: adding `irot`/`imir` grows
 * `ipco`/`ipma`, `meta` shifts `mdat`, and the `iloc` extents have to be fixed up to match, so there
 * is no ten-byte patch path for AVIF. The image data is copied byte for byte.
 */

import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";
import { isAvif } from "./avif/container.ts";
import { assertStillImageAvif, readAvifOrientation, writeAvifOrientation } from "./avif/orientation.ts";
import { cantOpenCause, OrientError } from "./errors.ts";
import { type PatchResult, patchOrientation, readOrientation } from "./exif.ts";

/**
 * First read window. An APP1 segment cannot exceed 65535 bytes by format, so a window this size
 * contains any well-formed Exif block, and the window is doubled when a file claims more.
 */
const INITIAL_WINDOW = 64 * 1024;

/** Guard against pathological files that declare an endless segment. */
const MAX_WINDOW = 4 * 1024 * 1024;

/** True when the first two bytes are a JPEG SOI marker, the cheapest way to tell the formats apart. */
function isJpeg(buffer: Uint8Array): boolean {
  return buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8;
}

function isPrematureEnd(error: unknown): boolean {
  return error instanceof OrientError && error.code === "E_PREMATURE_END";
}

function unsupportedFormat(): OrientError {
  return new OrientError(
    "E_UNSUPPORTED_FORMAT",
    "not a JPEG or AVIF file: neither a JPEG SOI marker nor an ftyp box with an AVIF brand at the start",
  );
}

async function readWindow(handle: FileHandle, size: number, window: number): Promise<Buffer> {
  const buffer = Buffer.alloc(Math.min(size, window));
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  return buffer.subarray(0, bytesRead);
}

async function withHandle<T>(path: string, flags: string, run: (handle: FileHandle) => Promise<T>): Promise<T> {
  let handle: FileHandle;
  try {
    handle = await open(path, flags);
  } catch (cause) {
    throw cantOpenCause(cause);
  }
  try {
    // Windows opens a directory and reads zero bytes from it, so "this is not a file" has to be
    // checked explicitly; otherwise a directory would surface as E_UNSUPPORTED_FORMAT instead of
    // the E_CANT_OPEN the POSIX path produces (EISDIR).
    if (!(await handle.stat()).isFile()) throw cantOpenCause(new Error(`${path} is not a regular file`));
    return await run(handle);
  } catch (error) {
    // A read/write failure on an open file keeps the v1 "E_CANT_OPEN" meaning for its -1 result,
    // but never masks an error this package raised itself.
    if (OrientError.is(error)) throw error;
    throw cantOpenCause(error);
  } finally {
    await handle.close();
  }
}

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

function invalidAvif(message: string): OrientError {
  return new OrientError("E_INVALID_AVIF", `invalid AVIF structure: ${message}`);
}

/**
 * Reads the orientation of an AVIF file, loading as little of it as possible.
 *
 * The `meta` box carries the property set and usually sits in front of `mdat`, so the top-level box
 * headers are read to locate it and then only the head of the file up to the end of `meta` is loaded.
 * A file that stores `meta` behind the image data is read in full, which is still correct - just not
 * cheaper than reading the whole thing.
 *
 * The box walk here mirrors the checks `isoBoxes` makes - including that the top level lines up with
 * the end of the file - so a broken file fails the same way it would if the whole thing had been read.
 *
 * @throws OrientError E_INVALID_AVIF (broken box structure).
 */
async function readAvifOrientationFromHandle(handle: FileHandle, size: number): Promise<number> {
  const header = Buffer.alloc(16);
  let offset = 0;
  let metaEnd: number | null = null;
  while (offset + 8 <= size) {
    const { bytesRead } = await handle.read(header, 0, 16, offset);
    if (bytesRead < 8) break;

    let boxSize = header.readUInt32BE(0);
    const type = header.toString("latin1", 4, 8);
    let headerSize = 8;
    if (boxSize === 1) {
      if (bytesRead < 16) {
        throw invalidAvif(`box ${JSON.stringify(type)} at offset ${offset} has a truncated 64-bit size`);
      }
      boxSize = header.readUInt32BE(8) * 0x1_0000_0000 + header.readUInt32BE(12);
      headerSize = 16;
    } else if (boxSize === 0) {
      boxSize = size - offset;
    }
    if (boxSize < headerSize || offset + boxSize > size) {
      throw invalidAvif(`box ${JSON.stringify(type)} at offset ${offset} declares ${boxSize} bytes`);
    }
    if (type === "meta" && metaEnd === null) metaEnd = offset + boxSize;
    offset += boxSize;
  }
  if (offset !== size) throw invalidAvif(`${size - offset} trailing byte(s) after the last box`);
  if (metaEnd === null) throw invalidAvif("no meta box");

  // Everything up to the end of `meta`: the box tree of the head lines up exactly, so the in-memory
  // parser sees the same structure it would see for the whole file.
  return readAvifOrientation(await readAt(handle, 0, metaEnd));
}

/**
 * Reads the orientation of a JPEG or AVIF file, or 0 when it carries no orientation.
 *
 * @throws OrientError E_CANT_OPEN / E_UNSUPPORTED_FORMAT / E_PREMATURE_END / E_INVALID_EXIF /
 * E_INVALID_AVIF.
 */
export async function readOrientationFromFile(path: string): Promise<number> {
  return withHandle(path, "r", async (handle) => {
    const { size } = await handle.stat();
    const head = await readWindow(handle, size, INITIAL_WINDOW);

    if (isJpeg(head)) {
      // JPEG: the Exif block is somewhere in the leading segments, so the window may have to grow.
      let window = INITIAL_WINDOW;
      for (;;) {
        const buffer = await readWindow(handle, size, window);
        try {
          return readOrientation(buffer);
        } catch (error) {
          // The Exif block may continue past what we read: widen the window before giving up.
          const canWiden = buffer.length < size && window < size && window < MAX_WINDOW;
          if (!isPrematureEnd(error) || !canWiden) throw error;
          window = Math.min(window * 2, MAX_WINDOW);
        }
      }
    }
    if (isAvif(head)) {
      // A sequence (`avis`) has no item-based `meta`, so the box walk below would fail on it with
      // a structural error. It is a valid AVIF this package cannot orient: refuse it as an
      // unsupported format first, matching `assertStillImageAvif` on the buffer path.
      assertStillImageAvif(head);
      return readAvifOrientationFromHandle(handle, size);
    }
    throw unsupportedFormat();
  });
}

export interface WriteOrientationResult extends PatchResult {
  /**
   * File size. A metadata patch keeps it; an AVIF grows (or shrinks) whenever the `irot`/`imir`
   * property set changes size.
   */
  size: number;
}

/**
 * Updates the orientation of a JPEG or AVIF file.
 *
 * A JPEG needs an existing orientation tag, like the v1 addon. An AVIF always gets an `irot`/`imir`
 * property: that is the only way to express orientation in the container and writing is always a
 * rewrite, with the `iloc` extents fixed up so the image data is preserved byte for byte.
 *
 * @returns what was written, including the previous value.
 * @throws OrientError E_CANT_OPEN / E_INVALID_VALUE / E_UNSUPPORTED_FORMAT / E_PREMATURE_END /
 * E_INVALID_EXIF / E_INVALID_AVIF.
 */
export async function writeOrientationToFile(path: string, value: number): Promise<WriteOrientationResult> {
  return withHandle(path, "r+", async (handle) => {
    const { size } = await handle.stat();
    const head = await readWindow(handle, size, INITIAL_WINDOW);

    if (isJpeg(head)) {
      // JPEG: patch the ten bytes at their absolute offset in place.
      let window = INITIAL_WINDOW;
      for (;;) {
        const buffer = await readWindow(handle, size, window);
        try {
          const result = patchOrientation(buffer, value);
          await handle.write(buffer, result.writtenOffset, result.writtenLength, result.writtenOffset);
          return { ...result, size };
        } catch (error) {
          const canWiden = buffer.length < size && window < size && window < MAX_WINDOW;
          if (!isPrematureEnd(error) || !canWiden) throw error;
          window = Math.min(window * 2, MAX_WINDOW);
        }
      }
    }

    if (isAvif(head)) {
      // AVIF: the property set is rebuilt and `meta` may change size, so the whole file is rewritten.
      const bytes = await readAt(handle, 0, size);
      const { bytes: updated, result } = writeAvifOrientation(bytes, value);
      await handle.write(updated, 0, updated.length, 0);
      await handle.truncate(updated.length);
      return { ...result, size: updated.length };
    }

    throw unsupportedFormat();
  });
}
