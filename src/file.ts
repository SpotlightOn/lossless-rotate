/**
 * File-level operations: the modern replacement for the v1 addon's `fopen`/`fread`/`fwrite` pair.
 *
 * Reading only touches the head of the file (the Exif block is required to live in the first
 * segments) and writing is a 10-byte in-place patch at an absolute offset, so a file keeps its exact
 * size and all of its image data.
 */

import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";
import { cantOpenCause, OrientError } from "./errors.ts";
import { type PatchResult, patchOrientation, readOrientation } from "./exif.ts";

/**
 * First read window. An APP1 segment cannot exceed 65535 bytes by format, so a window this size
 * contains any well-formed Exif block, and the window is doubled when a file claims more.
 */
const INITIAL_WINDOW = 64 * 1024;

/** Guard against pathological files that declare an endless segment. */
const MAX_WINDOW = 4 * 1024 * 1024;

/** True when the first two bytes are a JPEG SOI marker. */
function isJpeg(buffer: Uint8Array): boolean {
  return buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8;
}

function isPrematureEnd(error: unknown): boolean {
  return error instanceof OrientError && error.code === "E_PREMATURE_END";
}

function unsupportedFormat(): OrientError {
  return new OrientError("E_UNSUPPORTED_FORMAT", "not a JPEG file: no JPEG SOI marker at the start");
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

/**
 * Reads the orientation of a JPEG file, or 0 when it carries no orientation.
 *
 * @throws OrientError E_CANT_OPEN / E_UNSUPPORTED_FORMAT / E_PREMATURE_END / E_INVALID_EXIF.
 */
export async function readOrientationFromFile(path: string): Promise<number> {
  return withHandle(path, "r", async (handle) => {
    const { size } = await handle.stat();
    if (!isJpeg(await readWindow(handle, size, 2))) throw unsupportedFormat();

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
  });
}

export interface WriteOrientationResult extends PatchResult {
  /** File size. A metadata patch keeps it. */
  size: number;
}

/**
 * Updates the orientation of a JPEG file.
 *
 * The file needs an existing orientation tag, like the v1 addon.
 *
 * @returns what was written, including the previous value.
 * @throws OrientError E_CANT_OPEN / E_INVALID_VALUE / E_UNSUPPORTED_FORMAT / E_PREMATURE_END /
 * E_INVALID_EXIF.
 */
export async function writeOrientationToFile(path: string, value: number): Promise<WriteOrientationResult> {
  return withHandle(path, "r+", async (handle) => {
    const { size } = await handle.stat();
    if (!isJpeg(await readWindow(handle, size, 2))) throw unsupportedFormat();

    // Patch the ten bytes at their absolute offset in place.
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
  });
}
