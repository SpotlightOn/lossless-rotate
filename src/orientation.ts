/**
 * Mapping from an EXIF orientation value to the transform that makes the image upright.
 *
 * This table is the only thing the v1 code got right by hand (`lib/autoRotate.js` mapped the eight
 * cases onto GraphicsMagick calls). It is kept here as pure data so the codec layer of Phase 2 can
 * consume it, and so it can be verified analytically without any image library.
 *
 * Both representations are exposed: a primitive (what a lossless DCT-domain transform wants, e.g.
 * jpegtran's `-transpose`) and the equivalent "rotate, then mirror" composition (what a
 * pixel-domain codec wants).
 */

export type Rotation = 0 | 90 | 180 | 270;

export type OrientationPrimitive =
  | "none"
  | "flipHorizontal"
  | "flipVertical"
  | "rotate180"
  | "rotate90"
  | "rotate270"
  | "transpose"
  | "transverse";

export interface OrientationTransform {
  orientation: number;
  primitive: OrientationPrimitive;
  /** Clockwise rotation to apply first. */
  rotate: Rotation;
  /** Mirror left/right, applied after the rotation. */
  flipHorizontal: boolean;
  /** Mirror top/bottom, applied after the rotation. */
  flipVertical: boolean;
}

/**
 * Note on what a lossless transform can and cannot do (measured, see DESIGN.md section 5):
 *
 *  - The sampling factors are *not* a limitation. A 4:2:2 image can be rotated by exactly 90
 *    degrees; the horizontal and vertical sampling factors are swapped in the process.
 *  - The real constraint is the MCU geometry: a transform is "perfect" (fully reversible, no edge
 *    blocks left behind) only when the image dimensions are multiples of the interleaved MCU size
 *    in the axes the transform touches. jpegtran refuses such files with `-perfect` and proceeds
 *    with a warning otherwise.
 *  - Images smaller than a single MCU are degenerate: the block grid cannot be reordered, so the
 *    transform has nothing to do.
 *
 * Whether a given file is transformable therefore has to be decided per file from its SOF segment,
 * not from this table.
 */

const TRANSFORMS: Record<number, Omit<OrientationTransform, "orientation">> = {
  1: { primitive: "none", rotate: 0, flipHorizontal: false, flipVertical: false },
  2: { primitive: "flipHorizontal", rotate: 0, flipHorizontal: true, flipVertical: false },
  3: { primitive: "rotate180", rotate: 180, flipHorizontal: false, flipVertical: false },
  4: { primitive: "flipVertical", rotate: 0, flipHorizontal: false, flipVertical: true },
  5: { primitive: "transpose", rotate: 90, flipHorizontal: true, flipVertical: false },
  6: { primitive: "rotate90", rotate: 90, flipHorizontal: false, flipVertical: false },
  7: { primitive: "transverse", rotate: 270, flipHorizontal: true, flipVertical: false },
  8: { primitive: "rotate270", rotate: 270, flipHorizontal: false, flipVertical: false },
};

/**
 * Transform that brings an image with the given EXIF orientation value upright.
 *
 * @throws RangeError for values outside 1..8.
 */
export function transformFor(orientation: number): OrientationTransform {
  const transform = TRANSFORMS[orientation];
  if (transform === undefined) {
    throw new RangeError(`unknown orientation value: ${orientation}`);
  }
  return { orientation, ...transform };
}

/** True when the transform leaves the pixels untouched. */
export function isIdentity(transform: OrientationTransform): boolean {
  return transform.rotate === 0 && !transform.flipHorizontal && !transform.flipVertical;
}

/** The orientation value of a plain clockwise rotation. */
const ROTATION_ORIENTATION: Record<Rotation, number> = { 0: 1, 90: 6, 180: 3, 270: 8 };

/**
 * The transform for a plain clockwise rotation: `transformForRotation(90)` is the "turn 90 degrees
 * clockwise" transform, `0` is the identity. `orientation` is the value such a rotation is stored as.
 */
export function transformForRotation(rotation: Rotation): OrientationTransform {
  return transformFor(ROTATION_ORIENTATION[rotation]);
}

/**
 * The eight transforms as affine maps of the unit square, `(x, y) -> (a*x + b*y + c, d*x + e*y + f)`
 * with the corners at 0 and 1. Their group is exactly the eight orientations, and composing maps on
 * four corners is ordinary arithmetic, so `composeTransforms` does not need a hand-typed 8x8 table
 * (which is where such tables usually go wrong).
 */
interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

const AFFINE: Record<OrientationPrimitive, Affine> = {
  none: { a: 1, b: 0, c: 0, d: 0, e: 1, f: 0 },
  flipHorizontal: { a: -1, b: 0, c: 1, d: 0, e: 1, f: 0 },
  flipVertical: { a: 1, b: 0, c: 0, d: 0, e: -1, f: 1 },
  rotate180: { a: -1, b: 0, c: 1, d: 0, e: -1, f: 1 },
  rotate90: { a: 0, b: -1, c: 1, d: 1, e: 0, f: 0 },
  rotate270: { a: 0, b: 1, c: 0, d: -1, e: 0, f: 1 },
  transpose: { a: 0, b: 1, c: 0, d: 1, e: 0, f: 0 },
  transverse: { a: 0, b: -1, c: 1, d: -1, e: 0, f: 1 },
};

const affineKey = (map: Affine): string => `${map.a},${map.b},${map.c},${map.d},${map.e},${map.f}`;

const ORIENTATION_BY_AFFINE = new Map<string, number>();
for (let orientation = 1; orientation <= 8; orientation++) {
  ORIENTATION_BY_AFFINE.set(affineKey(AFFINE[transformFor(orientation).primitive]), orientation);
}

/** `outer` applied after `inner`: (outer ∘ inner)(p) = outer(inner(p)). */
function composeAffine(inner: Affine, outer: Affine): Affine {
  return {
    a: outer.a * inner.a + outer.b * inner.d,
    b: outer.a * inner.b + outer.b * inner.e,
    c: outer.a * inner.c + outer.b * inner.f + outer.c,
    d: outer.d * inner.a + outer.e * inner.d,
    e: outer.d * inner.b + outer.e * inner.e,
    f: outer.d * inner.c + outer.e * inner.f + outer.f,
  };
}

/**
 * The transform that applies `first` and then `second`.
 *
 * This is what "make it upright and then turn it another 90 degrees" needs to stay a single lossless
 * pass: the composition is one primitive, not two transforms in a row (which would move the partial
 * edge blocks twice and warn twice).
 */
export function composeTransforms(first: OrientationTransform, second: OrientationTransform): OrientationTransform {
  const composed = composeAffine(AFFINE[first.primitive], AFFINE[second.primitive]);
  const orientation = ORIENTATION_BY_AFFINE.get(affineKey(composed));
  if (orientation === undefined) {
    throw new Error(`the composed transform is not one of the eight orientations: ${affineKey(composed)}`);
  }
  return transformFor(orientation);
}
