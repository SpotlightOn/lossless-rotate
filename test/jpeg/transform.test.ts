/**
 * Transform correctness, verified without any external tool.
 *
 * Two independent checks:
 *
 *  1. the coefficient mapping is compared against a literal implementation written in this file
 *     (block permutation + per-block transpose/sign), so a mistake in the codec shows up as a
 *     coefficient difference;
 *  2. the resulting geometry (dimensions, sampling factors, block grids) is checked against what the
 *     transform promises.
 *
 * The comparison against jpegtran lives in test/jpeg-differential.test.ts and needs djpeg/jpegtran.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { transformJpeg } from "../../src/jpeg/codec.ts";
import { decodeCoefficients } from "../../src/jpeg/decoder.ts";
import { frameGeometry, isPerfectTransform, swapsAxes } from "../../src/jpeg/geometry.ts";
import { parseJpeg } from "../../src/jpeg/parse.ts";
import { ZIGZAG_TO_NATURAL } from "../../src/jpeg/tables.ts";
import { type OrientationPrimitive, transformFor } from "../../src/orientation.ts";
import { bytesOf } from "../core/helpers.ts";

const PRIMITIVES: OrientationPrimitive[] = [
  "none",
  "flipHorizontal",
  "flipVertical",
  "rotate180",
  "rotate90",
  "rotate270",
  "transpose",
  "transverse",
];

const BLOCK_SIZE = 64;

interface Plane {
  widthInBlocks: number;
  heightInBlocks: number;
  blocks: Int16Array;
}

/** Literal, independent implementation of the coefficient transform. */
function expectedPlane(source: Plane, primitive: OrientationPrimitive): Plane {
  const swaps = swapsAxes(primitive);
  const width = swaps ? source.heightInBlocks : source.widthInBlocks;
  const height = swaps ? source.widthInBlocks : source.heightInBlocks;
  const blocks = new Int16Array(width * height * BLOCK_SIZE);

  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const [sourceColumn, sourceRow] = sourceBlockFor(
        primitive,
        column,
        row,
        source.widthInBlocks,
        source.heightInBlocks,
      );
      const sourceBase = (sourceRow * source.widthInBlocks + sourceColumn) * BLOCK_SIZE;
      const destinationBase = (row * width + column) * BLOCK_SIZE;
      for (let v = 0; v < 8; v++) {
        for (let u = 0; u < 8; u++) {
          // Read the source coefficient, transposed for axis swapping primitives.
          const sourceU = swaps ? v : u;
          const sourceV = swaps ? u : v;
          const value = source.blocks[sourceBase + sourceV * 8 + sourceU]!;
          const sign = signFor(primitive, u, v);
          blocks[destinationBase + v * 8 + u] = sign === 1 ? value : -value;
        }
      }
    }
  }
  return { widthInBlocks: width, heightInBlocks: height, blocks };
}

function sourceBlockFor(
  primitive: OrientationPrimitive,
  column: number,
  row: number,
  width: number,
  height: number,
): [number, number] {
  switch (primitive) {
    case "none":
      return [column, row];
    case "flipHorizontal":
      return [width - 1 - column, row];
    case "flipVertical":
      return [column, height - 1 - row];
    case "rotate180":
      return [width - 1 - column, height - 1 - row];
    case "rotate90":
      return [row, height - 1 - column];
    case "rotate270":
      return [width - 1 - row, column];
    case "transpose":
      return [row, column];
    case "transverse":
      return [width - 1 - row, height - 1 - column];
    default:
      throw new Error(primitive);
  }
}

function signFor(primitive: OrientationPrimitive, u: number, v: number): number {
  switch (primitive) {
    case "flipHorizontal":
      return u % 2 === 0 ? 1 : -1;
    case "flipVertical":
      return v % 2 === 0 ? 1 : -1;
    case "rotate180":
      return (u + v) % 2 === 0 ? 1 : -1;
    case "rotate90":
      return u % 2 === 0 ? 1 : -1;
    case "rotate270":
      return v % 2 === 0 ? 1 : -1;
    case "transverse":
      return (u + v) % 2 === 0 ? 1 : -1;
    default:
      return 1;
  }
}

