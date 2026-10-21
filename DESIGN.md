# Design of `@spotlighton/lossless-rotate`

`lossless-rotate` makes JPEG images upright without re-encoding them. It reads and writes the Exif
orientation tag and rotates the image by rearranging quantized DCT coefficients — no IDCT, no
requantization, no native code. This document explains how it works and how the claims about it were
verified.

It replaces `jpegorientation` v1, a small package whose rotation shelled out to GraphicsMagick (and
therefore re-encoded the image) and whose orientation helper was a native addon. The package here is a
from-scratch pure JavaScript/TypeScript implementation with no runtime dependencies.

---

## 1. Goals and constraints

Decisions taken with the maintainer:

* rotation must be **lossless**;
* **no native code**: no C/C++ addon, no `sharp`, no prebuilt binary, no compiler step;
* **TypeScript**, shipped as source and executed through Node's native type stripping (no build);
* **zero runtime dependencies**;
* **orientation handling stays at the metadata/Exif level** — for formats without a coefficient-domain
  rotation (AVIF) the properties are changed, the pixels are not;
* images whose dimensions are not MCU-aligned are transformed anyway with a warning (like `jpegtran`),
  with an opt-in error;
* the JPEG standard (ITU-T T.81), the ISO base media file format and the Exif specification are
  the reference, not another library's source. `jpegtran`/`djpeg`/`avifenc`/`avifdec` are used only as
  black-box oracles in the tests.

Runtime floor: **Node.js ≥ 24** (follows from shipping `.ts`).

---

## 2. Why this is possible without native code

A lossless rotation does not touch pixels; it rearranges the **quantized DCT coefficients** that a
JPEG file stores. Those are integers, and the transforms are exact integer operations:

* 90°/270° and the diagonal mirrors transpose each 8×8 block of coefficients;
* the mirrors and 180° flip the sign of individual coefficients according to a parity rule;
* the block grid itself is reordered, and for axis-swapping transforms the sampling factors and the
  image dimensions are swapped.

Decoding the entropy-coded bit stream and re-encoding it is the only real work, and both are a few
hundred lines of well-specified bit manipulation (T.81 Annex B/C/F). That is the whole reason this
package exists without any native dependency. A re-encode through a pixel codec (as v1 did via
GraphicsMagick) is *not* lossless, which is what this package fixes.

The alternative of delegating to a WASM `jpegtran` was researched and rejected (see §7).

---

## 3. Architecture

```
src/index.ts             public API: orientation(), autoRotate(), ... and the re-exports
src/autoRotate.ts        high level orchestration: orientation -> transform -> codec -> write
src/orientation.ts       the orientation(1..8) -> transform table, as pure data
src/exif.ts              locate / read / patch / insert the Exif orientation entry (TIFF level),
                         plus the embedded thumbnail layer (locate/replace, offset fixup)
src/file.ts              format dispatch, read and write on a path
src/markers.ts           JPEG marker walker
src/errors.ts            OrientError with stable codes
src/avif/container.ts    ISOBMFF box walker and builder
src/avif/item.ts         the item structure: meta/iprp/ipco/ipma/iloc, ipma parsing, meta rebuild
src/avif/orientation.ts  the irot/imir properties of the primary item
src/jpeg/parse.ts        JPEG structure: SOF/DHT/DQT/DRI/SOS and per-scan table snapshots
src/jpeg/huffman.ts      canonical Huffman decoding/encoding and the entropy bit streams
src/jpeg/decoder.ts      baseline and progressive entropy decoding -> coefficient grids
src/jpeg/geometry.ts     component block grids, MCU layout, "perfect transform" predicate
src/jpeg/transform.ts    the seven coefficient-domain primitives
src/jpeg/encoder.ts      baseline sequential entropy encoding
src/jpeg/tables.ts       standard Annex K Huffman tables and the zig-zag order
src/jpeg/codec.ts        parse -> decode -> transform -> encode, plus metadata handling
```

