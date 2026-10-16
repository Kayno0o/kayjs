---
description: Tiles of any height placed in the shortest of several lanes.
---

<Demo name="masonry/basic" />

## Lanes

`minWidth` is the narrowest a lane may get, and as many lanes as fit at that width share the row. `gap` sits between lanes and between tiles. The `@tile(item)` block draws each tile, and its height is whatever its content makes it.

<Demo name="masonry/narrow" />

## Keyed tiles

`key` names an item across updates, so a tile keeps its place and its measured height while the others come and go.

<Demo name="masonry/removable" />

<Callout type="tip">

Tiles are placed absolutely inside the Masonry's box, so put padding on a wrapper, never on the Masonry itself.

</Callout>

## Props

`items` is the list to place, and `key` is required: it returns a string or a number for each item. `style` is added to the Masonry's own box.
