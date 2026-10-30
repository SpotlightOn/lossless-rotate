/**
 * Crop correctness, verified without any external tool.
 *
 * A crop is the one coefficient-domain operation that changes no coefficient: the blocks of the region
 * are selected and everything inside them stays as it was. So the check is direct and strong: decode
 * the result, decode the source, and compare the result against the sub-grid of the source that the
 * region names - block by block, coefficient by coefficient.
 *
 * The block arithmetic is restated literally here (pixel offset -> block offset per component) so a
 * mistake in `cropGeometry` shows up as a coefficient difference rather than as agreement with itself.
 * The comparison against jpegtran lives in test/jpeg/differential.test.ts.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { cropBuffer } from "../../src/crop.ts";
import { transformJpeg } from "../../src/jpeg/codec.ts";
import { type ComponentCoefficients, decodeCoefficients } from "../../src/jpeg/decoder.ts";
import {
  type CropRegion,
  cropGeometry,
  cropRegionToString,
  type Frame,
  frameGeometry,
} from "../../src/jpeg/geometry.ts";
import { parseJpeg } from "../../src/jpeg/parse.ts";
import { bytesOf, errorCodeOf } from "../core/helpers.ts";

const BLOCK_SIZE = 64;

interface Plane {
  widthInBlocks: number;
  heightInBlocks: number;
  blocks: Int16Array;
}

const planesOf = (bytes: Uint8Array): Plane[] =>
  decodeCoefficients(parseJpeg(bytes)).map((component: ComponentCoefficients) => ({
    widthInBlocks: component.paddedWidthInBlocks,
    heightInBlocks: component.paddedHeightInBlocks,
    blocks: component.blocks,
  }));

/**
 * What the crop has to produce, restated from the region in pixels: the origin rounds down to the MCU
 * grid, the far edge stays where it was asked for, and each component's blocks follow its sampling.
 *
 * `widthInBlocks`/`heightInBlocks` are the padded grid that is encoded (whole MCUs); the real grid
 * that is visible is the `real*` pair, which can be one block smaller on each axis.
 */
function expectedCrop(frame: Frame, region: CropRegion) {
  const { maxH, maxV } = frame;
  const x = Math.floor(region.x / (8 * maxH)) * 8 * maxH;
  const y = Math.floor(region.y / (8 * maxV)) * 8 * maxV;
  const width = region.x + region.width - x;
  const height = region.y + region.height - y;
  return {
    width,
    height,
    components: frame.components.map((component) => ({
      offsetX: (x / (8 * maxH)) * component.h,
      offsetY: (y / (8 * maxV)) * component.v,
      widthInBlocks: Math.ceil(width / (8 * maxH)) * component.h,
      heightInBlocks: Math.ceil(height / (8 * maxV)) * component.v,
      realWidthInBlocks: Math.ceil(Math.ceil((width * component.h) / maxH) / 8),
      realHeightInBlocks: Math.ceil(Math.ceil((height * component.v) / maxV) / 8),
    })),
  };
}

const CASES: [string, CropRegion, string][] = [
  // The common case: a whole number of iMCUs, every sampling factor.
  ["base/pattern-64x48-420.jpg", { x: 16, y: 16, width: 32, height: 16 }, "4:2:0"],
  ["base/pattern-64x48-422.jpg", { x: 16, y: 0, width: 32, height: 48 }, "4:2:2"],
  ["base/pattern-64x48-444.jpg", { x: 8, y: 8, width: 24, height: 16 }, "4:4:4"],
  // A progressive source: same coefficients, written out sequentially.
  ["base/pattern-64x48-progressive-420.jpg", { x: 16, y: 16, width: 32, height: 16 }, "progressive"],
  // An image that is not MCU aligned itself: the last iMCU is partial, and the crop keeps it that way.
  ["base/pattern-41x27-420.jpg", { x: 16, y: 16, width: 25, height: 11 }, "41x27"],
  // A region smaller than one iMCU, and one that covers everything.
  ["base/pattern-64x48-420.jpg", { x: 32, y: 32, width: 1, height: 1 }, "1x1"],
  ["base/pattern-64x48-420.jpg", { x: 0, y: 0, width: 64, height: 40 }, "full width"],
];

