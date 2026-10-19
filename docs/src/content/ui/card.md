---
description: The frame a page's content is written on, with an optional title and header.
---

<Demo name="card/basic" />

## Header

`@head` fills the rest of the title's line, held at its far end: a count, a control, a link out.

<Demo name="card/head" />

## Bare

`bare` drops the padded body, for content that runs to the card's edge such as a chart or a table.

<Demo name="card/bare" />

## Heading level

The title is an `h3`. `level` sets another, from 1 to 6, to fit the page's outline. A card that is the whole page, such as a sign-in panel, takes `level={1}` and its title is the page's `h1`.