function planesOf(bytes: Uint8Array): Plane[] {
  return decodeCoefficients(parseJpeg(bytes)).map((component) => ({
    widthInBlocks: component.paddedWidthInBlocks,
    heightInBlocks: component.paddedHeightInBlocks,
    blocks: component.blocks,
  }));
}

const IMAGES = [
  "base/pattern-64x48-420.jpg",
  "base/pattern-64x48-422.jpg",
  "base/pattern-64x48-444.jpg",
  "base/pattern-64x48-progressive-420.jpg",
  "base/pattern-8x8-444.jpg",
];

test("every primitive rearranges the coefficients exactly as specified", () => {
  for (const file of IMAGES) {
    const original = bytesOf(file);
    const source = planesOf(original);
    for (const primitive of PRIMITIVES) {
      const result = transformJpeg(original, { primitive });
      const actual = planesOf(result.bytes);
      const parsedSource = parseJpeg(original);
      const singleComponent = parsedSource.frame.components.length === 1;
      assert.equal(actual.length, source.length, `${file} ${primitive}`);

      for (let index = 0; index < source.length; index++) {
        const sourcePlane = source[index]!;
        // A single component frame is cropped to its real grid, so the expected plane is too.
        const expected = singleComponent
          ? expectedPlane(cropToReal(sourcePlane, parsedSource.frame.width, parsedSource.frame.height), primitive)
          : expectedPlane(sourcePlane, primitive);
        const actualPlane = actual[index]!;
        assert.equal(
          actualPlane.widthInBlocks,
          expected.widthInBlocks,
          `${file} ${primitive} component ${index} width`,
        );
        assert.equal(
          actualPlane.heightInBlocks,
          expected.heightInBlocks,
          `${file} ${primitive} component ${index} height`,
        );
        assert.deepEqual(
          [...actualPlane.blocks.subarray(0, expected.blocks.length)],
          [...expected.blocks],
          `${file} ${primitive} component ${index} coefficients`,
        );
      }
    }
  }
});

function cropToReal(plane: Plane, width: number, height: number): Plane {
  const realWidth = Math.ceil(Math.ceil((width * 1) / 1) / 8);
  const realHeight = Math.ceil(height / 8);
  if (realWidth === plane.widthInBlocks && realHeight === plane.heightInBlocks) return plane;
  const blocks = new Int16Array(realWidth * realHeight * BLOCK_SIZE);
  for (let row = 0; row < realHeight; row++) {
    blocks.set(
      plane.blocks.subarray(
        row * plane.widthInBlocks * BLOCK_SIZE,
        (row * plane.widthInBlocks + realWidth) * BLOCK_SIZE,
      ),
      row * realWidth * BLOCK_SIZE,
    );
  }
  return { widthInBlocks: realWidth, heightInBlocks: realHeight, blocks };
}

test("the geometry of the result matches the transform", () => {
  for (const file of IMAGES) {
    const original = parseJpeg(bytesOf(file));
    for (const primitive of PRIMITIVES) {
      const result = transformJpeg(bytesOf(file), { primitive });
      const output = parseJpeg(result.bytes);
      const swaps = swapsAxes(primitive);

      assert.equal(
        output.frame.width,
        swaps ? original.frame.height : original.frame.width,
        `${file} ${primitive} width`,
      );
      assert.equal(
        output.frame.height,
        swaps ? original.frame.width : original.frame.height,
        `${file} ${primitive} height`,
      );
      assert.equal(output.frame.progressive, false, `${file} ${primitive} must be written sequentially`);
      assert.equal(output.scans.length, 1, `${file} ${primitive} single scan`);

      for (let index = 0; index < original.frame.components.length; index++) {
        const before = original.frame.components[index]!;
        const after = output.frame.components[index]!;
        assert.equal(after.id, before.id, `${file} ${primitive} component id`);
        assert.equal(after.quantTableId, before.quantTableId, `${file} ${primitive} quant table`);
        assert.equal(after.h, swaps ? before.v : before.h, `${file} ${primitive} h`);
        assert.equal(after.v, swaps ? before.h : before.v, `${file} ${primitive} v`);
      }
    }
  }
});

