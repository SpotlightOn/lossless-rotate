/**
 * Frame geometry: component block grids, MCU layout, and the "perfect transform" predicate.
 *
 * The predicate is derived from T.81 4.10.2 and jpegtran's observable behaviour: side-specific
 * transforms need the corresponding dimension to be a whole number of MCUs, and it was verified
 * against jpegtran for 392 combinations of image size, sampling factor and transform; see DESIGN.md.
 */

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
