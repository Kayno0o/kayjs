---
description: Nested nodes, such as folders, with branches that open and close and one node selected.
---

<Demo name="tree-view/basic" />

`nodes` holds the tree: each node has an `id`, a `label`, an optional `icon`, and `children` when it is a branch, even an empty one. `selected` marks a node, and a tree whose parent passes another follows it, opening the branches holding it. `expanded` lists the branches open to start with. `onSelect` runs on a click on a row, or Enter or Space on the focused one; the chevron opens or closes its branch alone.

## Keyboard

The tree is one stop in the tab order. The arrows walk the rows shown: Right opens a branch, then goes to its first child, Left closes it, else goes to the branch holding the row, and Home and End go to the first and the last row.