test("a crop copies exactly the blocks of the region and changes no coefficient", () => {
  for (const [file, region, label] of CASES) {
    const original = bytesOf(file);
    const frame = parseJpeg(original).frame;
    const source = planesOf(original);
    const expected = expectedCrop(frame, region);

    const { bytes, result } = cropBuffer(original, region);
    const actual = planesOf(bytes);
    const output = parseJpeg(bytes);
    const spec = `${label} ${cropRegionToString(region)}`;

    assert.equal(output.frame.width, expected.width, `${spec} width`);
    assert.equal(output.frame.height, expected.height, `${spec} height`);
    assert.deepEqual(result.region, { x: region.x, y: region.y, width: region.width, height: region.height });
    assert.equal(result.perfect, true, `${label} origin is on the grid`);
    assert.equal(result.copied, false);

    assert.equal(actual.length, source.length, `${label} component count`);
    const visible = frameGeometry(output.frame).components;
    for (let index = 0; index < source.length; index++) {
      const component = expected.components[index]!;
      const plane = actual[index]!;
      const real = visible[index]!;
      assert.equal(plane.widthInBlocks, component.widthInBlocks, `${label} component ${index} block width`);
      assert.equal(plane.heightInBlocks, component.heightInBlocks, `${label} component ${index} block height`);
      assert.equal(real.widthInBlocks, component.realWidthInBlocks, `${label} component ${index} visible width`);
      assert.equal(real.heightInBlocks, component.realHeightInBlocks, `${label} component ${index} visible height`);

      for (let row = 0; row < plane.heightInBlocks; row++) {
        for (let column = 0; column < plane.widthInBlocks; column++) {
          const block = (row * plane.widthInBlocks + column) * BLOCK_SIZE;
          if (column < real.widthInBlocks && row < real.heightInBlocks) {
            const from =
              ((row + component.offsetY) * source[index]!.widthInBlocks + column + component.offsetX) * BLOCK_SIZE;
            assert.deepEqual(
              [...plane.blocks.subarray(block, block + BLOCK_SIZE)],
              [...source[index]!.blocks.subarray(from, from + BLOCK_SIZE)],
              `${label} component ${index} block ${column},${row}`,
            );
          } else {
            // Padding of the partial edge iMCU: outside the visible image, so it is encoded blank
            // rather than carrying the coefficients of the part that was cut away (as jpegtran does).
            assert.deepEqual(
              [...plane.blocks.subarray(block + 1, block + BLOCK_SIZE)].filter((value) => value !== 0),
              [],
              `${label} component ${index} padding block ${column},${row} has no AC coefficients`,
            );
          }
        }
      }
    }
  }
});

test("a crop keeps the frame, the sampling, the quantization tables and the metadata of the source", () => {
  const original = bytesOf("base/pattern-64x48-420.jpg");
  const before = parseJpeg(original);
  const { bytes } = cropBuffer(original, { x: 16, y: 16, width: 32, height: 16 });
  const after = parseJpeg(bytes);

  assert.equal(after.frame.progressive, false, "the result is written sequentially");
  assert.equal(after.scans.length, 1, "the result has one scan");
  assert.equal(after.restartInterval, 0, "restart markers are dropped");
  for (let index = 0; index < before.frame.components.length; index++) {
    const source = before.frame.components[index]!;
    const cropped = after.frame.components[index]!;
    assert.equal(cropped.id, source.id, `component ${index} id`);
    assert.equal(cropped.h, source.h, `component ${index} h`);
    assert.equal(cropped.v, source.v, `component ${index} v`);
    assert.equal(cropped.quantTableId, source.quantTableId, `component ${index} quant table`);
  }

  // A crop never transposes the coefficients, so the quantization tables must not move either.
  for (const [id, table] of before.quantizationTables) {
    assert.deepEqual([...after.quantizationTables.get(id)!.values], [...table.values], `quantization table ${id}`);
  }
  assert.deepEqual(
    after.preserved.map((entry) => [entry.marker, entry.payload.length]),
    before.preserved.map((entry) => [entry.marker, entry.payload.length]),
    "APPn/COM segments are carried over",
  );
});

