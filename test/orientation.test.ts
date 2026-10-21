/**
 * Analytic verification of the orientation table in src/orientation.ts.
 *
 * No image library is involved. The oracle is the EXIF specification's description of the stored
 * image ("0th row" / "0th column" position), which is written out explicitly below, plus literal
 * matrix rotations in this file. If the table in src/orientation.ts were wrong, applying the computed
 * transform to the stored matrix would not reproduce the upright one.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  composeTransforms,
  isIdentity,
  type OrientationTransform,
  transformFor,
  transformForRotation,
} from "../src/orientation.ts";

type Matrix = number[][];

/** Upright reference image, every cell unique so any mixing shows up. */
const UPRIGHT: Matrix = [
  [1, 2, 3],
  [4, 5, 6],
];

const height = (m: Matrix): number => m.length;
const width = (m: Matrix): number => m[0]?.length ?? 0;

/** rotate90CW: the first row becomes the last column. out[y][x] = m[h-1-x][y]. */
function rotate90CW(m: Matrix): Matrix {
  const h = height(m);
  const w = width(m);
  return Array.from({ length: w }, (_, y) => Array.from({ length: h }, (_, x) => m[h - 1 - x]![y]!));
}

/** rotate270CW (== rotate90CCW): out[y][x] = m[x][w-1-y]. */
function rotate270CW(m: Matrix): Matrix {
  const w = width(m);
  return Array.from({ length: w }, (_, y) => Array.from({ length: height(m) }, (_, x) => m[x]![w - 1 - y]!));
}

function rotate180(m: Matrix): Matrix {
  return [...m].reverse().map((row) => [...row].reverse());
}

function flipHorizontal(m: Matrix): Matrix {
  return m.map((row) => [...row].reverse());
}

function flipVertical(m: Matrix): Matrix {
  return [...m].reverse();
}

/** Mirror along the main diagonal. */
function transpose(m: Matrix): Matrix {
  const w = width(m);
  return Array.from({ length: w }, (_, y) => Array.from({ length: height(m) }, (_, x) => m[x]![y]!));
}

/** Mirror along the anti-diagonal. */
function transverse(m: Matrix): Matrix {
  const h = height(m);
  const w = width(m);
  return Array.from({ length: w }, (_, y) => Array.from({ length: h }, (_, x) => m[h - 1 - x]![w - 1 - y]!));
}

/**
 * How the file stores the upright image, straight from the EXIF specification:
 *
 *   1 top/left      2 top/right      3 bottom/right    4 bottom/left
 *   5 left/top      6 right/top      7 right/bottom    8 left/bottom
 *
 * (0th row position / 0th column position)
 */
const STORED_AS: Record<number, (upright: Matrix) => Matrix> = {
  1: (u) => u,
  2: flipHorizontal, // 0th row top, 0th column right side
  3: rotate180,
  4: flipVertical,
  5: transpose, // 0th row left side, 0th column top
  6: rotate270CW, // 0th row right side, 0th column top => stored is the upright rotated 90 CCW
  7: transverse, // 0th row right side, 0th column bottom
  8: rotate90CW, // 0th row left side, 0th column bottom => stored is the upright rotated 90 CW
};

/** Applies a transform the way a pixel-domain codec would: rotate first, then mirror. */
function applyTransform(m: Matrix, transform: OrientationTransform): Matrix {
  let result = m;
  if (transform.rotate === 90) result = rotate90CW(result);
  else if (transform.rotate === 180) result = rotate180(result);
  else if (transform.rotate === 270) result = rotate270CW(result);
  if (transform.flipHorizontal) result = flipHorizontal(result);
  if (transform.flipVertical) result = flipVertical(result);
  return result;
}

test("every orientation value maps to the transform that makes the image upright", () => {
  for (let orientation = 1; orientation <= 8; orientation++) {
    const stored = STORED_AS[orientation]!(UPRIGHT);
    const fixed = applyTransform(stored, transformFor(orientation));
    assert.deepEqual(fixed, UPRIGHT, `orientation ${orientation} (${transformFor(orientation).primitive})`);
  }
});

test("the stored image of each orientation is unique", () => {
  const seen = new Map<string, number>();
  for (let orientation = 1; orientation <= 8; orientation++) {
    const key = JSON.stringify(STORED_AS[orientation]!(UPRIGHT));
    assert.equal(seen.has(key), false, `orientation ${orientation} stores the same matrix as ${seen.get(key)}`);
    seen.set(key, orientation);
  }
});

test("transpose and transverse are expressed as rotate + mirror", () => {
  const compose = (m: Matrix, rotate: 90 | 270, flop: boolean): Matrix => {
    const rotated = rotate === 90 ? rotate90CW(m) : rotate270CW(m);
    return flop ? flipHorizontal(rotated) : rotated;
  };

  assert.deepEqual(compose(UPRIGHT, 90, true), transpose(UPRIGHT), "rotate90 + flop must be the transpose");
  assert.deepEqual(compose(UPRIGHT, 270, true), transverse(UPRIGHT), "rotate270 + flop must be the transverse");
});