Everything below `src/` is pure and synchronous; `src/file.ts`, `src/autoRotate.ts` and
`orientation()` in `src/index.ts` add the asynchronous file handling. `Uint8Array` in, `Buffer` out:
the codec never touches a disk, which is what makes it trivially testable and usable on in-memory
buffers.

### Public API

* `orientation(source, [value], [callback])` — read, or set (metadata only), v1-compatible.
* `autoRotate(source, [destination], [options])`, `autoRotateBuffer(bytes, [options])` — make upright.
* `setOrientation`, `canTransform`, `readOrientation`, `patchOrientation`, `insertOrientation`,
  `buildExifApp1`, `orientationToString`.
* `readOrientationInExifBlock`, `patchOrientationInExifBlock`, `buildExifTiff` — the TIFF level, shared
  by the JPEG container and any caller holding a bare TIFF block.
* `transformFor`, `transformForRotation`, `composeTransforms`, `isIdentity` — the orientation table:
  what a tag asks for, what a quarter turn is, and what two transforms in a row come to (one pass).
* `locateExifThumbnail`, `replaceExifThumbnail` — the embedded Exif thumbnail (`0x0201`/`0x0202`) and
  the offset fixup that replacing it requires.
* `isAvif`, `avifLayout`, `avifImageSize`, `avifPropertyTypes`, `readAvifOrientation`,
  `writeAvifOrientation`, `setAvifOrientation` — the AVIF metadata layer (also reachable as
  `@spotlighton/lossless-rotate/avif`).
* `transformJpeg`, `parseJpeg`, `decodeCoefficients`, `frameGeometry`, `isPerfectTransform` — the
  layers below.

---

## 4. The coefficient transform

Block-grid mapping, with source dimensions `W × H` blocks and destination `(c, r) = (column, row)`:

| primitive | block mapping | per-block coefficients |
| --- | --- | --- |
| `flipHorizontal` | `dest(c,r) <- src(W-1-c, r)` | `(-1)^u · S(u,v)` |
| `flipVertical` | `dest(c,r) <- src(c, H-1-r)` | `(-1)^v · S(u,v)` |
| `rotate180` | `dest(c,r) <- src(W-1-c, H-1-r)` | `(-1)^(u+v) · S(u,v)` |
| `rotate90` | `dest(c,r) <- src(r, H-1-c)` | `(-1)^u · S(v,u)` |
| `rotate270` | `dest(c,r) <- src(W-1-r, c)` | `(-1)^v · S(v,u)` |
| `transpose` | `dest(c,r) <- src(r, c)` | `S(v,u)` |
| `transverse` | `dest(c,r) <- src(W-1-r, H-1-c)` | `(-1)^(u+v) · S(v,u)` |

The four axis-swapping primitives also swap the sampling factors and the image dimensions.

Two consequences that a naive implementation gets wrong:

* **The quantization tables transpose too.** For an axis-swapping transform the coefficients are
  transposed, so the quantization table has to follow (`Q'(u,v) = Q(v,u)`); otherwise the dequantized
  image is subtly wrong. `codec.ts` transposes the DQT it writes.
* **The transform runs on the padded (whole-MCU) block grid.** That grid is what the entropy data
  describes, and using it keeps every transform well defined even for images whose real block grid is
  smaller than a whole number of MCUs. Padding blocks becoming visible is exactly the "imperfect"
  case of §5.

The rules were derived from the DCT definition and verified numerically: applying the rule to a block
and comparing with a forward DCT of the literally rotated block gives an error of 0.0000 across all
primitives (`/tmp/opencode/oracle` development scripts; the invariant is also covered by
`test/jpeg/transform.test.ts`).

`src/orientation.ts` maps the eight Exif orientation values to these primitives:

| value | meaning | primitive |
| --- | --- | --- |
| 1 | normal | `none` |
| 2 | mirror horizontal | `flipHorizontal` |
| 3 | 180° | `rotate180` |
| 4 | mirror vertical | `flipVertical` |
| 5 | transpose | `transpose` |
| 6 | rotate 90° CW | `rotate90` |
| 7 | transverse | `transverse` |
| 8 | rotate 270° CW | `rotate270` |

---

## 5. When a transform is *perfect*, and what happens when it is not

