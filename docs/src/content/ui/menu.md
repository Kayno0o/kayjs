---
description: An icon button opening a menu of actions.
---

<Demo name="menu/basic" />

## Entries

`items` lists the entries: an object with a `label`, an `onSelect`, an optional `icon` and `danger` for a destructive one, or `'separator'` to draw a rule between groups. `icon` sets the trigger's icon and `label` names it. `onSelect` runs once the menu has closed and focus is back on the trigger.

## Row actions

A menu fits at the end of a row. `disabled` greys an entry out, and the arrows, Home and End move between the enabled ones.

<Demo name="menu/rows" />
