---
description: Tiles of any height placed in the shortest of several lanes.
---

<Demo name="masonry/basic" />

## Lanes

`minWidth` is the narrowest a lane may get, and as many lanes as fit at that width share the row. `gap` sits between lanes and between tiles. `key` names an item across updates so its tile keeps its place, and the `@tile(item)` block draws each tile.

<Callout type="tip">

Tiles are placed absolutely inside the Masonry's box, so put padding on a wrapper, never on the Masonry itself.

</Callout>