`jpeg` geometry is made of whole MCUs. A coefficient transform only lines up with the visible image
when the image dimensions are a whole number of **MCUs** along the axes the transform touches:

| transform | perfect when |
| --- | --- |
| `flipHorizontal`, `rotate270` | `width % (8·maxH) === 0` |
| `flipVertical`, `rotate90` | `height % (8·maxV) === 0` |
| `rotate180`, `transverse` | both |
| `transpose` (and `none`) | always |

`isPerfectTransform()` implements this. For anything else the partial edge MCU's padding moves into
the visible area; the result is still a valid lossless transform of the *padded* image, but it is not
a faithful rotation of the visible pixels. Like `jpegtran`, the package performs the transform anyway
and reports it in `result.warnings` (`onImperfect: "warn"`, the default); `onImperfect: "error"`
refuses with `E_UNSUPPORTED` instead. The warning is part of the return value, never a console
message, because a caller has to be able to react to it.

---

## 6. The codec

**Parse** (`parse.ts`). A hand-written marker walker collects DQT, DHT, DRI, SOF and every SOS, and
carries APPn/COM segments through unchanged. Two details matter for real files:

* the scan loop skips the entropy-coded data of each scan to find the next marker, because a
  progressive file has many scans;
* **Huffman and quantization tables are snapshotted per scan.** A progressive file may redefine a
  table between scans, and the definition in effect is the last one *before* the scan, not the last in
  the file. (This was a real bug: the progressive fixture redefines table `1-0` four times, and using
  the final definition desynchronised the decoder.)

**Decode** (`decoder.ts`). Baseline sequential and progressive are both supported. Progressive
decoding implements the first and the refinement DC/AC scans, EOB runs, ZRL, and successive
approximation, following T.81 Annex G. A scan only requires the tables it uses — a progressive DC scan
has no AC coefficients and often has no AC table defined yet. Restart intervals are honoured.

**Transform** (`transform.ts`). The block grid of each component is reordered as in §4, on the padded
grid; axis-swapping transforms swap the sampling factors.

**Encode** (`encoder.ts`, `codec.ts`). The result is always a **baseline sequential** JPEG that keeps
the source's quantization tables (transposed when the axes swapped) and writes the standard Annex K
Huffman tables. Restart markers are dropped, which is always legal. Progressive input is therefore
written out sequential and reported with a warning; progressive *output* is out of scope.

Metadata: the source's APPn/COM segments are carried over (droppable with `keepMetadata: false`), and
if there is an Exif APP1 segment its orientation tag is set to `orientationInOutput` (default 1).

**Already upright.** Orientation `0` (no tag) or `1` is a byte-exact copy — never re-encoded. This is
a deliberate difference from v1, which re-encoded everything through GraphicsMagick.

---

## 7. Why not a WASM/binary codec

Checked against the registry (as of 2026-10) and, where it mattered, by unpacking the package:

| Option | Lossless | No C / no compiler | Verdict |
| --- | --- | --- | --- |
| Own TS coefficient transform (this package) | yes | yes | **chosen** — the only fully dependency-free lossless answer |
| `jpegtran-bin` (imagemin) | yes | no: prebuilt native binary downloaded at install | rejected as a dependency; used as a test oracle |
| port of jpegturbo to WASI | yes | no: needs an external `wasmtime` ≥ 47 (WASI 0.3); `node:wasi` cannot run it | rejected |
| `@cornerstonejs/codec-libjpeg-turbo-8bit` (WASM) | no | yes | rejected: decode/encode only, no transform entry point |
| `@jsquash/jpeg` / `jpeg-js` | no (decode + re-encode) | yes | not lossless; would only serve a future re-encode fallback |
| `sharp` / `@julusian/jpeg-turbo` | yes | prebuilt native | rejected by decision |

So there is no npm package that performs a lossless coefficient-domain JPEG transform without native
code, and the pure-JS ones all re-encode. The two viable options were "own implementation" or "ship a
native binary"; the decision was the own implementation.

---

## 8. Verification

The claim "lossless" is only meaningful with evidence. Seven independent layers of it:

