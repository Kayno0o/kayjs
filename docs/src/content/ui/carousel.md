---
description: One image at a time sliding in, with arrows and dots, for a marketing page.
---

<Demo name="carousel/basic" />

`slides` is a list of `{ src, alt }`. The previous and next buttons wrap at either end, a dot per slide jumps to it, and a single slide draws no controls.

## Autoplay and ratio

`autoplay` turns the slide that often, a duration such as `'5s'` or `'800ms'` (a bare number is milliseconds for now, and `kay check --fix` rewrites `autoplay={5000}` to `autoplay="5s"`). It pauses while the pointer or the focus is on the carousel, and never runs for a visitor asking for reduced motion. A pause button after the controls stops it for good, until pressed again; `pauseLabel` and `playLabel` name it. `ratio` sets the slides' aspect ratio.

<Demo name="carousel/autoplay" />

<Callout type="tip">

Set `label` to name the carousel for screen readers.

</Callout>

## Controlled slide

`index` is the slide shown first, 0 by default. A carousel whose parent passes another follows it, and `onIndexChange` hears each turn.

## Labels

`previousLabel` and `nextLabel` name the arrows, `Previous slide` and `Next slide` by default. `slideLabel` names a slide, `Slide {n} of {count}`, and `dotLabel` a dot, `Go to slide {n}`. `{n}` stands for the slide's number and `{count}` for how many there are.
