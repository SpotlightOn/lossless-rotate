/**
 * Baseline sequential encoding of coefficient grids.
 *
 * The output always uses the standard Annex K Huffman tables and the source's quantization tables,
 * and it never emits restart markers (dropping the restart interval is always legal and keeps the
 * output simple). Progressive input therefore comes out as a sequential file, which is still
 * lossless.
 *
 * The encoded grid is the padded one (whole MCUs). When the caller says which part of it is visible -
 * as a crop does, because its far edge can fall inside an iMCU - the blocks outside are encoded blank
 * instead of with the coefficients they happen to hold; see `EncodableComponent.visibleSizeInBlocks`.
 */

import type { FrameComponent } from "./geometry.ts";
import { BitWriter, buildHuffmanEncoder, type HuffmanEncoder } from "./huffman.ts";
import { magnitudeCategory, STANDARD_AC_TABLES, STANDARD_DC_TABLES, ZIGZAG_TO_NATURAL } from "./tables.ts";

const BLOCK_SIZE = 64;

export interface EncodableComponent {
  component: FrameComponent;
  /** Row-major block grid, 64 natural-order coefficients per block. */
  blocks: Int16Array;
  /** Array stride, i.e. the block width of the grid that is encoded. */
  strideInBlocks: number;
  /** Grid dimensions that are encoded (whole MCUs for an interleaved scan). */
  widthInBlocks: number;
  heightInBlocks: number;
  blocksPerMcuX: number;
  blocksPerMcuY: number;
  /**
   * The real block grid of the image, when it is smaller than the padded grid that is encoded.
   *
   * Blocks outside it are padding of a partial edge iMCU and are encoded blank - no AC coefficients,
   * and a DC difference of zero, so they decode to the previous block's DC. That is exactly what
   * libjpeg-turbo does when it crops, and it keeps the part of the source that was cropped away from
   * travelling along inside the file. A transform leaves this unset and keeps the source's padding,
   * which is also what jpegtran does there.
   */
  visibleSizeInBlocks?: { width: number; height: number };
}

/** Encodes one block; returns the DC value so the caller can carry the predictor forward. */
function encodeBlock(
  writer: BitWriter,
  dcTable: HuffmanEncoder,
  acTable: HuffmanEncoder,
  block: Int16Array,
  base: number,
  predictor: number,
  blank: boolean,
): number {
  if (blank) {
    // A padding block of the edge iMCU that cropping cut out of the image: DC difference 0 and EOB.
    writer.putBits(dcTable.code[0]!, dcTable.size[0]!);
    writer.putBits(acTable.code[0x00]!, acTable.size[0x00]!);
    return predictor;
  }

  const dc = block[base]!;
  const difference = dc - predictor;
  const category = magnitudeCategory(difference);
  writer.putBits(dcTable.code[category]!, dcTable.size[category]!);
  if (category > 0) {
    writer.putBits(difference >= 0 ? difference : difference - 1 + (1 << category), category);
  }

  let run = 0;
  for (let k = 1; k < BLOCK_SIZE; k++) {
    const value = block[base + ZIGZAG_TO_NATURAL[k]!]!;
    if (value === 0) {
      run++;
      continue;
    }
    while (run > 15) {
      writer.putBits(acTable.code[0xf0]!, acTable.size[0xf0]!); // ZRL
      run -= 16;
    }
    const size = magnitudeCategory(value);
    const symbol = (run << 4) | size;
    writer.putBits(acTable.code[symbol]!, acTable.size[symbol]!);
    writer.putBits(value >= 0 ? value : value - 1 + (1 << size), size);
    run = 0;
  }
  if (run > 0) {
    writer.putBits(acTable.code[0x00]!, acTable.size[0x00]!); // EOB
  }
  return dc;
}

/**
 * Encodes the entropy data of one sequential scan.
 *
 * A single component frame is written as one non-interleaved scan over its own grid (the standard
 * shape for grayscale); anything else is written as one interleaved scan over whole MCUs.
 */
export function encodeScan(
  components: EncodableComponent[],
  layout: { singleComponent: boolean; mcuColumns: number; mcuRows: number },
): Buffer {
  const writer = new BitWriter();
  const dcTables = STANDARD_DC_TABLES.map(buildHuffmanEncoder);
  const acTables = STANDARD_AC_TABLES.map(buildHuffmanEncoder);
  // Component 0 uses the luminance tables, the chrominance components use the chrominance ones.
  const tableIndex = (componentIndex: number): number => (componentIndex === 0 ? 0 : 1);
  const predictors = new Int32Array(components.length);

  if (layout.singleComponent) {
    const target = components[0]!;
    for (let row = 0; row < target.heightInBlocks; row++) {
      for (let column = 0; column < target.widthInBlocks; column++) {
        const base = (row * target.strideInBlocks + column) * BLOCK_SIZE;
        const blank = isPadding(target, column, row);
        predictors[0] = encodeBlock(writer, dcTables[0]!, acTables[0]!, target.blocks, base, predictors[0]!, blank);
      }
    }
    writer.flush();
    return writer.toBuffer();
  }

  for (let mcuRow = 0; mcuRow < layout.mcuRows; mcuRow++) {
    for (let mcuColumn = 0; mcuColumn < layout.mcuColumns; mcuColumn++) {
      for (let componentIndex = 0; componentIndex < components.length; componentIndex++) {
        const target = components[componentIndex]!;
        const index = tableIndex(componentIndex);
        for (let y = 0; y < target.blocksPerMcuY; y++) {
          for (let x = 0; x < target.blocksPerMcuX; x++) {
            const row = mcuRow * target.blocksPerMcuY + y;
            const column = mcuColumn * target.blocksPerMcuX + x;
            const base = (row * target.strideInBlocks + column) * BLOCK_SIZE;
            const blank = isPadding(target, column, row);
            predictors[componentIndex] = encodeBlock(
              writer,
              dcTables[index]!,
              acTables[index]!,
              target.blocks,
              base,
              predictors[componentIndex]!,
              blank,
            );
          }
        }
      }
    }
  }

  writer.flush();
  return writer.toBuffer();
}

/** True when the block at (column, row) lies outside the visible image. */
function isPadding(target: EncodableComponent, column: number, row: number): boolean {
  const visible = target.visibleSizeInBlocks;
  return visible !== undefined && (column >= visible.width || row >= visible.height);
}
