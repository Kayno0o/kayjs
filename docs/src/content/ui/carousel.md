---
description: One image at a time sliding in, with arrows and dots, for a marketing page.
---

<Demo name="carousel/basic" />

`slides` is a list of `{ src, alt }`. The previous and next buttons wrap at either end, a dot per slide jumps to it, and a single slide draws no controls.

## Swipe and keys

A swipe along the slides turns the carousel: 40 px or more, clearly more across than down, with touch, a pen or a mouse. A vertical drag still scrolls the page, and the click that ends a swipe does not follow a slide's link. ArrowLeft and ArrowRight turn it from inside it, leaving the arrows of a field in a slide alone. `onIndexChange` hears each turn.

## Loop and several slides

`loop` is on by default. `loop={false}` stops at either end, with the button of that side disabled. `perView` shows that many slides at once, each its share of the width: a turn moves one slide, `index` is the first one in view, and a dot stands for each place the first one can be. A looping carousel wraps around, and with every slide in view no controls are drawn.

```kay
Carousel(slides={photos} perView={3} loop={false} label="Photos")
```

## Slides of your own

With a `@slide` block a slide needs no `src` or `alt`; give it a `key` to tell it apart.

```kay
Carousel(slides={[{ key: 'a', title: 'First' }, { key: 'b', title: 'Second' }]})
  @slide(card)
    p {card.title}
```

Without a block a slide with no `src` draws an empty picture; the types do not tell the two cases apart.

## Autoplay and ratio

`autoplay` turns the slide that often, a duration such as `'5s'` or `'800ms'`. It pauses while the pointer or the focus is on the carousel, while it is scrolled out of view or the tab is hidden, and never runs for a visitor asking for reduced motion. A pause button after the controls stops it for good, until pressed again; `pauseLabel` and `playLabel` name it. `ratio` sets the slides' aspect ratio.

<Demo name="carousel/autoplay" />

<Callout type="tip">

Set `label` to name the carousel for screen readers.

</Callout>

## Controlled slide

`index` is the slide shown first, 0 by default. A carousel whose parent passes another follows it, and `onIndexChange` hears each turn.

## Labels

`previousLabel` and `nextLabel` name the arrows, `Previous slide` and `Next slide` by default. `slideLabel` names a slide, `Slide {n} of {count}`, and `dotLabel` a dot, `Go to slide {n}`. `{n}` stands for the slide's number and `{count}` for how many there are.

## Loaded page by page

It takes `list`, an `infiniteList`, in place of the array.The next page loads when the reader reaches the last slides, and a failed page shows `LoadMore`'s alert with its retry under the controls. See [Infinite lists](/ui/load-more).
