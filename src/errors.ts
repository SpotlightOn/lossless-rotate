/**
 * Error type for the whole package: every failure is an `OrientError` with a stable `code`.
 */

export type ErrorCode =
  /** The file could not be opened or read. */
  | "E_CANT_OPEN"
  /**
   * The input does not start with a JPEG SOI marker. Raised by the JPEG layer itself; the format
   * detecting entry points report `E_UNSUPPORTED_FORMAT` instead.
   */
  | "E_NOT_JPEG"
  /** The file ends in the middle of a segment or of the entropy-coded data. */
  | "E_PREMATURE_END"
  /** The Exif block is structurally broken. */
  | "E_INVALID_EXIF"
  /** The JPEG structure (markers, tables, entropy data) is broken. */
  | "E_INVALID_JPEG"
  /** An argument was out of range, e.g. an orientation outside 1..8. */
  | "E_INVALID_VALUE"
  /** The input is not a JPEG image. */
  | "E_UNSUPPORTED_FORMAT"
  /** The file uses a feature this package cannot handle losslessly. */
  | "E_UNSUPPORTED";

export class OrientError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OrientError";
    this.code = code;
  }

  static is(error: unknown): error is OrientError {
    return error instanceof OrientError;
  }
}

/** Maps a filesystem error onto `E_CANT_OPEN`. */
export function cantOpenCause(cause: unknown): OrientError {
  const detail = cause instanceof Error ? `: ${cause.message}` : "";
  return new OrientError("E_CANT_OPEN", `could not open file${detail}`, { cause });
}
