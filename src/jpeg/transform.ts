/**
 * Lossless transforms on quantized DCT coefficients.
 *
 * Every primitive is a rearrangement of whole blocks plus, per block, a transposition and/or sign
 * flips. The rules were derived from the DCT definition and verified numerically (error 0.0000
 * against a forward transform of the literally rotated block); see DESIGN.md.
 *
 * Block grid mapping, with source dimensions W x H in blocks and destination (c, r) = (column, row):
 *
 *   flipHorizontal  dest(c, r) <- src(W-1-c, r)      coefficients: (-1)^u * S(u,v)
 *   flipVertical    dest(c, r) <- src(c, H-1-r)      coefficients: (-1)^v * S(u,v)
 *   rotate180       dest(c, r) <- src(W-1-c, H-1-r)  coefficients: (-1)^(u+v) * S(u,v)
 *   rotate90        dest(c, r) <- src(r, H-1-c)      coefficients: (-1)^u * S(v,u)
 *   rotate270       dest(c, r) <- src(W-1-r, c)      coefficients: (-1)^v * S(v,u)
 *   transpose       dest(c, r) <- src(r, c)          coefficients: S(v,u)
 *   transverse      dest(c, r) <- src(W-1-r, H-1-c)  coefficients: (-1)^(u+v) * S(v,u)
 *
 * `rotate90`/`rotate270`/`transpose`/`transverse` swap the axes, so the caller also has to swap the
 * sampling factors and the image dimensions.
 *
 * A crop belongs here too, because it is the simplest thing that can happen to a coefficient plane:
 * whole blocks are selected, nothing inside them changes (`cropPlane`).
 */

import type { OrientationPrimitive } from "../orientation.ts";
import type { ComponentCrop } from "./geometry.ts";

export interface CoefficientPlane {
  /** Row-major block grid, 64 natural-order coefficients per block. */
  blocks: Int16Array;
  /** Block grid dimensions. */
  widthInBlocks: number;
  heightInBlocks: number;
}

const BLOCK_SIZE = 64;

/** Sign rule of the coefficient at (u, v) for a primitive that does not swap the axes. */
function signFor(primitive: OrientationPrimitive, u: number, v: number): number {
  switch (primitive) {
    case "flipHorizontal":
      return u % 2 === 0 ? 1 : -1;
    case "flipVertical":
      return v % 2 === 0 ? 1 : -1;
    case "rotate180":
      return (u + v) % 2 === 0 ? 1 : -1;
    default:
      return 1;
  }
}

/**
 * Applies `primitive` to a coefficient plane and returns a new plane.
 *
 * The destination grid is the transposed source grid for axis swapping primitives, which is exactly
 * the grid the caller's destination frame describes (padding included), so the mapping is always
 * well defined.
 */
export function transformPlane(source: CoefficientPlane, primitive: OrientationPrimitive): CoefficientPlane {
  if (primitive === "none") {
    return {
      blocks: Int16Array.from(source.blocks),
      widthInBlocks: source.widthInBlocks,
      heightInBlocks: source.heightInBlocks,
    };
  }

  const { blocks, widthInBlocks: sourceWidth, heightInBlocks: sourceHeight } = source;
  const swaps =
    primitive === "rotate90" || primitive === "rotate270" || primitive === "transpose" || primitive === "transverse";
  const width = swaps ? sourceHeight : sourceWidth;
  const height = swaps ? sourceWidth : sourceHeight;
  const destination = new Int16Array(width * height * BLOCK_SIZE);
  const transposesBlock = swaps;

  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      let sourceColumn: number;
      let sourceRow: number;
      switch (primitive) {
        case "flipHorizontal":
          sourceColumn = sourceWidth - 1 - column;
          sourceRow = row;
          break;
        case "flipVertical":
          sourceColumn = column;
          sourceRow = sourceHeight - 1 - row;
          break;
        case "rotate180":
          sourceColumn = sourceWidth - 1 - column;
          sourceRow = sourceHeight - 1 - row;
          break;
        case "rotate90":
          sourceColumn = row;
          sourceRow = sourceHeight - 1 - column;
          break;
        case "rotate270":
          sourceColumn = sourceWidth - 1 - row;
          sourceRow = column;
          break;
        case "transpose":
          sourceColumn = row;
          sourceRow = column;
          break;
        case "transverse":
          sourceColumn = sourceWidth - 1 - row;
          sourceRow = sourceHeight - 1 - column;
          break;
        default:
          throw new Error(`unhandled primitive ${primitive}`);
      }

      const sourceBase = (sourceRow * sourceWidth + sourceColumn) * BLOCK_SIZE;
      const destinationBase = (row * width + column) * BLOCK_SIZE;

      for (let v = 0; v < 8; v++) {
        for (let u = 0; u < 8; u++) {
          // Non-swapping primitives read the coefficient at the same (u, v); swapping primitives
          // read it transposed, i.e. src(u_src = v, v_src = u) -> index u * 8 + v.
          const sourceIndex = transposesBlock ? sourceBase + u * 8 + v : sourceBase + v * 8 + u;
          const value = blocks[sourceIndex]!;
          if (value === 0) continue;
          const sign = transposesBlock ? signForSwapped(primitive, u, v) : signFor(primitive, u, v);
          destination[destinationBase + v * 8 + u] = sign === 1 ? value : -value;
        }
      }
    }
  }

  return { blocks: destination, widthInBlocks: width, heightInBlocks: height };
}

/** Sign rule for the axis swapping primitives, where the coefficient is read transposed. */
function signForSwapped(primitive: OrientationPrimitive, u: number, v: number): number {
  switch (primitive) {
    case "rotate90":
      return u % 2 === 0 ? 1 : -1;
    case "rotate270":
      return v % 2 === 0 ? 1 : -1;
    case "transverse":
      return (u + v) % 2 === 0 ? 1 : -1;
    default:
      return 1; // transpose
  }
}

/**
 * Cuts `crop` out of a coefficient plane.
 *
 * This is the one coefficient-domain operation that changes nothing inside a block: the blocks of the
 * region are copied in order and every coefficient keeps its value. It is therefore exact without any
 * arithmetic - the only thing that can go wrong is the alignment, which `cropGeometry` owns.
 *
 * The result is a compact grid (stride = `widthInBlocks`), so the caller encodes it like any other
 * plane; the source is left untouched.
 */
export function cropPlane(source: CoefficientPlane, crop: ComponentCrop): CoefficientPlane {
  const { blocks, widthInBlocks: width, heightInBlocks: height } = source;
  const sameGrid =
    crop.blockOffsetX === 0 &&
    crop.blockOffsetY === 0 &&
    crop.widthInBlocks === width &&
    crop.heightInBlocks === height;
  if (sameGrid) return { blocks, widthInBlocks: width, heightInBlocks: height };

  const cropped = new Int16Array(crop.widthInBlocks * crop.heightInBlocks * BLOCK_SIZE);
  for (let row = 0; row < crop.heightInBlocks; row++) {
    const from = ((row + crop.blockOffsetY) * width + crop.blockOffsetX) * BLOCK_SIZE;
    cropped.set(blocks.subarray(from, from + crop.widthInBlocks * BLOCK_SIZE), row * crop.widthInBlocks * BLOCK_SIZE);
  }
  return { blocks: cropped, widthInBlocks: crop.widthInBlocks, heightInBlocks: crop.heightInBlocks };
}
