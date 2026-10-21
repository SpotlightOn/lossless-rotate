/**
 * Shared test fixtures and helpers: the fixture corpus, the manifest, the CLI runner and the small
 * utilities every suite needs.
 *
 * Format-specific helpers stay next to their format — `test/avif/helpers.ts` holds the independent
 * AVIF box walker, the JPEG suites carry their own TIFF/IFD readers — so that nothing here has to
 * know which format a test is about.
 */

import { type ExecFileSyncOptionsWithStringEncoding, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { OrientError } from "../../src/errors.ts";

/** Repository root, so tests can reach `bin/`, `package.json` and the corpus without counting `..`. */
export const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const fixturesDir = join(packageRoot, "test", "fixtures");

export const pathOf = (file: string): string => join(fixturesDir, file);
export const bytesOf = (file: string): Buffer => readFileSync(pathOf(file));

/** Common shape of a fixture manifest entry; suites extend it with their format-specific fields. */
export interface Fixture {
  file: string;
  bytes: number;
  format?: string;
  kind?: string;
  comment?: string;
  expect?: { read?: number; error?: string };
}

/** Reads the fixture manifest. Each suite supplies the entry shape it expects. */
export function loadManifest<T>(): { files: T[] } {
  return JSON.parse(readFileSync(join(fixturesDir, "manifest.json"), "utf8"));
}

export function errorCodeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof OrientError) return error.code;
    if (error instanceof Error) return `${error.name}: ${error.message}`;
    return String(error);
  }
  return "<no error>";
}

export async function errorCodeOfAsync(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof OrientError) return error.code;
    if (error instanceof Error) return `${error.name}: ${error.message}`;
    return String(error);
  }
  return "<no error>";
}

/** The offsets at which two buffers differ, so a failure says where instead of only "not equal". */
export function differingOffsets(left: Uint8Array, right: Uint8Array): number[] {
  const offsets: number[] = [];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] !== right[i]) offsets.push(i);
  }
  return offsets;
}

export function available(command: string): boolean {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * A scratch directory to run the CLI in. Its own `tmp/` is the CLI's default output directory, which
 * keeps the repository clean and makes the "writes into tmp/" behaviour testable at the same time.
 */
export function scratch(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "lossless-rotate-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Runs the CLI in `cwd` and reports the exit status instead of throwing. */
export function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number } {
  const cli = join(packageRoot, "bin", "lossless-rotate.ts");
  // `stdio` is explicit: `execFileSync` otherwise echoes the child's stderr to the parent's stderr,
  // which would print the CLI's own error messages (and usage) into the test output.
  const options: ExecFileSyncOptionsWithStringEncoding = { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
  try {
    return { stdout: execFileSync(process.execPath, [cli, ...args], options), stderr: "", status: 0 };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", status: failed.status ?? 1 };
  }
}
