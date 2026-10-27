---
description: Labels and their values as a definition list, stacking when it is narrow.
---

<Demo name="description-list/basic" />

`items` is a list of `{ label, value }`. The labels share one column, so every value starts at the same place, and the list is a real `dl`, read by screen readers as terms and definitions. `key` tells items apart when two share a label; it is the label by default.

## A rich value

An item with a `value` shows it as text, a number included. An item without one is drawn by the `@value(item)` block, for a badge, a link or a copy button. The block gets the item, so one block can draw several.

## Narrow

Narrower than 24rem, its own width and not the screen's, each label sits above its value, so a list in a sidebar stacks as it does on a phone. Long values wrap instead of widening the list.
