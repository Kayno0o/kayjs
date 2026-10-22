---
description: A colour picked on a native input, drawn as a swatch with its label and hex.
---

<Demo name="color-input/basic" />

The field is a native `input type="color"`, so the browser draws its own picker and a form posts `#rrggbb` under `name` with no JavaScript. The swatch is drawn from the theme tokens, with the label and the hex written beside it. `value` is the colour as `#rrggbb`, and a `value` the parent passes later is followed.

## Reading it

`onChange` runs once with the colour the picker commits, in lowercase `#rrggbb`, and after a form reset that moved it. It does not run on each shade the pointer passes over: the swatch follows those on its own. Use a [Slider](/ui/slider) for a number instead.

## Async change

Return a promise from `onChange` to hold the input busy until it settles, for a colour sent to a device that takes seconds to answer. A click opens no picker while it is busy. If the promise rejects or resolves to `false`, the previous colour is put back, so a refused change never shows as made. A `value` the parent sets meanwhile has the last word.

<Demo name="color-input/busy" />

## Label

`label` is required. It names the input for screen readers.