test("a region that is not on the MCU grid is rounded down and reported", () => {
  const original = bytesOf("base/pattern-64x48-420.jpg");

  // jpegtran's rule: the origin floors to the iMCU grid, the far edge stays where it was asked for.
  const { result, bytes } = cropBuffer(original, { x: 5, y: 3, width: 20, height: 20 });
  assert.equal(result.perfect, false);
  assert.deepEqual(result.region, { x: 0, y: 0, width: 25, height: 23 });
  assert.deepEqual(parseJpeg(bytes).frame.width, 25);
  assert.deepEqual(parseJpeg(bytes).frame.height, 23);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /20x20\+5\+3 does not start on the MCU grid \(16x16 pixels\)/);
  assert.match(result.warnings[0]!, /result covers 25x23\+0\+0/);

  // An aligned origin but a size that is not a multiple of the iMCU is fine: the edge iMCU is padding.
  const aligned = cropBuffer(original, { x: 16, y: 0, width: 20, height: 20 });
  assert.equal(aligned.result.perfect, true);
  assert.deepEqual(aligned.result.region, { x: 16, y: 0, width: 20, height: 20 });
  assert.equal(aligned.result.warnings.length, 0);
});

test("onUnaligned: error refuses a rounded crop instead of producing another region", () => {
  assert.throws(
    () =>
      cropBuffer(
        bytesOf("base/pattern-64x48-420.jpg"),
        { x: 5, y: 3, width: 20, height: 20 },
        { onUnaligned: "error" },
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error);
      assert.equal((error as { code: string }).code, "E_UNSUPPORTED");
      assert.match(error.message, /does not start on the MCU grid/);
      return true;
    },
  );
});

test("a region that does not describe part of the image is refused", () => {
  const original = bytesOf("base/pattern-64x48-420.jpg");
  const invalid: [string, CropRegion][] = [
    ["negative origin", { x: -16, y: 0, width: 16, height: 16 }],
    ["empty", { x: 0, y: 0, width: 0, height: 16 }],
    ["zero height", { x: 0, y: 0, width: 16, height: 0 }],
    ["past the right edge", { x: 48, y: 0, width: 32, height: 16 }],
    ["past the bottom edge", { x: 0, y: 32, width: 16, height: 32 }],
    ["fractional", { x: 8.5, y: 0, width: 16, height: 16 }],
  ];
  for (const [label, region] of invalid) {
    assert.equal(
      errorCodeOf(() => cropBuffer(original, region)),
      "E_INVALID_VALUE",
      label,
    );
  }
});

test("a region that is the whole image is copied byte for byte", () => {
  const original = bytesOf("base/pattern-64x48-420.jpg");
  const { result, bytes } = cropBuffer(original, { x: 0, y: 0, width: 64, height: 48 });
  assert.equal(result.copied, true);
  assert.equal(result.perfect, true);
  assert.deepEqual(bytes, original, "nothing is re-encoded when there is nothing to cut");
});

test("a crop counts from the image as it is seen, i.e. after the rotation", () => {
  // The strongest check available here: rotating first and cropping the result (a path that is
  // already verified coefficient by coefficient) has to come out the same as one combined pass.
  const original = bytesOf("base/pattern-64x48-420.jpg");
  const region: CropRegion = { x: 0, y: 16, width: 48, height: 32 };
  const rotated = transformJpeg(original, { primitive: "rotate90" });
  const sequential = cropBuffer(rotated.bytes, region);
  const combined = transformJpeg(original, { primitive: "rotate90", crop: region });

  assert.deepEqual(parseJpeg(combined.bytes).frame.width, parseJpeg(sequential.bytes).frame.width, "width");
  assert.deepEqual(parseJpeg(combined.bytes).frame.height, parseJpeg(sequential.bytes).frame.height, "height");
  const expected = planesOf(sequential.bytes);
  const actual = planesOf(combined.bytes);
  for (let index = 0; index < expected.length; index++) {
    assert.deepEqual([...actual[index]!.blocks], [...expected[index]!.blocks], `component ${index} coefficients`);
  }
  assert.deepEqual(combined.crop!.region, sequential.result.region, "the same region comes out");
});

