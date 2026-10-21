/**
 * Entropy decoding: quantized DCT coefficients out of a JPEG's scan data.
 *
 * Baseline sequential and progressive (both first and refinement scans) are supported, because a
 * lossless transform has to work on the coefficients either way. Restart intervals are honoured.
 *
 * The coefficient grid kept per component is the *padded* grid (whole MCUs). That is what the
 * entropy data of an interleaved scan describes, and it is the grid that makes every transform
 * well defined even when the image is not MCU aligned - in that case the padding blocks are part of
 * the result, which is why the caller has to warn (see geometry.ts).
 */

import { OrientError } from "../errors.ts";
import { type FrameComponent, frameGeometry } from "./geometry.ts";
import { BitReader, buildHuffmanDecoder, decodeHuffmanSymbol, type HuffmanDecoder } from "./huffman.ts";
import { huffmanKey, type ParsedJpeg, type Scan } from "./parse.ts";
import { ZIGZAG_TO_NATURAL } from "./tables.ts";

export interface ComponentCoefficients {
  component: FrameComponent;
  /** Padded block grid, row major; 64 natural-order coefficients per block. */
  blocks: Int16Array;
  /** Array stride, i.e. the padded block width. */
  strideInBlocks: number;
  /** Real block grid (what a non-interleaved scan covers). */
  widthInBlocks: number;
  heightInBlocks: number;
  /** Block grid padded to whole MCUs (what an interleaved scan covers). */
  paddedWidthInBlocks: number;
  paddedHeightInBlocks: number;
  /** Number of blocks per MCU in each direction (= the sampling factors). */
  blocksPerMcuX: number;
  blocksPerMcuY: number;
}

const BLOCK_SIZE = 64;

function fail(message: string): never {
  throw new OrientError("E_INVALID_JPEG", message);
}

interface ScanState {
  dcPredictors: Int32Array;
  eobRun: number;
}

/** Decodes one baseline (sequential) block. */
function decodeBaselineBlock(
  reader: BitReader,
  dc: HuffmanDecoder,
  ac: HuffmanDecoder,
  block: Int16Array,
  base: number,
  predictor: number,
): number {
  const dcCategory = decodeHuffmanSymbol(reader, dc);
  if (dcCategory > 11) fail(`invalid JPEG data: DC category ${dcCategory}`);
  predictor += reader.receiveExtend(dcCategory);
  block[base] = predictor;

  let k = 1;
  while (k < BLOCK_SIZE) {
    const symbol = decodeHuffmanSymbol(reader, ac);
    const size = symbol & 15;
    const run = symbol >> 4;
    if (size === 0) {
      if (run !== 15) break; // end of block
      k += 16; // ZRL: sixteen zero coefficients
      continue;
    }
    k += run;
    if (k >= BLOCK_SIZE) fail("invalid JPEG data: AC coefficient index out of range");
    block[base + ZIGZAG_TO_NATURAL[k]!] = reader.receiveExtend(size);
    k++;
  }
  return predictor;
}

/** Decodes the DC coefficient of a progressive DC scan. */
function decodeProgressiveDcFirst(
  reader: BitReader,
  dc: HuffmanDecoder,
  block: Int16Array,
  base: number,
  predictor: number,
  al: number,
): number {
  const category = decodeHuffmanSymbol(reader, dc);
  if (category > 11) fail(`invalid JPEG data: DC category ${category}`);
  predictor += reader.receiveExtend(category);
  block[base] = predictor << al;
  return predictor;
}

/**
 * Applies one successive-approximation correction bit to an already non-zero coefficient.
 *
 * T.81 G.1.2.4: a 1 bit increases the magnitude by 2^Al, i.e. it adds +2^Al to positive and -2^Al
 * to negative coefficients. A coefficient that already carries the bit (it was set by a previous
 * scan at this level) is left alone.
 */
function refineCoefficient(reader: BitReader, block: Int16Array, index: number, p1: number, m1: number): void {
  const value = block[index]!;
  if (value === 0 || (value & p1) !== 0) return;
  if (reader.getBit()) block[index] = value + (value >= 0 ? p1 : m1);
}

/**
 * Decodes an AC band of a progressive first scan (Ss..Se, Ah = 0).
 *
 * T.81 G.1.2.2. The EOB run length decoded from an EOBn symbol is `2^n + <n extra bits>` and counts
 * the current block as well, so `state.eobRun` keeps only the number of *following* blocks and the
 * check at the top of the next block consumes one.
 */
