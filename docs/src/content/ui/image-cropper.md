---
description: A crop of a fixed ratio over an image, moved and resized by pointer or keyboard.
---

<Demo name="image-cropper/basic" />

## Ratio and callbacks

`ratio` locks the crop's width over its height. `onCrop` reports `{ x, y, w, h }` in the image's natural pixels after every change, ready for a canvas draw.

## Grid, minimum size and reset

`grid` adds a rule-of-thirds overlay and `minSize` sets the smallest side. The `@footer(reset)` block renders under the image, and `reset()` centres the crop again.

<Demo name="image-cropper/footer" />

## Source and labels

`src` is the image and `alt` its text, empty by default. `onLoad` hears the image's natural size once it has decoded.

`cropLabel` names the crop area for screen readers, with the keys that move it. `cropText` reads the crop out as it changes, `{w}`, `{h}`, `{x}` and `{y}` standing for its size and place in natural pixels, `{w} by {h} pixels at {x}, {y}` by default.
