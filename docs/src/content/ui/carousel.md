---
description: One image at a time sliding in, with arrows and dots, for a marketing page.
---

<Demo name="carousel/basic" />

`slides` is a list of `{ src, alt }`. The previous and next buttons wrap at either end, a dot per slide jumps to it, and a single slide draws no controls.

## Autoplay and ratio

`autoplay` turns the slide every that many milliseconds. It pauses while the pointer or the focus is on the carousel, and never runs for a visitor asking for reduced motion. A pause button after the controls stops it for good, until pressed again; `pauseLabel` and `playLabel` name it. `ratio` sets the slides' aspect ratio.

<Demo name="carousel/autoplay" />

<Callout type="tip">

Set `label` to name the carousel for screen readers.

</Callout>
