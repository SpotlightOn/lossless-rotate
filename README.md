# @spotlighton/lossless-rotate

[![CI](https://github.com/SpotlightOn/lossless-rotate/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/SpotlightOn/lossless-rotate/actions/workflows/ci.yml)
[![Socket](https://github.com/SpotlightOn/lossless-rotate/actions/workflows/socket.yml/badge.svg?branch=main)](https://github.com/SpotlightOn/lossless-rotate/actions/workflows/socket.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

Make JPEGs upright — in the DCT domain, so **not a single pixel is re-encoded**.

This is a pure TypeScript version of `jpegtran`. There is also a WASM version, which is better tested:
[`@chimok/jpegtran-js`](https://www.npmjs.com/package/@chimok/jpegtran-js).

The AVIF `irot`/`imir` properties are defined by the HEIF standard,
[ISO/IEC 23008-12](https://www.iso.org/standard/83650.html), and listed for AVIF in the
[AVIF specification](https://aomediacodec.github.io/av1-avif/) (§9.1.2). Not every browser applies them
yet, but they are the lossless way to orient an AVIF, so they are supported here for the future.

`lossless-rotate` reads and writes the Exif orientation tag and rotates JPEG images by
90°/180°/270° and the diagonal mirrors **losslessly**: the quantized DCT coefficients are rearranged,
never dequantized and never requantized. No quality loss, no generation loss, no native code.

The same reasoning covers **AVIF**: it stores its orientation not in a tag but in the `irot`/`imir`
properties of its primary item. AV1 has no lossless rotation, so `orientation()` reads and writes those
properties (rebuilding the property set and repairing the `iloc` extents, image data untouched) and
`autoRotate` refuses an AVIF as well. See [AVIF](#avif).

- **Pure TypeScript**, shipped as source and run directly by Node (native type stripping).
- **Zero runtime dependencies.** No `sharp`, no `gm`, no `jpegtran`, no C/C++ addon, no compiler step.
- **Lossless by construction.** The transform operates on the entropy-coded coefficients; decoding a
  transformed file and decoding a rotated copy of the original agree exactly (verified against
  `jpegtran`).
- **Baseline and progressive input.** Progressive files are decoded across all scans and written out
  as a sequential JPEG — still coefficient-exact.
- **AVIF orientation** is written as the `irot`/`imir` item properties; the property set is rebuilt and
  the `iloc` extents shifted to match, so the image data survives byte for byte.
- **The embedded Exif thumbnail** can be rotated along with the main image (`rotateThumbnail`), so both
  end up the same way up — see [the thumbnail section](#the-embedded-exif-thumbnail).
- **A CLI** (`lossless-rotate info|rotate|set|thumbnail`) for quick checks without writing code.

## Requirements

- **Node.js ≥ 24** (the package ships `.ts` files and relies on native type stripping).
- ESM. From CommonJS, `require("@spotlighton/lossless-rotate")` works on Node ≥ 22.12 via `require(esm)`.

## Install

```sh
npm install @spotlighton/lossless-rotate
```

## Usage

### Read or set the orientation tag

Setting the tag only rewrites ten bytes of the Exif IFD — the image data is untouched.

```js
import { orientation } from "@spotlighton/lossless-rotate";

await orientation("IMG_0001.jpg");        // -> 6 (0 when there is no tag)
await orientation("IMG_0001.jpg", 1);     // metadata only, still lossless
```

The v1 callback style keeps working:

```js
orientation("IMG_0001.jpg", (error, value) => { /* ... */ });
```

### Make an image upright

```js
import { autoRotate } from "@spotlighton/lossless-rotate";

const result = await autoRotate("IMG_0001.jpg", "upright.jpg");
// result.orientation -> 6        (the value that was stored in the source)
// result.transform   -> "rotate90"
// result.perfect     -> true
// result.copied      -> false    (true when the image was already upright)
// result.warnings    -> []
```

Without a destination you get the bytes back instead of writing a file:

```js
import { autoRotate } from "@spotlighton/lossless-rotate";
const { bytes } = await autoRotate("IMG_0001.jpg");
```

Or work purely on buffers:

```js
import { autoRotateBuffer, setOrientation, canTransform } from "@spotlighton/lossless-rotate";

const { result, bytes } = autoRotateBuffer(source);
const tagged = setOrientation(source, 6);   // insert/patch the tag, no rotation
canTransform(source);                        // false instead of throwing for non-JPEGs
```

### AVIF

An AVIF still image is one ISOBMFF *item*. Its orientation is not a tag in a metadata block but the
`irot`/`imir` property pair of that item, which maps onto the eight Exif orientations. `orientation()`
detects the container from the `ftyp` box and works the same way:

```js
import { orientation, autoRotate, canTransform, setOrientation } from "@spotlighton/lossless-rotate";

await orientation("photo.avif");        // -> 6, from the irot/imir properties (0 when there are none)
await orientation("photo.avif", 1);     // writes irot 0 explicitly, the image data is untouched
await orientation("plain.avif", 6);     // adds an irot property (and repairs iloc) when there is none

await autoRotate("photo.avif", "upright.avif");  // throws E_UNSUPPORTED
canTransform(avifBytes);                          // false
setOrientation(avifBytes, 6);                     // Buffer in, Buffer out
```

The details that matter:

- **No rotation.** AV1 has no coefficient-domain transform, so `autoRotate`/`autoRotateBuffer` raise
  `E_UNSUPPORTED` and point at the properties; every renderer (Chrome, Firefox, libavif-based tooling)
  honours them, so the image still appears upright.
- **The property set is the minimal one libavif writes**: a pure mirror (2/4) carries only `imir`, a
  rotation or the identity carries `irot` (with angle 0 for orientation 1), and a transpose/transverse
  (5/7) carries both. For all eight orientations the output is byte-identical to `avifenc
  --irot/--imir`.
- **A write is a rewrite, not a patch.** Adding a property grows `ipco`/`ipma`, which moves `meta` and
  everything behind it, usually `mdat`, so the `iloc` extents are shifted by exactly the difference. The
  image data is copied byte for byte — verified by decoding the result with `avifdec`.
- **Every `iloc` flavour is handled.** The item id may be 16 or 32 bits (`iloc` version 0/1/2, with the
  `construction_method` field when present) and the extents may be absolute or relative to a base offset;
  the rewrite keeps the extent pointing at the same `mdat` bytes in each case.
- **Only the primary item counts.** The transform must be associated with the item `pitm` names; an
  `irot` that belongs to another item is ignored, and a primary item without an `ipma` entry gets one.
- **Reading tolerates the real world**: `pitm` decides the primary item, `ipma` may use 16-bit or wide
  associations and a version-1 item id, and the properties may sit in any order. A structurally broken
  box tree is reported as `E_INVALID_AVIF`, and an AVIF *image sequence* (`avis`, track based, with no
  item properties) as `E_UNSUPPORTED_FORMAT`.

### Options

```js
await autoRotate(source, destination, {
  onImperfect: "warn",    // "warn" (default) or "error"
  orientationInOutput: 1, // value written to the result, default 1 (upright)
  keepMetadata: true,     // carry APPn/COM segments over, default true
  rotateThumbnail: false, // rotate the embedded Exif thumbnail too, default false
});
```

### The embedded Exif thumbnail

A camera usually stores a second, small JPEG in the Exif block (IFD1 tags `0x0201`/`0x0202`) — the
thumbnail the file manager shows. It has its own copy of the pixels, so rotating only the main image
leaves it lying the wrong way up.

`rotateThumbnail: true` applies the same transform to that thumbnail as well:

```js
const { result } = await autoRotate("IMG_0001.jpg", "upright.jpg", { rotateThumbnail: true });
// result.thumbnailRotated -> true   (false when there was no thumbnail, or nothing to rotate)
```

- **Still lossless.** The thumbnail is a JPEG too, so it is transformed with the same coefficient-exact
  code — no `sharp`, no re-encode from pixels.
- **Opt-in.** The block has to be re-fixed-up when the thumbnail's length changes, so the behaviour is
  never on by default. Without the option the thumbnail is carried over byte-for-byte.
- **Errors instead of a silent stale thumbnail.** Because the point of the option is that both images
  end up the same way up, a thumbnail that cannot be transformed is not quietly skipped: an
  unsupported thumbnail (arithmetic coding, 12-bit, two components) raises `E_UNSUPPORTED`, a broken
  one (not a JPEG, a structurally broken Exif block, `SubIFDs`) raises `E_INVALID_EXIF`. Warnings from
  the thumbnail are prefixed with `the embedded Exif thumbnail: `, so they cannot be confused with the
  main image's.
- **The offset fixup.** Transforming the thumbnail changes its length, so everything that sits behind
  it in the Exif block moves. `0x0202` (length) is rewritten in place, and every 4-byte offset field
  that points behind the thumbnail is shifted by exactly the difference — which is the usual layout
  (`Make`/`Model` first, thumbnail last) needing no fixup at all. One caveat: a MakerNote that stores
  *absolute* TIFF offsets internally is not fixed up, and a block that declares `SubIFDs` is refused
  rather than mis-shifted.

## Command line

The package ships a small CLI for looking at and fixing files without writing any code:

```sh
npx lossless-rotate info photo.jpg                 # container, orientation, size, thumbnail
npx lossless-rotate rotate photo.jpg --thumbnail   # make upright, thumbnail included
npx lossless-rotate rotate photo.jpg --rotate 90   # turn it 90 degrees clockwise
npx lossless-rotate rotate *.jpg -o upright/       # several files into a directory
npx lossless-rotate set photo.jpg 6                # write the orientation only, no re-encode
npx lossless-rotate set photo.avif 6               # ... also for AVIF
npx lossless-rotate thumbnail photo.jpg            # extract the embedded Exif thumbnail
```

| Command | What it does |
| --- | --- |
| `info <file>` | Prints the format, orientation, size, sampling, the transform that would be applied, and (for JPEG) whether an Exif thumbnail is embedded and can be rotated. `--json` prints the same as JSON. |
| `rotate <file...>` | Makes JPEGs upright (lossless). `--thumbnail` rotates the embedded thumbnail too, `--strict` refuses imperfect transforms, `--drop-metadata` drops APPn/COM. Refuses AVIF (`E_UNSUPPORTED`). |
| `set <file> <orientation>` | Writes the orientation only — the Exif tag for JPEG, the `irot`/`imir` property for AVIF; the image data is copied untouched (a minimal Exif block is added when there is none). |
| `thumbnail <file>` | Extracts the embedded Exif thumbnail as a JPEG. Exits `1` when there is none. |

**`rotate` takes no angle.** Making an image upright is not "turn it by N degrees": how far to turn is
read from the orientation tag the file already carries (90, 180 or 270, or a mirror). `info` prints it,
`rotate` applies it. There is nothing to work out by hand:

```sh
$ lossless-rotate info photo.jpg
orientation  6 (RightTop)
transform    rotate90
```

`--rotate <deg>` is for the other case — turning by a fixed amount. It is counted from the way the
image **is displayed**, so the stored tag is applied first and cleared afterwards:

```sh
lossless-rotate rotate photo.jpg --rotate 90      # 90 degrees clockwise from what you see
lossless-rotate rotate photo.jpg --rotate 270     # the other way (90 counter-clockwise)
```

A tag of 6 already means "turn 90 clockwise", so `--rotate 90` on such a file becomes `rotate180` in
one pass — one lossless transform, not two, so the partial edge blocks only move once. If the tag and
the requested angle cancel out (tag 3 with `--rotate 180`), the file is copied instead of re-encoded.
A file with no tag at all gets its pixels turned and no tag invented for it.

Results are written into `tmp/` (git-ignored, safe to delete) unless `-o/--output` says otherwise, so
trying something out never modifies the input and never leaves anything behind that would show up in
`git status`. Errors are printed as `<code>: <message>` and set the exit status to `1`.

## Lossless, but only *perfect* transforms are faithful

A lossless transform rearranges whole 8×8 coefficient blocks and the MCU grid. That only lines up
with the visible image when the image dimensions are a whole number of **MCUs** along the axes a
transform touches:

| Transform | Perfect when |
| --- | --- |
| flip horizontal, rotate 270° | `width` is a multiple of `8 × maxH` |
| flip vertical, rotate 90° | `height` is a multiple of `8 × maxV` |
| rotate 180°, transverse | both |
| transpose | always |

For anything else the padding of the partial edge MCUs moves into the visible area, which shifts the
image. `lossless-rotate` behaves like `jpegtran`: it performs the transform anyway and reports it.

```js
const { result } = autoRotateBuffer(source);
if (!result.perfect) {
  console.warn(result.warnings[0]);
  // "... its dimensions are not multiples of the MCU size (16x16 pixels). The padding of the
  //  partial edge iMCUs moves into the visible area, which shifts the image ..."
}
```

Pass `{ onImperfect: "error" }` to refuse such files with `E_UNSUPPORTED` instead. To get a faithful
rotation for them, crop or pad to a multiple of the MCU size first, or re-encode the image.

For a **perfect** transform the decoded result is byte-identical to `jpegtran`'s output; the package's
test suite asserts this across image sizes, sampling factors (4:2:0, 4:2:2, 4:4:4), and all seven
transforms.

## What the package does with a file

- **Exif is preserved.** APPn and COM segments are carried over unchanged; the orientation tag in the
  result is set to 1 (configurable). `keepMetadata: false` drops them.
- **The embedded Exif thumbnail is carried over unchanged** unless `rotateThumbnail: true` asks for it
  to be rotated with the same primitive.
- **Progressive in, sequential out.** Progressive input is decoded scan by scan and re-encoded as a
  baseline JPEG, with the source's quantization tables. A warning says so. Progressive output is out
  of scope.
- **Restart markers are dropped** (always legal); a warning says so.
- **An already upright image is copied byte-for-byte**, never re-encoded.
- **Images without Exif are not touched** by `autoRotateBuffer`; it reports orientation `0` and copies.

## Errors

Every failure is an `OrientError` with a stable `code`:

| Code | Meaning |
| --- | --- |
| `E_CANT_OPEN` | The file could not be opened or read. |
| `E_UNSUPPORTED_FORMAT` | Not a still image of a supported kind: neither a JPEG (`FF D8`) nor an AVIF (`ftyp` with an AVIF brand) — or an AVIF image sequence (`avis`), which is track based and carries no item properties. |
| `E_NOT_JPEG` | A buffer-level JPEG entry point got something without an SOI marker. |
| `E_PREMATURE_END` | The file ends inside a segment or inside the entropy data. |
| `E_INVALID_EXIF` | The Exif block is structurally broken, has no orientation tag to update, or (with `rotateThumbnail`) cannot be fixed up safely. |
| `E_INVALID_JPEG` | The JPEG structure is broken (markers, tables, entropy data). |
| `E_INVALID_AVIF` | The AVIF ISOBMFF structure is broken (a box runs past the end of the file, or `meta`/`iprp`/`ipco`/`ipma` is missing). |
| `E_INVALID_VALUE` | An argument was out of range (e.g. an orientation outside 1..8). |
| `E_UNSUPPORTED` | A feature this package cannot transform losslessly (e.g. arithmetic coding, `onImperfect: "error"`, rotating an AVIF, or `rotateThumbnail` on a thumbnail it cannot transform). |

## Lower-level API

The transformer and the parsing layers are exported for callers that want to build on them:

```js
import { transformJpeg, parseJpeg, decodeCoefficients, frameGeometry, isPerfectTransform } from "@spotlighton/lossless-rotate";
```

`transformJpeg(bytes, { primitive })` applies one primitive (`flipHorizontal`, `flipVertical`,
`rotate180`, `rotate90`, `rotate270`, `transpose`, `transverse`, or `none`). `decodeCoefficients` and
`parseJpeg` expose the decoded blocks and the parsed structure.

The TIFF/Exif code sits one level below the container, so the tag can also be handled on a bare TIFF
block. The `...InExifBlock` variants take that block with its bounds instead of an APP1 segment:

```js
import {
  readOrientationInExifBlock,  // (buffer, tiffOffset, end) -> value
  patchOrientationInExifBlock, // (buffer, tiffOffset, end, value) -> PatchResult
  buildExifTiff,               // (value) -> a bare TIFF block
  locateExifThumbnail,         // (buffer, tiffOffset, end) -> ExifThumbnail | null
  replaceExifThumbnail,        // (buffer, tiffOffset, end, thumbnail, data) -> the new Exif block
} from "@spotlighton/lossless-rotate";
```

AVIF-specific entry points live under `@spotlighton/lossless-rotate/avif` and are also exported from
the root:

```js
import {
  isAvif, isAvifSequence, avifLayout, avifImageSize, avifPropertyTypes,  // the ISOBMFF layer
  readAvifOrientation,
  writeAvifOrientation,                                   // rebuild meta, fix up iloc
  setAvifOrientation,                                     // Buffer in, Buffer out
} from "@spotlighton/lossless-rotate";
```

`isAvifSequence` is true for an AVIF *image sequence* (`avis`, track based, no item properties), which the
orientation entry points reject with `E_UNSUPPORTED_FORMAT`. `writeAvifOrientation` returns the new bytes
plus an `AvifPatchResult` (the `PatchResult` shape plus the `irot`/`imir` property indices, their byte
offsets, and whether `meta` had to be rebuilt).


## Migrating from `jpegorientation` v1

- The C++ addon and the `gm`/GraphicsMagick dependency are gone; the whole package is pure
  JavaScript/TypeScript with no dependencies.
- `orientation(source, [value], [callback])` keeps its shape and still returns a promise.
- Reading a file **without** Exif now returns `0` instead of throwing; writing to a file without an
  orientation tag raises `E_INVALID_EXIF` instead of silently doing nothing.
- `autoRotate` is now lossless. An already upright image is copied instead of re-encoded.
- More layouts are understood (APP2/ICC before APP1, XMP before Exif, 32-bit IFD0 offsets, …).
- AVIF files are handled too: `orientation()` reads and writes the primary item's `irot`/`imir`
  properties, adding them when the file has none. `autoRotate` refuses to rotate them as well.
- `orientationToString` is still exported. `legacyCode` error numbers are gone; use `code`.

See `DESIGN.md` for the full behaviour table and the verification evidence.

## Development

```sh
npm test           # node --test  (118 tests)
npm run typecheck  # tsc --noEmit
npm run lint       # biome check .
npm run lint:fix   # biome check --write .   (formats and sorts imports)
```

Tests are grouped by format: `test/core/` covers the format-agnostic parts (the orientation table and
the public API) and holds the shared fixture and CLI helpers, `test/jpeg/` and `test/avif/` cover the
format-specific suites, and `test/fixtures/` is the corpus both read.

Linting and formatting use [Biome](https://biomejs.dev); the configuration is in `biome.json`.

Node's native type stripping **erases** types, it does not check them, so `typescript` is a
devDependency for `npm run typecheck` (`tsc --noEmit`) only — nothing is ever compiled or emitted, and
consumers do not install it. `tsconfig.json` sets `erasableSyntaxOnly`, which makes `tsc` reject any
syntax Node could not strip (enums, parameter properties, …), so "type checks" and "runs on Node" stay
the same thing.

The differential tests compare against `jpegtran`/`djpeg` and for AVIF against `avifenc`/`avifdec` and
ImageMagick; the fixture generator additionally uses GraphicsMagick (`gm`) and `cjpeg`. All of them skip
themselves when the tools are not on `PATH`, so `npm test` works everywhere. To regenerate the fixture
corpus:

```sh
npm run fixtures  # needs gm, cjpeg, jpegtran
```

## Releasing

Publishing is driven by the `Release` workflow (`.github/workflows/release.yml`). Bump the version and
add a matching `## [x.y.z]` section to `CHANGELOG.md`, then push the tag:

```sh
npm version patch   # or minor / major; commits and tags vX.Y.Z
git push --follow-tags
```

The workflow checks that the tag matches `package.json`, runs lint, type check and tests, publishes to
**GitHub Packages** as `@spotlighton/lossless-rotate` (this needs only the built-in `GITHUB_TOKEN`),
and creates a GitHub release from the matching `CHANGELOG.md` section. Publishing to the public npmjs
registry is optional and only runs when an `NPM_TOKEN` secret is set — for that, the `@spotlighton`
scope has to be owned on npmjs.

Installing from GitHub Packages needs an authenticated npm client:

```sh
# ~/.npmrc
# @spotlighton:registry=https://npm.pkg.github.com
# //npm.pkg.github.com/:_authToken=<your-token>
npm install @spotlighton/lossless-rotate
```

## Roadmap

0.6.0 is the current early version: JPEG rotation with the Exif thumbnail, plus AVIF orientation as the
primary item's `irot`/`imir` properties. WebP is deliberately out of scope — browsers ignore its Exif
orientation tag (see [DESIGN.md §11](DESIGN.md#11-why-webp-is-not-supported)). Still open:

1. **AVIF Exif item**: an AVIF can also carry its orientation in an embedded Exif item. libavif treats
   `irot`/`imir` as the source of truth and normalises that tag to 1, so the property path already
   covers virtually every file; reading the Exif item is a later refinement. See `DESIGN.md` §10.
2. **Lossless pixel rotation for AVIF** (the AV1 coefficient domain) on top of the existing
   decode → transform → encode skeleton — if it turns out to be worth the complexity.

## License

MIT — see [LICENSE](LICENSE).
