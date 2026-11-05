---
description: A crop of a fixed ratio over an image, moved and resized by pointer or keyboard.
---

<Demo name="image-cropper/basic" />

## Ratio and callbacks

`ratio` locks the crop's width over its height. `onCrop` reports `{ x, y, w, h }` in the image's natural pixels after every change, ready for a canvas draw.

`onCropEnd` is called with the crop once a drag that moved it is released, after each arrow press and after the footer's `reset()`. It is the moment to save, where `onCrop` runs on every move.

`crop` is the crop to start from, in natural pixels. It is kept inside the image at the shape of `ratio`, and `onCrop` hears the kept crop when it differs from the one given. When the value changes the crop follows it, so a preset button or a saved avatar crop needs no ref. Left out, the crop is centred.

## Grid, minimum size and reset

`grid` adds a rule-of-thirds overlay and `minSize` sets the smallest side. The `@footer(reset)` block renders under the image, and `reset()` centres the crop again.

<Demo name="image-cropper/footer" />

## Source and labels

`src` is the image and `alt` its text, empty by default. `onLoad` hears the image's natural size once it has decoded. When the image does not load, `onError` is called with `{ event }` (or `{ error }` when decoding rejected) and the stage shows `failureLabel`, or the `@fallback` block, until `src` changes.

`cropLabel` names the crop area for screen readers, with the keys that move it. `cropText` reads the crop out as it changes, `{w}`, `{h}`, `{x}` and `{y}` standing for its size and place in natural pixels, `{w} by {h} pixels at {x}, {y}` by default.