test("the quantization tables are transposed exactly for the axis swapping transforms", () => {
  const original = parseJpeg(bytesOf("base/pattern-64x48-444.jpg"));
  const identity = parseJpeg(
    transformJpeg(bytesOf("base/pattern-64x48-444.jpg"), { primitive: "flipHorizontal" }).bytes,
  );
  assert.deepEqual([...identity.quantizationTables.get(0)!.values], [...original.quantizationTables.get(0)!.values]);

  const transposed = parseJpeg(transformJpeg(bytesOf("base/pattern-64x48-444.jpg"), { primitive: "transpose" }).bytes);
  const before = original.quantizationTables.get(0)!.values;
  const after = transposed.quantizationTables.get(0)!.values;
  let differs = false;
  for (let i = 0; i < 64; i++) {
    const natural = ZIGZAG_TO_NATURAL[i]!;
    const u = natural % 8;
    const v = (natural - u) / 8;
    // Q'(u, v) = Q(v, u): the value at (u, v) comes from the natural index u * 8 + v.
    const swapped = ZIGZAG_TO_NATURAL.indexOf(u * 8 + v);
    assert.equal(after[i], before[swapped]!, `zigzag ${i} must come from ${swapped}`);
    if (after[i] !== before[i]) differs = true;
  }
  assert.equal(differs, true, "the table of this fixture is not symmetric, so the test is meaningful");
});

test("imperfect transforms are reported, perfect ones are not", () => {
  const cases: [string, OrientationPrimitive, boolean][] = [
    ["base/pattern-64x48-420.jpg", "rotate90", true],
    ["base/pattern-64x48-420.jpg", "rotate180", true],
    ["base/pattern-64x48-420.jpg", "transpose", true],
    ["base/pattern-41x27-420.jpg", "rotate90", false],
    ["base/pattern-41x27-420.jpg", "flipHorizontal", false],
    ["base/pattern-41x27-420.jpg", "transpose", true], // jpegtran imposes no condition here
    ["base/pattern-3x2-420.jpg", "rotate180", false],
    ["base/pattern-8x8-444.jpg", "rotate180", true],
  ];

  for (const [file, primitive, perfect] of cases) {
    const parsed = parseJpeg(bytesOf(file));
    const geometry = frameGeometry(parsed.frame);
    assert.equal(isPerfectTransform(geometry, primitive), perfect, `${file} ${primitive} predicate`);

    const result = transformJpeg(bytesOf(file), { primitive });
    assert.equal(result.perfect, perfect, `${file} ${primitive} result flag`);
    assert.equal(result.warnings.length > 0, !perfect, `${file} ${primitive} warning`);
    if (!perfect) {
      assert.match(result.warnings[0]!, /not multiples of the MCU size/);
    }
  }
});

test("onImperfect: error refuses instead of producing a shifted image", () => {
  assert.throws(
    () => transformJpeg(bytesOf("base/pattern-41x27-420.jpg"), { primitive: "rotate90", mcuAlignedOnly: true }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /padding blocks into the visible area/);
      return true;
    },
  );
});

test("the orientation table drives the transform", () => {
  for (const orientation of [1, 3, 6, 8]) {
    const transform = transformFor(orientation);
    const viaOrientation = transformJpeg(bytesOf("base/pattern-64x48-420.jpg"), { orientation });
    const viaPrimitive = transformJpeg(bytesOf("base/pattern-64x48-420.jpg"), { primitive: transform.primitive });
    assert.deepEqual(viaOrientation.bytes, viaPrimitive.bytes, `orientation ${orientation}`);
  }
});

test("unsupported inputs are rejected with a clear code", () => {
  const notJpeg = Buffer.from("89504e470d0a1a0a", "hex");
  assert.throws(
    () => transformJpeg(notJpeg, { primitive: "none" }),
    (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error);
      assert.equal((error as { code: string }).code, "E_NOT_JPEG");
      return true;
    },
  );
});
