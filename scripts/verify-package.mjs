/**
 * Installs the packed tarball into a throwaway `node_modules` and imports it the way a consumer
 * would. This is the check that catches the class of bug that shipping TypeScript sources causes:
 * Node refuses to strip types for anything under `node_modules`
 * (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so the package has to point at its build output.
 *
 * Usage: node scripts/verify-package.mjs
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const workDir = await mkdtemp(join(tmpdir(), "lossless-rotate-pack-"));

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: "pipe", ...options });
}

try {
  // 1. Pack exactly what `npm publish` would upload.
  const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", workDir]));
  const [{ filename, files }] = Object.values(packed);
  const names = files.map((file) => file.path);

  for (const required of ["package.json", "README.md", "LICENSE", "dist/src/index.js", "dist/src/index.d.ts"]) {
    assert.ok(names.includes(required), `tarball is missing ${required}`);
  }
  assert.ok(
    names.every((name) => name.endsWith(".js") || name.endsWith(".d.ts") || !name.startsWith("dist/")),
    `dist/ must ship only JavaScript and declarations, got: ${names.filter((n) => n.startsWith("dist/")).join(", ")}`,
  );

  // 2. Unpack it under node_modules and import it through the package name.
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const consumer = join(workDir, "consumer");
  const installed = join(consumer, "node_modules", ...pkg.name.split("/"));
  await mkdir(installed, { recursive: true });
  run("tar", ["-xzf", join(workDir, filename), "-C", installed, "--strip-components=1"]);

  const probe = join(consumer, "probe.mjs");
  await writeFile(
    probe,
    [
      `import assert from "node:assert/strict";`,
      `import * as lib from "${pkg.name}";`,
      `import { readAvifOrientation } from "${pkg.name}/avif";`,
      `assert.equal(typeof lib.orientation, "function");`,
      `assert.equal(typeof lib.autoRotate, "function");`,
      `assert.equal(typeof lib.isAvifSequence, "function");`,
      `assert.equal(typeof readAvifOrientation, "function");`,
      `console.log("imported from node_modules:", Object.keys(lib).length, "exports");`,
    ].join("\n"),
  );
  console.log(run(process.execPath, [probe]));

  // 3. The bin has to be installed as a command and run.
  console.log(run(process.execPath, [join(installed, "dist/bin/lossless-rotate.js"), "--version"]));
  console.log("package verification passed");
} finally {
  await rm(workDir, { recursive: true, force: true });
}