function decodeProgressiveAcFirst(
  reader: BitReader,
  ac: HuffmanDecoder,
  block: Int16Array,
  base: number,
  scan: Scan,
  state: ScanState,
): void {
  if (state.eobRun > 0) {
    state.eobRun--;
    return;
  }
  let k = scan.ss;
  while (k <= scan.se) {
    const symbol = decodeHuffmanSymbol(reader, ac);
    const size = symbol & 15;
    const run = symbol >> 4;
    if (size === 0) {
      if (run !== 15) {
        // EOBn: `2^run + <run extra bits>` blocks are zero from here on, current block included.
        state.eobRun = (1 << run) - 1;
        if (run > 0) state.eobRun += reader.receive(run);
        break;
      }
      k += 16; // ZRL: sixteen zero coefficients
      continue;
    }
    k += run;
    if (k > scan.se) fail("invalid JPEG data: AC coefficient index out of range");
    block[base + ZIGZAG_TO_NATURAL[k]!] = reader.receiveExtend(size) << scan.al;
    k++;
  }
}

/**
 * Refines one block of a progressive AC refinement scan (Ss..Se, Ah > 0).
 *
 * T.81 G.1.2.4. The block already holds the band from the previous scan; this scan (a) appends one
 * correction bit to each already non-zero coefficient and (b) decodes new, still-zero coefficients.
 * An EOB run has the same length semantics as in the first scan, but every block it covers still
 * receives its correction bits - that is what makes the run a usable shortcut at all.
 */
function decodeProgressiveAcRefine(
  reader: BitReader,
  ac: HuffmanDecoder,
  block: Int16Array,
  base: number,
  scan: Scan,
  state: ScanState,
): void {
  const p1 = 1 << scan.al;
  const m1 = -1 << scan.al;
  const inRun = state.eobRun > 0;
  let k = scan.ss;

  if (inRun) {
    state.eobRun--;
  } else {
    while (k <= scan.se) {
      const symbol = decodeHuffmanSymbol(reader, ac);
      const run = symbol >> 4;
      let size = symbol & 15;

      if (size === 0) {
        if (run !== 15) {
          // EOBn: see decodeProgressiveAcFirst. The current block still gets its correction bits.
          state.eobRun = (1 << run) - 1;
          if (run > 0) state.eobRun += reader.receive(run);
          break;
        }
        // ZRL: skip sixteen zero coefficients, refining the non-zero ones on the way.
        let zeros = 16;
        while (zeros > 0 && k <= scan.se) {
          const index = base + ZIGZAG_TO_NATURAL[k]!;
          if (block[index] !== 0) refineCoefficient(reader, block, index, p1, m1);
          else zeros--;
          k++;
        }
        continue;
      }

      if (size !== 1) fail(`invalid JPEG data: AC refinement size ${size}`);
      size = reader.getBit() ? p1 : m1;

      // Advance over `run` still-zero coefficients, refining every already non-zero one.
      let remaining = run;
      while (k <= scan.se) {
        const index = base + ZIGZAG_TO_NATURAL[k]!;
        if (block[index] !== 0) refineCoefficient(reader, block, index, p1, m1);
        else {
          if (remaining === 0) break;
          remaining--;
        }
        k++;
      }
      if (k > scan.se) fail("invalid JPEG data: AC refinement index out of range");
      block[base + ZIGZAG_TO_NATURAL[k]!] = size;
      k++;
    }
  }

  // Correction bits for the rest of this block: either the tail after the last decoded coefficient,
  // or the whole band when the block is itself covered by an EOB run.
  for (; k <= scan.se; k++) refineCoefficient(reader, block, base + ZIGZAG_TO_NATURAL[k]!, p1, m1);
}

/** Refines the DC coefficient of a progressive refinement scan. */
function decodeProgressiveDcRefine(reader: BitReader, block: Int16Array, base: number, al: number): void {
  if (reader.getBit()) block[base] = block[base]! | (1 << al);
}

/**
 * Decodes all scans of a parsed JPEG into per-component coefficient grids.
 *
 * @throws OrientError E_INVALID_JPEG / E_UNSUPPORTED.
 */
