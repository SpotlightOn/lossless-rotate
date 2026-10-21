/**
 * Coefficient round trip: decoding a file and encoding it again must not change a single
 * coefficient, and the geometry must survive.
 *
 * This is the foundation of every lossless claim in this package: if the codec is not transparent
 * without a transform, nothing on top of it can be lossless with one.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { transformJpeg } from "../../src/jpeg/codec.ts";
import { decodeCoefficients } from "../../src/jpeg/decoder.ts";
import { frameGeometry } from "../../src/jpeg/geometry.ts";
import { parseJpeg } from "../../src/jpeg/parse.ts";
import { bytesOf, loadManifest } from "../core/helpers.ts";

interface ManifestEntry {
  file: string;
  kind?: string;
  expect?: { read?: number; error?: string };
}

const manifest = loadManifest<ManifestEntry>();
const baseImages = manifest.files.filter((entry) => entry.file.startsWith("base/"));

/** Every coefficient of every component, as a flat list, for comparison. */
function coefficientsOf(
  bytes: Uint8Array,
): { id: number; widthInBlocks: number; heightInBlocks: number; values: number[] }[] {
  return decodeCoefficients(parseJpeg(bytes)).map((component) => ({
    id: component.component.id,
    widthInBlocks: component.paddedWidthInBlocks,
    heightInBlocks: component.paddedHeightInBlocks,
    values: [...component.blocks],
  }));
}

test("re-encoding without a transform preserves every coefficient", () => {
  assert.ok(baseImages.length >= 8, "expected the base image corpus");
  for (const entry of baseImages) {
    const original = bytesOf(entry.file);
    const result = transformJpeg(original, { primitive: "none" });
    const before = coefficientsOf(original);
    const after = coefficientsOf(result.bytes);

    assert.equal(after.length, before.length, entry.file);
    for (let index = 0; index < before.length; index++) {
      assert.equal(after[index]!.id, before[index]!.id, entry.file);
      assert.equal(after[index]!.widthInBlocks, before[index]!.widthInBlocks, `${entry.file} component ${index} width`);
      assert.equal(
        after[index]!.heightInBlocks,
        before[index]!.heightInBlocks,
        `${entry.file} component ${index} height`,
      );
      assert.deepEqual(after[index]!.values, before[index]!.values, `${entry.file} component ${index} coefficients`);
    }

    // Geometry must survive as well.
    const originalFrame = parseJpeg(original).frame;
    const resultFrame = parseJpeg(result.bytes).frame;
    assert.equal(resultFrame.width, originalFrame.width, `${entry.file} width`);
    assert.equal(resultFrame.height, originalFrame.height, `${entry.file} height`);
    assert.deepEqual(
      resultFrame.components.map((component) => [component.id, component.h, component.v, component.quantTableId]),
      originalFrame.components.map((component) => [component.id, component.h, component.v, component.quantTableId]),
      `${entry.file} components`,
    );
    assert.equal(result.bytes[0], 0xff, entry.file);
    assert.equal(result.bytes[1], 0xd8, entry.file);
    assert.equal(result.bytes[result.bytes.length - 2], 0xff, `${entry.file} EOI`);
    assert.equal(result.bytes[result.bytes.length - 1], 0xd9, `${entry.file} EOI`);
  }
});

test("the encoder writes the standard tables and the source's quantization tables", () => {
  const result = transformJpeg(bytesOf("base/pattern-64x48-420.jpg"), { primitive: "none" });
  const parsed = parseJpeg(result.bytes);
  assert.deepEqual([...parsed.huffmanTables.keys()].sort(), ["0-0", "0-1", "1-0", "1-1"]);
  assert.deepEqual([...parsed.quantizationTables.keys()].sort(), [0, 1]);
  const original = parseJpeg(bytesOf("base/pattern-64x48-420.jpg"));
  for (const [id, table] of original.quantizationTables) {
    assert.deepEqual([...parsed.quantizationTables.get(id)!.values], [...table.values], `quantization table ${id}`);
  }
});

test("metadata segments are carried over", () => {
  const withExif = bytesOf("exif-ii-06-tag.jpg");
  const result = transformJpeg(withExif, { primitive: "none" });
  const preserved = parseJpeg(result.bytes).preserved;
  assert.ok(
    preserved.some((entry) => entry.marker === 0xe1),
    "the Exif APP1 must survive",
  );
  assert.ok(
    preserved.some((entry) => entry.marker === 0xe0),
    "the JFIF APP0 must survive",
  );
});

test("the geometry helper reports the block grids of a real image", () => {
  const parsed = parseJpeg(bytesOf("base/pattern-41x27-420.jpg"));
  const geometry = frameGeometry(parsed.frame);
  assert.equal(geometry.frame.width, 41);
  assert.equal(geometry.frame.height, 27);
  assert.equal(geometry.mcuWidth, 16);
  assert.equal(geometry.mcuHeight, 16);
  assert.equal(geometry.mcuColumns, 3);
  assert.equal(geometry.mcuRows, 2);
  const luma = geometry.components[0]!;
  assert.equal(luma.widthInBlocks, 6);
  assert.equal(luma.heightInBlocks, 4);
  assert.equal(luma.paddedWidthInBlocks, 6);
  assert.equal(luma.paddedHeightInBlocks, 4);
});