test("cropGeometry owns the block arithmetic, for colour and for grayscale frames", () => {
  const colour = frameGeometry({
    marker: 0xc0,
    progressive: false,
    precision: 8,
    width: 41,
    height: 27,
    components: [
      { id: 1, h: 2, v: 2, quantTableId: 0 },
      { id: 2, h: 1, v: 1, quantTableId: 1 },
      { id: 3, h: 1, v: 1, quantTableId: 1 },
    ],
    maxH: 2,
    maxV: 2,
  });

  // A whole number of iMCUs: offsets and sizes follow the sampling factors.
  const aligned = cropGeometry(colour, { x: 16, y: 16, width: 16, height: 11 });
  assert.deepEqual(aligned.region, { x: 16, y: 16, width: 16, height: 11 });
  assert.equal(aligned.perfect, true);
  assert.deepEqual(
    aligned.components.map((component) => [
      component.blockOffsetX,
      component.blockOffsetY,
      component.widthInBlocks,
      component.heightInBlocks,
    ]),
    [
      [2, 2, 2, 2],
      [1, 1, 1, 1],
      [1, 1, 1, 1],
    ],
    "4:2:0: one luma block offset per 8 pixels, half as many chroma blocks",
  );
  assert.equal(aligned.frame.width, 16);
  assert.equal(aligned.frame.height, 11);

  // A grayscale frame is built with 1x1 sampling, so its MCU is a single block.
  const grayscale = frameGeometry({
    marker: 0xc0,
    progressive: false,
    precision: 8,
    width: 41,
    height: 27,
    components: [{ id: 1, h: 1, v: 1, quantTableId: 0 }],
    maxH: 1,
    maxV: 1,
  });
  assert.equal(grayscale.mcuWidth, 8);
  const whole = cropGeometry(grayscale, { x: 0, y: 0, width: 41, height: 27 });
  assert.equal(whole.perfect, true);
  assert.deepEqual(
    [whole.components[0]!.widthInBlocks, whole.components[0]!.heightInBlocks],
    [6, 4],
    "41x27 rounds up to a 6x4 block grid",
  );

  // A non-aligned origin floors to the grid and takes the far edge with it.
  const rounded = cropGeometry(grayscale, { x: 4, y: 0, width: 8, height: 8 });
  assert.equal(rounded.perfect, false);
  assert.deepEqual(rounded.region, { x: 0, y: 0, width: 12, height: 8 });
  assert.deepEqual(
    [rounded.components[0]!.widthInBlocks, rounded.components[0]!.heightInBlocks],
    [2, 1],
    "12x8 still fits into two blocks",
  );
});

test("the embedded Exif thumbnail is left alone, and the result says so", () => {
  const original = bytesOf("exif-thumbnail-06.jpg");
  const before = parseJpeg(original);
  const { bytes, result } = cropBuffer(original, { x: 0, y: 0, width: 16, height: 16 });

  assert.ok(
    result.warnings.some((warning) => warning.includes("embedded Exif thumbnail was not cropped")),
    "the stale thumbnail is reported",
  );
  const after = parseJpeg(bytes);
  assert.deepEqual(
    after.preserved.map((entry) => entry.payload.length),
    before.preserved.map((entry) => entry.payload.length),
    "the Exif block is carried over unchanged",
  );
});

test("AVIF is refused with an explanation instead of a JPEG error", () => {
  assert.equal(
    errorCodeOf(() => cropBuffer(bytesOf("lenna.avif"), { x: 0, y: 0, width: 8, height: 8 })),
    "E_UNSUPPORTED",
  );
});
