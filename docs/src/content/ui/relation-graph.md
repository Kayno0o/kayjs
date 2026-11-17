---
description: An item and its neighbours on a ring, joined by lines, each neighbour a link, a button or a muted gap.
---

<Demo name="relation-graph/basic" />

`RelationGraph` draws the item at its `centre` and up to ten of its neighbours around it, such as a note and the notes it links to. Each neighbour of `items` has a `key` and a `label`, and optionally an `href`, a `tone` or `color`, and `missing`. `label` names the whole graph for screen readers.

The neighbours are an `ol` in the order of `items`, so the keyboard and a screen reader reach them in that order, the centre first, whatever their place on the ring: the first is at the top and the rest follow clockwise. `max` is how many are drawn, the first ones of `items`, ten by default.

## Links, buttons and gaps

A neighbour with an `href` is a link. `onSelect({ item })` makes every other neighbour a button, and `selected` marks one by its key with `aria-current`, the app's to move. A neighbour with `missing` is drawn muted with a dashed line and is neither: a link that points nowhere yet. The centre takes an `href` too. `newTab` works as on any link.

<Demo name="relation-graph/select" />

## Colour

`tone` is `neutral` (the default for a neighbour), `accent` (the centre's), `success`, `warning`, `danger` or `info`. `color` takes any CSS colour and replaces it, for the item and its line.

## Data that arrives late

`items` is a list, a promise of one, or a function answering one, such as an action. A promise or a function is asked in the browser: the graph is busy under `loadingLabel`, reads `failureLabel` once it rejected with a button of `retryLabel` to ask a function again, and `onLoad` and `onError` hear each answer. With no neighbour it reads `emptyLabel`, or the `@empty` block.

## Blocks

`@neighbour(item, index)` draws a neighbour's text in place of its `label`, and `@middle(centre)` the centre's. The link or button, the colour and the line stay.

## Parts

`root`, `graph`, `lines`, `line`, `centre`, `list`, `item`, `node` (the neighbour's link, button or text), `label`, `status` and `retry`. `--node-color` is the one private property that an item, its line and its label read, which `class` or `src/ui.ts` can also set.
