---
description: Nested nodes, such as folders, with branches that open and close and one node selected.
---

<Demo name="tree-view/basic" />

`nodes` holds the tree. Each node has an `id`, a `label`, an optional `icon`, and `children` when it is a branch, even an empty one. Ids are strings, or numbers in a `TreeNode<number>[]`.

## Selection

`selected` marks a node. The branches holding it are drawn open from the server's HTML on. A tree whose parent passes another follows it, opening those branches.

`expanded` lists the branches open to start with. `onSelect(id, node)` runs on a click on a row, or Enter or Space on the focused one, with the id `selected` takes, so `onSelect={folder.set}` keeps the pick, and the node. The chevron opens or closes its branch alone.

## Links

A node with an `href` is a real link: a middle click or Ctrl+click opens it in a new tab, and kay's page swap follows a click. The whole row is the link, and the chevron and the row's controls stay clickable on top of it. Enter or Space on the focused row follows it.

Without `selected`, the node whose `href` is the page's address is the selected one, on the server's HTML too, and it follows the page as it changes. A trailing slash and the hash are ignored, and an `href` with a query matches only an address with that query, which wins over an `href` without one. The link of the selected node carries `aria-current="page"`.

<Demo name="tree-view/links" />

## Row controls

A `@trailing(node)` block draws controls at the end of each row, such as a star or a count. They are hidden until the row is hovered or holds focus, and always shown on a touch screen. A click or a key on them never selects the row or moves in the tree.

## Context menu

A node's `menu` lists the entries of its context menu, the ones a `Menu` takes. A right click on the row opens it at the pointer. Shift+F10 or the Menu key opens the focused row's menu under the row. Escape closes it and gives focus back to the row. A node without a `menu` keeps the browser's own.

## Keyboard

The tree is one stop in the tab order. The arrows walk the rows shown: Right opens a branch, then goes to its first child, Left closes it, else goes to the branch holding the row, and Home and End go to the first and the last row. A letter goes to the next row whose label starts with it. A chord, such as Alt+Left going back a page, stays the browser's. A link row follows the same keys: the row is the tab stop and the link inside it stays out of the tab order.
