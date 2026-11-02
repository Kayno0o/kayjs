---
description: A pane that zooms and pans what it holds, by wheel, pinch, drag, keys or buttons.
---

<Demo name="zoom-pane/basic" />

`label` names the view for screen readers. Give the pane a size, as it fills it.

## Limits and tools

`most` limits how far in it can go, as a multiple of the fitted size, and `least` how far out (1, fitted, by default). `tools={false}` hides the zoom buttons while the gestures keep working.

<Demo name="zoom-pane/limits" />

## Following the scale and offset

`onChange({ scale, x, y })` runs whenever the plate moves or zooms, however it did. `x` and `y` are where the plate's top-left corner sits in pixels, so a card, a selection ring or a minimap can follow it. `least` sets how far out it can go, a multiple of fitted that is 1 by default; below 1 the plate may shrink inside the pane.

<Demo name="zoom-pane/follow" />

## Marks that keep their size

The zoom is published as `--zoom-scale`, so a mark standing on the pane can undo it with `scale(calc(1 / var(--zoom-scale)))` and stay readable while the map grows.

<Demo name="zoom-pane/marks" />

## Driven by the page

`plate` is the view to show, `{ scale, x, y }` as `onChange` hears it: a zoom-to-marker button sets it, a restored view starts the pane on it, and `{ scale: 1, x: 0, y: 0 }` fits it. The pane follows each new value the parent passes, held against its edges as a gesture is, without calling `onChange` for it; its own gestures, keys and buttons keep working and report through `onChange`, so a parent that keeps `plate` in a signal writes `onChange={next => plate = next}`.

## Button labels

`zoomInLabel`, `zoomOutLabel` and `fitLabel` name the three zoom buttons, `Zoom in`, `Zoom out` and `Fit` by default. Set them to translate the pane.