The suites are grouped by format: `test/core/` holds the format-agnostic parts (the orientation table
and the public API contract) plus the shared fixture and CLI helpers, `test/jpeg/` and `test/avif/` hold
the format-specific suites, and `test/fixtures/` is the shared corpus that both read.


1. **Coefficient round trip** (`test/jpeg/roundtrip.test.ts`). Decoding and re-encoding every base
   image without a transform preserves every coefficient and the geometry.

2. **Analytic transform checks** (`test/jpeg/transform.test.ts`). Every primitive is checked
   coefficient by coefficient against the rules of §4, the result geometry is checked, and the
   quantization-table transposition is verified exactly for the axis-swapping transforms. This test
   needs no external tool.

3. **Differential test against the reference implementation**
   (`test/jpeg/differential.test.ts`, skipped when `jpegtran`/`djpeg` are absent):
   * for every **perfect** transform, the decoded result is **byte-identical** to `jpegtran`'s output —
     the strongest available statement, against a completely independent implementation;
   * for **imperfect** transforms the geometry matches `jpegtran`'s and a warning is emitted;
   * the decoded pixels match a *literal pixel rotation* of the source with at most ±3 LSB, which is a
     decoder's IDCT rounding (the same deviation `jpegtran` shows), not a transform error;
   * **a progressive file decodes to the same coefficients as `jpegtran`'s sequential transcode**,
     which pins the progressive decoder exactly (and would have caught the table-redefinition bug).

4. **The fixture corpus is verified** (`scripts/make-fixtures.mjs` + `manifest.json`). The generator
   checks each base image's real frame (dimensions, sampling factors, progressive flag) and records it;
   the orientation fixtures are written from explicit byte arrays, so the tests never compare the
   implementation with itself. `test/jpeg/exif.test.ts` and `test/jpeg/file.test.ts` assert, among other things,
   that patching rewrites *exactly* the ten bytes of the IFD entry and nothing else.

