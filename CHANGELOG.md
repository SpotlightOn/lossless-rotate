# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] - 2026-10-30

### Added

- **Lossless JPEG crop.** `crop` / `cropBuffer` and `--crop WxH+X+Y` cut a rectangle of whole DCT blocks
  out of an image without changing a coefficient, optionally in the same pass as a rotation. An origin
  off the MCU grid is rounded down like `jpegtran` and reported (`onUnaligned: "error"` refuses).
- `transformJpeg({ crop })`, `cropGeometry`, `cropRegionToString` and `crop` on `autoRotate`'s options,
  plus unit and differential tests against `jpegtran -crop`.

### Changed

- **Breaking:** `orientation()` is promise-only. The callback overload is gone;
  `await orientation(file)` and `await orientation(file, value)` are unchanged.

## [0.6.0] - 2026-10-21

Early stage, nothing released yet. Rotation and orientation handling with no native code and no
re-encoding.

### Added

- **Lossless JPEG rotation.** `autoRotate` / `autoRotateBuffer` rearrange the quantized DCT
  coefficients and the MCU grid: no dequantization, no requantization, no generation loss.
- **Exif orientation handling.** Read the tag, patch it in place (exactly the ten bytes of the IFD
  entry), or insert a minimal Exif block when there is none.
- **Baseline and progressive input.** Progressive files are decoded across all scans and written out as
  sequential JPEGs, still coefficient-exact.
- **The embedded Exif thumbnail** can be rotated with the image (`rotateThumbnail: true`), using the
  same code, with the thumbnail's length tag and the offsets behind it fixed up afterwards.
- **AVIF orientation.** The `irot`/`imir` properties of the primary item are read and written; a write
  rebuilds the property set and shifts the `iloc` extents, so the image data is copied byte for byte.
  `autoRotate` refuses AVIF with `E_UNSUPPORTED`, because AV1 has no coefficient-domain rotation.
- **A CLI**: `lossless-rotate info|rotate|set|thumbnail`, with `--rotate`, `--thumbnail`, `--strict`,
  `--drop-metadata`, `--json` and `-o/--output`. Results go to a git-ignored `tmp/` by default.
- **Public API**: `orientation`, `setOrientation`, `canTransform`, `transformJpeg`, `parseJpeg`,
  `decodeCoefficients`, `frameGeometry`, `isPerfectTransform`, `transformForRotation`,
  `composeTransforms`, the Exif/TIFF helpers, and the AVIF layer under
  `@chimok/lossless-rotate/avif`.
- `OrientError` with stable string codes, a fixture generator, and differential tests against
  `jpegtran`, `avifenc` and `avifdec`.

### Notes

- Requires Node.js ≥ 24; ESM, zero runtime dependencies, no native code.
- Transforms of images whose dimensions are not a multiple of the MCU size are performed with a
  warning; `onImperfect: "error"` refuses them instead.
- Progressive **output** is out of scope; progressive input is always written as sequential.
- `rotateThumbnail` is off by default and raises rather than skipping a thumbnail it cannot transform.
