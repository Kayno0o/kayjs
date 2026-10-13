---
description: Nested nodes, such as folders, with branches that open and close and one node selected.
---

<Demo name="tree-view/basic" />

`nodes` holds the tree: each node has an `id`, a `label`, an optional `icon`, and `children` when it is a branch, even an empty one. Ids are strings, or numbers in a `TreeNode<number>[]`. `selected` marks a node, drawn with the branches holding it open from the server's HTML on, and a tree whose parent passes another follows it, opening those branches. `expanded` lists the branches open to start with. `onSelect` runs on a click on a row, or Enter or Space on the focused one; the chevron opens or closes its branch alone.

## Keyboard

The tree is one stop in the tab order. The arrows walk the rows shown: Right opens a branch, then goes to its first child, Left closes it, else goes to the branch holding the row, and Home and End go to the first and the last row. A letter goes to the next row whose label starts with it. A chord, such as Alt+Left going back a page, stays the browser's.
