---
description: A crop of a fixed ratio over an image, moved and resized by pointer or keyboard.
---

<Demo name="image-cropper/basic" />

## Ratio and callbacks

`ratio` locks the crop's width over its height. `onCrop` reports `{ x, y, w, h }` in the image's natural pixels after every change, ready for a canvas draw.

## Grid, minimum size and reset

`grid` adds a rule-of-thirds overlay and `minSize` sets the smallest side. The `@footer(reset)` block renders under the image, and `reset()` centres the crop again.

<Demo name="image-cropper/footer" />
