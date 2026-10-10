---
description: A value drawn as a QR code, an SVG image rendered where the page renders.
---

<Demo name="qr-code/basic" />

`label` is the image's `alt`, such as where the code leads, and `size` its width and height in pixels. The code is drawn on the server for a static page.

## Styling

`options` takes the drawing options of `qrCodeSvg` from `@kaynooo/utils`, such as `ecc`, `moduleShape`, `foreground` and `eyeColor`. Colors are written out, since the image cannot read the page's CSS.

<Demo name="qr-code/styled" />