test("orientation 6 is the rotate-90-clockwise case and 1 is the identity", () => {
  assert.deepEqual(transformFor(6), {
    orientation: 6,
    primitive: "rotate90",
    rotate: 90,
    flipHorizontal: false,
    flipVertical: false,
  });
  assert.equal(isIdentity(transformFor(1)), true);
  assert.equal(isIdentity(transformFor(6)), false);
});

test("the table matches the v1 mapping", () => {
  // The v1 implementation mapped: 2 -> flop, 3 -> rotate 180, 4 -> flip, 5 -> rotate 90 + flop, 6 -> rotate 90,
  //     7 -> rotate 270 + flop, 8 -> rotate 270
  const legacy: Record<number, string> = {
    1: "",
    2: "flop",
    3: "rot180",
    4: "flip",
    5: "rot90+flop",
    6: "rot90",
    7: "rot270+flop",
    8: "rot270",
  };
  for (let orientation = 1; orientation <= 8; orientation++) {
    const transform = transformFor(orientation);
    const parts: string[] = [];
    if (transform.rotate === 180) parts.push("rot180");
    if (transform.rotate === 90) parts.push("rot90");
    if (transform.rotate === 270) parts.push("rot270");
    if (transform.flipHorizontal) parts.push("flop");
    if (transform.flipVertical) parts.push("flip");
    assert.equal(parts.join("+"), legacy[orientation], `orientation ${orientation}`);
  }
});

test("values outside 1..8 are rejected", () => {
  for (const bad of [0, 9, -1, 2.5]) {
    assert.throws(() => transformFor(bad), RangeError, `value ${bad}`);
  }
});

test("every transform is described by both a primitive and a rotate/flip composition", () => {
  for (let orientation = 1; orientation <= 8; orientation++) {
    const transform = transformFor(orientation);
    assert.equal(typeof transform.primitive, "string", `orientation ${orientation}`);
    assert.equal([0, 90, 180, 270].includes(transform.rotate), true, `orientation ${orientation}`);
    assert.equal(typeof transform.flipHorizontal, "boolean");
    assert.equal(typeof transform.flipVertical, "boolean");
  }
});

test("transformForRotation is the plain clockwise rotation it says it is", () => {
  assert.equal(isIdentity(transformForRotation(0)), true);
  assert.equal(transformForRotation(90).primitive, "rotate90");
  assert.equal(transformForRotation(180).primitive, "rotate180");
  assert.equal(transformForRotation(270).primitive, "rotate270");

  // Verified against literal matrix rotations, not against the table that produced them.
  for (const [rotation, expected] of [
    [90, rotate90CW],
    [180, rotate180],
    [270, rotate270CW],
  ] as [90 | 180 | 270, (m: Matrix) => Matrix][]) {
    assert.deepEqual(applyTransform(UPRIGHT, transformForRotation(rotation)), expected(UPRIGHT), `${rotation} degrees`);
  }
});

test("composeTransforms applies the first transform and then the second", () => {
  const primitives: Record<string, (m: Matrix) => Matrix> = {
    none: (m) => m,
    flipHorizontal,
    flipVertical,
    rotate180,
    rotate90: rotate90CW,
    rotate270: rotate270CW,
    transpose,
    transverse,
  };

  for (let first = 1; first <= 8; first++) {
    for (let second = 1; second <= 8; second++) {
      const composed = composeTransforms(transformFor(first), transformFor(second));
      const label = `${transformFor(first).primitive} then ${transformFor(second).primitive}`;

      // The oracle: apply the two primitives to a matrix, one after the other. The composed single
      // transform has to produce the same matrix.
      const stepwise = primitives[transformFor(second).primitive]!(primitives[transformFor(first).primitive]!(UPRIGHT));
      assert.deepEqual(applyTransform(UPRIGHT, composed), stepwise, label);

      // And the result has to be one of the eight orientations, i.e. a real transform.
      assert.equal(Number.isInteger(composed.orientation), true, label);
      assert.deepEqual(transformFor(composed.orientation).primitive, composed.primitive, label);
    }
  }
});

test("composition has the group laws: identity, inverse, and the rotations form a cycle", () => {
  for (let orientation = 1; orientation <= 8; orientation++) {
    const transform = transformFor(orientation);
    assert.deepEqual(composeTransforms(transform, transformFor(1)), transform, `identity after ${orientation}`);
    assert.deepEqual(composeTransforms(transformFor(1), transform), transform, `identity before ${orientation}`);
  }

  // Every orientation is its own inverse or has one that undoes it.
  for (let orientation = 1; orientation <= 8; orientation++) {
    const undo = [1, 2, 3, 4, 5, 6, 7, 8].find(
      (candidate) => composeTransforms(transformFor(orientation), transformFor(candidate)).primitive === "none",
    );
    assert.notEqual(undo, undefined, `orientation ${orientation} has an inverse`);
  }

  // Four 90-degree turns come back to where they started.
  let round = transformForRotation(90);
  for (let turn = 0; turn < 3; turn++) round = composeTransforms(round, transformForRotation(90));
  assert.equal(round.primitive, "none", "rotate90 four times is the identity");
});
