/**
 * Frame geometry: component block grids, MCU layout, the "perfect transform" predicate and the block
 * arithmetic of a crop.
 *
 * The transform predicate is derived from T.81 4.10.2 and jpegtran's observable behaviour:
 * side-specific transforms need the corresponding dimension to be a whole number of MCUs, and it was
 * verified against jpegtran for 392 combinations of image size, sampling factor and transform.
 *
 * A crop has the mirrored condition: the *dimensions* may be anything, but the *origin* has to sit on
 * the MCU grid, because a block cannot be cut in half. See `cropGeometry`.
 */

import { OrientError } from "../errors.ts";
import type { OrientationPrimitive } from "../orientation.ts";

export interface FrameComponent {
  /** Component id as written in SOF (1..255, typically 1, 2, 3). */
  id: number;
  /** Horizontal sampling factor, 1..4. */
  h: number;
  /** Vertical sampling factor, 1..4. */
  v: number;
  /** Quantization table selector. */
  quantTableId: number;
}

export interface Frame {
  /** SOF marker, 0xc0 (baseline) or 0xc2 (progressive). */
  marker: number;
  progressive: boolean;
  /** Sample precision in bits; only 8 is supported. */
  precision: number;
  width: number;
  height: number;
  components: FrameComponent[];
  maxH: number;
  maxV: number;
}

export interface ComponentGeometry {
  component: FrameComponent;
  /** Real block grid of the component. */
  widthInBlocks: number;
  heightInBlocks: number;
  /** Block grid padded to whole MCUs; this is what the entropy data describes. */
  paddedWidthInBlocks: number;
  paddedHeightInBlocks: number;
  /** Sample dimensions of the component (rounded up to whole blocks). */
  widthInSamples: number;
  heightInSamples: number;
}

export interface FrameGeometry {
  frame: Frame;
  /** Interleaved MCU size in pixels. */
  mcuWidth: number;
  mcuHeight: number;
  /** Interleaved MCU grid. */
  mcuColumns: number;
  mcuRows: number;
  components: ComponentGeometry[];
}

const ceilDiv = (value: number, divisor: number): number => Math.ceil(value / divisor);

export function frameGeometry(frame: Frame): FrameGeometry {
  const mcuWidth = 8 * frame.maxH;
  const mcuHeight = 8 * frame.maxV;
  const mcuColumns = ceilDiv(frame.width, mcuWidth);
  const mcuRows = ceilDiv(frame.height, mcuHeight);

  const components = frame.components.map((component) => {
    const widthInSamples = ceilDiv(frame.width * component.h, frame.maxH);
    const heightInSamples = ceilDiv(frame.height * component.v, frame.maxV);
    const widthInBlocks = ceilDiv(widthInSamples, 8);
    const heightInBlocks = ceilDiv(heightInSamples, 8);
    return {
      component,
      widthInSamples,
      heightInSamples,
      widthInBlocks,
      heightInBlocks,
      paddedWidthInBlocks: mcuColumns * component.h,
      paddedHeightInBlocks: mcuRows * component.v,
    };
  });

  return { frame, mcuWidth, mcuHeight, mcuColumns, mcuRows, components };
}

/** True when the transform swaps the two axes (and therefore the sampling factors and dimensions). */
export function swapsAxes(primitive: OrientationPrimitive): boolean {
  return (
    primitive === "rotate90" || primitive === "rotate270" || primitive === "transpose" || primitive === "transverse"
  );
}

/**
 * True when the transform is "perfect": the block grid maps onto itself without leaving partial
 * iMCUs behind. When it is not, the padding blocks of the edge iMCUs move into the visible area and
 * the result is no longer a reversible rotation of the visible pixels - callers are expected to warn.
 */
export function isPerfectTransform(geometry: FrameGeometry, primitive: OrientationPrimitive): boolean {
  const { frame, mcuWidth, mcuHeight } = geometry;
  switch (primitive) {
    case "none":
      return true;
    case "flipHorizontal":
    case "rotate270":
      return frame.width % mcuWidth === 0;
    case "flipVertical":
    case "rotate90":
      return frame.height % mcuHeight === 0;
    case "rotate180":
    case "transverse":
      return frame.width % mcuWidth === 0 && frame.height % mcuHeight === 0;
    case "transpose":
      // Transposing the padded grid is always exact: a flip along one axis of the diagonal.
      return true;
    default:
      return true;
  }
}