5. **AVIF metadata is verified three ways** (`test/avif/orientation.test.ts`). The hand-built fixtures
   describe the property list, the primary item and the `iloc` extent, and a file the writer produces
   has to equal the hand-built one byte for byte for all eight orientations. On top of that, `avifenc`
   is driven as an independent writer (`--irot`/`--imir`): the reader must read back what libavif wrote,
   and the writer must reproduce libavif's output byte for byte. Finally `avifdec` must decode a written
   file to the literal pixel rotation of the original (checked against ImageMagick's `-rotate`). The
   external tests skip themselves when the tool is missing, like the JPEG differential tests.

6. **The thumbnail fixup is verified against an independent reader** (`test/jpeg/thumbnail.test.ts`). The
   test carries its own TIFF/IFD walker (it follows the offsets itself to resolve `Make`, the thumbnail
   bounds and the orientation), so the offset fixup is never compared with the code that performs it.
   The corpus covers the layout combinations that matter, and the tests assert the two invariants that
   define "only the thumbnail changed": the main image's coefficients are identical with and without
   the option, and the file grew by exactly the change in thumbnail length.

The CLI is covered separately — `test/jpeg/cli.test.ts` for JPEG, `test/avif/cli.test.ts` for AVIF — by
running the real executable: it asserts that the default output lands in `tmp/` and that the input file
is byte-for-byte unchanged.

The one design decision the CLI needed from the library is `--rotate <deg>`. "Rotate by N degrees" is
not what `rotate` does — it makes the image upright from the tag — so the explicit angle is *counted
from the way the image is displayed*: the stored tag is applied first and cleared afterwards. That
makes two transforms in a row, which is why `composeTransforms` exists: the composed result is one
primitive, so the CLI performs a single lossless pass (rotating twice would move the partial edge
blocks twice and warn twice). When the tag and the angle cancel out, the file is copied rather than
re-encoded; when the source carries no tag, no tag is invented for it.

Measured constraints that shaped the design (libjpeg-turbo `jpegtran` on the development machine,
compared against a literal pixel rotation of a `djpeg` decode of the same file):

| finding | evidence |
| --- | --- |
| coefficient-domain transforms are exact; decoded pixels differ only by IDCT rounding | 64×48 4:2:0: max 3 LSB; 4:4:4 `-rotate 180`: 0 differing bytes |
| 4:2:2 does not block 90° rotation | `-rotate 90` swaps 2×1 sampling to 1×2 and stays coefficient-exact |
| the real constraint is MCU alignment | with `-perfect`, `jpegtran` fails for 41×27, 17×9, 8×8 (4:2:0) and 3×2, but succeeds for 64×48 in 4:2:0/4:2:2/4:4:4 |
| images smaller than one MCU are degenerate | 3×2 4:2:0 `-rotate 180` decodes identically to the input |

The perfect-transform predicate was additionally verified against `jpegtran` for 392 combinations of
image size, sampling factor and transform (0 mismatches).

---

## 9. Behaviour changes relative to v1

| case | v1 | lossless-rotate |
| --- | --- | --- |
| JPEG without any Exif block, read | error −3 | `0` (no orientation) |
| leading non-Exif APP1 (XMP), read | error −3 | skipped, scanning continues |
| APP0 + APP2 (ICC) + APP1 | error −3 | works |
| IFD0 offset above 65535 | impossible | supported (32-bit) |
| truncated segment while reading | error −3 | `E_PREMATURE_END` |
| set on a file without an orientation tag | silent no-op, returned 0 | `E_INVALID_EXIF`, or `insertOrientation()` |
| set with `0` | acted as a read request | `E_INVALID_VALUE` |
| set with a value > 8 | wrote it anyway | `E_INVALID_VALUE` |
| write byte range | 10 bytes at `entry+2` | identical |
| rotation | GraphicsMagick re-encode (lossy) | lossless DCT transform |
| already upright image | re-encoded | byte-exact copy |
| error surface | numeric `legacyCode` | string `code` |
| WebP orientation, read/write | not supported | deliberately not supported (§11): browsers ignore the Exif tag in WebP |
| WebP rotation (`autoRotate`) | re-encoded via GraphicsMagick | `E_UNSUPPORTED_FORMAT`, a WebP is not a file this package handles |
| AVIF orientation, read/write | not supported | works: the `irot`/`imir` property, `meta`/`iloc` rebuilt |
| AVIF rotation (`autoRotate`) | not supported | `E_UNSUPPORTED`, the property is the answer |
| non-JPEG/AVIF file, file API | error −3 | `E_UNSUPPORTED_FORMAT` |

---

## 10. Out of scope, and roadmap

Out of scope for 0.6.0: non-JPEG formats, lossless crop/scale, thumbnail regeneration, progressive
**output**, arithmetic coding, 12-bit samples, and multi-image (MPO) files.

The embedded Exif thumbnail is rotated together with the main image (§12); that is not "thumbnail
regeneration" — the thumbnail stays the same JPEG, only rotated losslessly.

The AVIF container layer (§13) reads and writes the `irot`/`imir` properties of the primary item, with
the property set and the `iloc` extents rebuilt around them. Metadata only, for the same reason — AV1
has no coefficient-domain rotation — and byte-identical to `avifenc --irot/--imir`.

WebP is deliberately not supported; §11 explains why.

Planned next:

1. **AVIF Exif item** — an AVIF may also carry the orientation in an embedded Exif item. libavif treats
   `irot`/`imir` as the source of truth and normalises that tag to 1 (`avifImageExtractExifOrientationToIrotImir`),
   so the property path (§13) already covers the files in the wild; reading the Exif item as a fallback
   is a refinement, not a gap that changes behaviour.
2. **Lossless *pixel* rotation for AVIF**, built on the same decode → transform → encode
   skeleton. The codec front end is format specific, the transform layer is not: an AVIF is an AV1 still
   image, whose coefficient domain is an integer transform (`Txfm`), so a rotation is again a coefficient
   and block-grid rearrangement, with the same "perfect transform" question about block alignment instead
   of MCU alignment.

The goal is one transform core with pluggable per-format parse/decode/encode back ends.

---

## 11. Why WebP is not supported

A WebP can legally carry an Exif orientation tag in its RIFF `EXIF` chunk, and reading and patching it
would be straightforward — but no browser honours it. Chromium and Firefox render a tagged WebP as if
the tag were absent, so a package whose promise is "makes images upright" would be writing a value
nothing reads back. WebP is therefore treated like any other unsupported format: `E_UNSUPPORTED_FORMAT`
at the file level, and `autoRotateBuffer` refuses it.

AVIF is the opposite case, which is why it *is* supported: `irot`/`imir` is defined by the specification
*and* implemented by renderers (verified against Chromium). The TIFF code a WebP layer would have reused
(`src/exif.ts`) stays regardless, because JPEG and AVIF use it too.

---

## 12. The embedded Exif thumbnail

An Exif block usually describes its main image in IFD0 and a small preview in IFD1: tags `0x0201`
(offset of the thumbnail JPEG, relative to the TIFF header) and `0x0202` (its length, a `SHORT` or a
`LONG`, count 1). That preview is a complete, standalone JPEG with its own copy of the pixels, so a
rotation of the main image leaves it pointing the wrong way.

`rotateThumbnail: true` closes that gap with the tools that already exist:

1. `locateExifThumbnail` walks IFD0 → IFD1, reads `0x0201`/`0x0202` and returns the absolute bounds of
   the thumbnail plus the offsets of the two value fields.
2. The thumbnail bytes are handed to `transformJpeg` **recursively**, with the same primitive, the same
   `orientationInOutput` and `keepMetadata: true`. It is a JPEG like any other, so it stays
   coefficient-exact; if it carries its own Exif block, its own orientation tag is written too.
3. `replaceExifThumbnail` splices the new JPEG in and repairs the block.

The splice is where the care is needed, because re-encoding changes the length (a thumbnail always
comes out a slightly different size, since the encoder writes standard Annex K Huffman tables rather
than the source's) and the block is a flat structure whose interior offsets are absolute.

* `0x0202` is rewritten in place — it stays a `SHORT`/`LONG` at the same offset, so the file does not
  move for the common case.
* Everything that sits **behind** the thumbnail shifts by `delta = newLength - oldLength`. That means
  every 4-byte offset field in the block whose target is at or behind the thumbnail. `walkIfd` collects
  them (`TIFF type 4`, and the TIFF 4-byte "value fits inline" rule), each is rewritten at
  `position + (position >= thumbnailStart ? delta : 0)`, and `0x0201` itself is never touched (the
  thumbnail does not move, it only grows).
* The usual layout — `Make`, `Model`, `DateTime`, … in IFD0, thumbnail last — has nothing behind the
  thumbnail, so the walk is skipped entirely when the thumbnail ends exactly at the end of the block.
  The fixture `exif-thumbnail-shifted-06.jpg` places `Make` *behind* the thumbnail precisely so the
  fixup path is exercised, and the test asserts the offset moved by exactly the change in length.
* Structures the walker cannot interpret are refused, not guessed at: a `SubIFDs` tag (`0x014A`) or any
  pointer whose type/count combination is not a plain 4-byte offset raises `E_INVALID_EXIF`. A
  MakerNote that stores absolute TIFF offsets *inside its own blob* is the known blind spot: those
  offsets are opaque, so a MakerNote that sits behind the thumbnail would keep stale offsets. Cameras
  normally place it in IFD0, i.e. in front of the thumbnail, where nothing moves.

Failure policy: the option promises that both images end up the same way up, so a thumbnail that cannot
be held to that promise is an error rather than a silent stale preview. `E_UNSUPPORTED` from the inner
transform (arithmetic coding, 12-bit, two components) is re-raised as `E_UNSUPPORTED` with
`unsupported Exif thumbnail: …`; anything else becomes `E_INVALID_EXIF` with a message saying the
thumbnail is not a usable JPEG. Warnings from the inner transform are prefixed
`the embedded Exif thumbnail: `, so a "progressive input" or "not MCU aligned" note is never mistaken
for one about the main image. `thumbnailRotated` reports whether anything happened.

Verification: `test/jpeg/thumbnail.test.ts` reads the fixtures with its **own** TIFF/IFD walker (it follows
the offsets itself and resolves `Make` through them), so the fixup is never checked against the code
that performs it. The corpus covers the usual layout, the shifted one, big endian, a `SHORT` length
field, a thumbnail with its own Exif block, a progressive thumbnail, a non-MCU-aligned thumbnail, and
three that must raise (arithmetic, not-a-JPEG, `SubIFDs`). Beyond the byte-level checks, the tests
assert that the main image's coefficients are identical with and without the option and that the file
grew by exactly the difference in thumbnail length — i.e. that nothing else in the file changed.

---

## 13. AVIF: the metadata layer

An AVIF file is an ISOBMFF box tree: an `ftyp` box naming an AVIF brand, a `meta` full box, and the
compressed image data in `mdat`. The interesting part is the item structure inside `meta` (ISO/IEC
14496-12 and 23008-12):

```
meta
├── pitm   the primary item id (the one a viewer shows)
├── iinf   item information (infe), e.g. the "av01" item
├── iloc   where each item's data lives (extents, absolute or relative to a base offset)
└── iprp
    ├── ipco   the property boxes: ispe (size), av1C (codec config), colr, pixi, ... and irot / imir
    └── ipma   which 1-based ipco indices apply to which item
```

Unlike Exif, the AVIF orientation is **not** a value in a metadata blob: it is the pair of `irot`
(rotation) and `imir` (mirror) properties, and it only counts when the primary item's `ipma` entry
associates it. `src/avif/container.ts` is the ISOBMFF layer (box walker, big-endian number helpers,
box builder), `src/avif/item.ts` the item structure (`ipco`/`ipma`/`iloc` parsing and the `meta`
rebuild), and `src/avif/orientation.ts` the property layer.

### The property bytes

Both properties are one byte (ISO/IEC 23008-12, MIAF):

* `irot` — the counter-clockwise rotation in 90° steps sits in the low two bits (0..3); the upper bits
  are reserved.
* `imir` — the mirror axis sits in the least significant bit: `0` = top-to-bottom, `1` = left-to-right,
  applied *after* the rotation.

The eight Exif orientations map onto combinations of the two; `src/avif/orientation.ts` carries the
tables, derived empirically from `avifenc` output and Chromium rendering:

| angle (irot) | no mirror | `imir` axis 0 | `imir` axis 1 |
| --- | --- | --- | --- |
| 0 | 1 | 4 | 2 |
| 1 | 8 | 5 | 7 |
| 2 | 3 | 2 | 4 |
| 3 | 6 | 7 | 5 |

Reading: `avifLayout` walks the boxes down to `ipco`/`ipma` and reads `pitm` for the primary id;
`propertyIndexOfType` finds the first `irot`/`imir`; `isAssociated` checks the primary item's `ipma`
entry; `propertyByte` reads the transform bits. A property that exists but is not associated with the
primary item is ignored, which is what `pitm` and `ipma` are for. A missing pair reads as `0`.

For files, the file layer does **not** load the image data either: it reads only the eight-byte header
of each top-level box to find `meta` (which usually sits in front of `mdat`), then reads the head of the
file up to the end of that box and hands it to the in-memory parser; a file that stores `meta` behind
the image data is read in full, which is correct but not cheaper. The walk still checks that the top level
lines up with the end of the file, so trailing bytes fail here the same way they would in the buffer API.

### Writing

AVIF has no ten-byte patch path: a property is not an in-place field. The writer rebuilds `meta`:

1. **Apply the property.** For each of `irot`/`imir`, `applyProperty` reuses the existing `ipco` box at
   the same index (rewriting its body) or appends a new one. A property is **never removed from `ipco`**
   — only its association is dropped — because removing a box would renumber every later `ipma` index.
2. **Rebuild the primary item's association list.** Any existing `irot`/`imir` association is dropped
   and the current ones appended (marked `essential: true`, as libavif writes them). A primary item with
   no `ipma` entry at all gets one, so the transform cannot silently fail to apply.
3. **The minimal property set**, matching `avifenc` byte for byte: `needsIrot = axis === null || angle !== 0`
   and `needsImir = axis !== null`. So a pure mirror (orientations 2 and 4) carries **only** `imir` — an
   explicit `irot 0` there would be redundant and would not match libavif — a rotation or the identity
   carries `irot` (angle 0 for orientation 1), and the transpose/transverse (5 and 7) carry both.
4. **Fix up `iloc`.** Growing `ipco`/`ipma` moves `meta` and therefore everything behind it, including
   `mdat` when it follows. `rebuildMeta` shifts every `iloc` extent that sat at or behind the old `meta`
   by the size change, so the extents keep pointing at the same image bytes (an extent in front of `meta`
   needs no shift and gets none). The parser is told the shape by the box header rather than assuming one:
   `item_ID` is 16 bits in version 0/1 but 32 bits in version 2, `construction_method` exists from version
   1 on, and the base offset (its own width) is shifted alongside the extents — an extent addressed
   relative to a base offset therefore stays correct too. Data stored in `idat` (`construction_method` 1)
   is addressed relative to its own box and is not shifted.
5. **Rewrite the whole file.** Because `meta` moved `mdat`, the file is written back in full (and
   truncated) rather than patched; the image data is copied byte for byte.

`writeAvifOrientation` returns the new bytes plus an `AvifPatchResult` (the `PatchResult` shape plus the
`irot`/`imir` property indices, their byte offsets and whether `meta` had to be rebuilt).

There is **no rotation** for AVIF: AV1 has no coefficient-domain transform, so `autoRotate` throws
`E_UNSUPPORTED` and points at the properties. `orientation()`/`setOrientation()` dispatch on the
container like for JPEG, `canTransform()` is `false`, and a broken box tree is
`E_INVALID_AVIF` while a non-AVIF gets `E_UNSUPPORTED_FORMAT`.

An AVIF **image sequence** (`avis`) is an AVIF container but not a still image: its pictures live in
tracks and it has no item `meta` (`pitm`/`iloc`/`iprp`), so there is no `irot`/`imir` to read. `isAvif`
accepts both brands (the file really is an AVIF), and `isAvifSequence` tells the track-based case apart —
a file that names both brands is a still image. The orientation entry points reject a sequence with
`E_UNSUPPORTED_FORMAT`; the file layer applies the same check before its box walk, which would otherwise
fail first on the missing `meta`.

### Reading tolerance

Real files vary, so the reader accepts what the spec allows: `pitm` decides the primary item (1 when the
box is absent), `ipma` may use 16-bit or wide (15-bit) associations and a version-1 32-bit item id, the
properties may sit in `ipco` in any order, and both 32-bit and 64-bit box sizes are understood. What is
*not* read yet is an orientation stored in an embedded Exif item; libavif treats `irot`/`imir` as the
source of truth and normalises that tag to 1, so the property path covers the files in the wild (see the
roadmap).

### Verification

Three independent angles, in `test/avif/orientation.test.ts`:

* The hand-built fixtures in `test/fixtures/avif/` are assembled by `scripts/make-fixtures.mjs` from
  explicit byte arrays (the same independent-implementation rule as for JPEG). The manifest
  records the property list, the primary item, the `irot`/`imir` byte offsets and the `iloc` extent; the
  tests assert that the writer reproduces the hand-built files **byte for byte** for all eight
  orientations and that `iloc` keeps pointing at the untouched `mdat`. The corpus deliberately covers the
  `iloc` flavours — version 1, version 2 (32-bit item id) and a base offset — because the writer rewrites
  the extents and each shape has to be parsed the way it was written; the extent staying correct is
  checked with an independent walker, not only by the writer reading its own output back.
* `avifenc` is an independent writer oracle: for each orientation its `--irot`/`--imir` output must read
  back to the matching value, and the writer must reproduce libavif's output byte for byte.
* `avifdec` is a reader oracle: a file the writer touched must decode to the literal pixel rotation of
  the original (compared with ImageMagick `-rotate`, 0 differing pixels). The external tests skip
  themselves when the tools are missing.
