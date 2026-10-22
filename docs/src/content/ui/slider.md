---
description: One number on a native range input, with its label and its value written beside it.
---

<Demo name="slider/basic" />

## Slider or RangeInput

A Slider holds one number between `min` and `max` (0 and 100 by default), moved in `step`s. For a from/to pair with open bounds, use [RangeInput](/ui/range-input).

## The shown value

The value is written beside the label; `showValue={false}` hides it, and `formatValue` words it, here `value => `${value} ms``. The same words go to the input's `aria-valuetext`, so a screen reader hears "200 ms" and not "200".

## Reading it

`onInput` runs on every move of the thumb with the number, and after a form reset with the value the slider went back to. A `value` the parent passes later is followed. With a `name` the input posts its number in a plain form, and `id`, `disabled` and the other input attributes go on the input.

The track and the thumb are drawn from the theme tokens, so an app styles no `::-webkit-slider-thumb` itself.