export function decodeCoefficients(parsed: ParsedJpeg): ComponentCoefficients[] {
  const geometry = frameGeometry(parsed.frame);
  const { frame } = geometry;

  const coefficients: ComponentCoefficients[] = geometry.components.map((componentGeometry) => ({
    component: componentGeometry.component,
    strideInBlocks: componentGeometry.paddedWidthInBlocks,
    widthInBlocks: componentGeometry.widthInBlocks,
    heightInBlocks: componentGeometry.heightInBlocks,
    paddedWidthInBlocks: componentGeometry.paddedWidthInBlocks,
    paddedHeightInBlocks: componentGeometry.paddedHeightInBlocks,
    blocksPerMcuX: componentGeometry.component.h,
    blocksPerMcuY: componentGeometry.component.v,
    blocks: new Int16Array(componentGeometry.paddedWidthInBlocks * componentGeometry.paddedHeightInBlocks * BLOCK_SIZE),
  }));

  const byId = new Map<number, ComponentCoefficients>();
  for (const component of coefficients) byId.set(component.component.id, component);

  for (const scan of parsed.scans) {
    // A scan only needs the tables it actually uses: a progressive DC scan (Ss = Se = 0) has no AC
    // coefficients, and files often do not define an AC table before it.
    const needsDc = scan.ss === 0;
    const needsAc = scan.se > 0;
    const scanComponents = scan.components.map((scanComponent) => {
      const target = byId.get(scanComponent.id);
      if (target === undefined) fail(`invalid JPEG: scan references unknown component ${scanComponent.id}`);
      const dcTable = scan.huffmanTables.get(huffmanKey(0, scanComponent.dcTableId));
      if (needsDc && dcTable === undefined)
        fail(`invalid JPEG: scan uses undefined DC Huffman table ${scanComponent.dcTableId}`);
      const acTable = scan.huffmanTables.get(huffmanKey(1, scanComponent.acTableId));
      if (needsAc && acTable === undefined)
        fail(`invalid JPEG: scan uses undefined AC Huffman table ${scanComponent.acTableId}`);
      return {
        target,
        dc: dcTable === undefined ? undefined : buildHuffmanDecoder(dcTable),
        ac: acTable === undefined ? undefined : buildHuffmanDecoder(acTable),
      };
    });

    const reader = new BitReader(parsed.bytes, scan.dataStart, scan.dataEnd);
    const state: ScanState = { dcPredictors: new Int32Array(scanComponents.length), eobRun: 0 };
    const interleaved = scanComponents.length > 1;

    if (!frame.progressive && (scan.ss !== 0 || scan.se !== 63 || scan.ah !== 0 || scan.al !== 0)) {
      fail("invalid JPEG: baseline scan has unexpected spectral selection or successive approximation");
    }

    const mcuColumns = interleaved ? geometry.mcuColumns : scanComponents[0]!.target.widthInBlocks;
    const mcuRows = interleaved ? geometry.mcuRows : scanComponents[0]!.target.heightInBlocks;
    // A non-interleaved scan covers only the real block grid; the padding blocks stay zero.
    const restartInterval = parsed.restartInterval;

    let restartCounter = 0;
    let restartIndex = 0;
    for (let mcuRow = 0; mcuRow < mcuRows; mcuRow++) {
      for (let mcuColumn = 0; mcuColumn < mcuColumns; mcuColumn++) {
        if (restartInterval > 0 && restartCounter === restartInterval) {
          if (!reader.readRestart(restartIndex % 8)) {
            // The marker was unexpected: re-align and continue, as a lenient decoder does.
            reader.alignToByte();
          }
          restartIndex++;
          restartCounter = 0;
          state.dcPredictors.fill(0);
          state.eobRun = 0;
        }
        restartCounter++;

        for (let scanComponentIndex = 0; scanComponentIndex < scanComponents.length; scanComponentIndex++) {
          const { target, dc, ac } = scanComponents[scanComponentIndex]!;
          const blocksX = interleaved ? target.blocksPerMcuX : 1;
          const blocksY = interleaved ? target.blocksPerMcuY : 1;
          for (let y = 0; y < blocksY; y++) {
            for (let x = 0; x < blocksX; x++) {
              const blockRow = interleaved ? mcuRow * target.blocksPerMcuY + y : mcuRow;
              const blockColumn = interleaved ? mcuColumn * target.blocksPerMcuX + x : mcuColumn;
              const base = (blockRow * target.strideInBlocks + blockColumn) * BLOCK_SIZE;
              const block = target.blocks;

              if (frame.progressive) {
                if (scan.ss === 0 && scan.se === 0) {
                  if (scan.ah === 0) {
                    state.dcPredictors[scanComponentIndex] = decodeProgressiveDcFirst(
                      reader,
                      dc!,
                      block,
                      base,
                      state.dcPredictors[scanComponentIndex]!,
                      scan.al,
                    );
                  } else {
                    decodeProgressiveDcRefine(reader, block, base, scan.al);
                  }
                } else if (scan.ah === 0) {
                  decodeProgressiveAcFirst(reader, ac!, block, base, scan, state);
                } else {
                  decodeProgressiveAcRefine(reader, ac!, block, base, scan, state);
                }
              } else {
                state.dcPredictors[scanComponentIndex] = decodeBaselineBlock(
                  reader,
                  dc!,
                  ac!,
                  block,
                  base,
                  state.dcPredictors[scanComponentIndex]!,
                );
              }
            }
          }
        }
      }
    }
  }

  return coefficients;
}