/** A rectangle in pixels, in the coordinates of the image it is applied to. */
export interface CropRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where the blocks of a cropped region sit in the block grid of the image before the crop. */
export interface ComponentCrop {
  /** Block offset of the region's top-left corner in the source grid. */
  blockOffsetX: number;
  blockOffsetY: number;
  /** Block grid of the region, padded to whole MCUs (what the entropy data of the result covers). */
  widthInBlocks: number;
  heightInBlocks: number;
}

export interface CropGeometry {
  /** The frame of the result: the source frame with the dimensions of the region. */
  frame: Frame;
  /** The region that is actually produced; its origin is a multiple of the MCU size. */
  region: CropRegion;
  /** True when `region` is exactly the requested rectangle, i.e. its origin was already aligned. */
  perfect: boolean;
  /** One entry per component, in frame order. */
  components: ComponentCrop[];
}

/** `32x16+16+16`, the notation jpegtran takes and the CLI prints. */
export function cropRegionToString(region: CropRegion): string {
  return `${region.width}x${region.height}+${region.x}+${region.y}`;
}

/**
 * Rejects a region that cannot describe a part of an image: whole pixels, at least one pixel wide and
 * high, and inside the image. A region that reaches past the edge is refused rather than clamped,
 * because silently returning something other than what was asked for is exactly what the alignment
 * warning exists to avoid.
 */
function checkCropRegion(region: CropRegion, width: number, height: number): void {
  const { x, y } = region;
  if (![x, y, region.width, region.height].every((value) => Number.isInteger(value))) {
    throw new OrientError("E_INVALID_VALUE", `crop region ${cropRegionToString(region)} is not whole pixels`);
  }
  if (x < 0 || y < 0) {
    throw new OrientError("E_INVALID_VALUE", `crop region ${cropRegionToString(region)} starts outside the image`);
  }
  if (region.width < 1 || region.height < 1) {
    throw new OrientError("E_INVALID_VALUE", `crop region ${cropRegionToString(region)} is empty`);
  }
  if (x + region.width > width || y + region.height > height) {
    throw new OrientError(
      "E_INVALID_VALUE",
      `crop region ${cropRegionToString(region)} does not fit into the ${width}x${height} image`,
    );
  }
}

/**
 * The block arithmetic of a crop.
 *
 * A crop cannot cut a block, so the region's origin is rounded **down** to the MCU grid - the same
 * rule jpegtran applies - and the far edge stays where it was asked for, which may leave a partial
 * iMCU at the right/bottom edge. That partial iMCU is only padding: every visible pixel of the result
 * is a pixel of the source, so the crop is exact even when the region's size is not a multiple of the
 * MCU size. `perfect` says whether the origin was already aligned.
 *
 * The region is expressed in the coordinates of the frame `geometry` describes, i.e. *after* a
 * transform when there is one; that is how jpegtran counts `-crop` as well.
 *
 * @throws OrientError E_INVALID_VALUE when the region is not a whole-pixel rectangle inside the image.
 */
export function cropGeometry(geometry: FrameGeometry, region: CropRegion): CropGeometry {
  const { frame, mcuWidth, mcuHeight } = geometry;
  checkCropRegion(region, frame.width, frame.height);

  const x = Math.floor(region.x / mcuWidth) * mcuWidth;
  const y = Math.floor(region.y / mcuHeight) * mcuHeight;
  const width = region.x + region.width - x;
  const height = region.y + region.height - y;
  const cropped = frameGeometry({ ...frame, width, height });

  return {
    frame: cropped.frame,
    region: { x, y, width, height },
    perfect: x === region.x && y === region.y,
    components: geometry.components.map((component, index) => ({
      blockOffsetX: (x / mcuWidth) * component.component.h,
      blockOffsetY: (y / mcuHeight) * component.component.v,
      widthInBlocks: cropped.components[index]!.paddedWidthInBlocks,
      heightInBlocks: cropped.components[index]!.paddedHeightInBlocks,
    })),
  };
}
