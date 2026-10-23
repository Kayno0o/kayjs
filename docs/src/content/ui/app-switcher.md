---
description: A grid button opening tiles that link the sibling apps of a family.
---

<Demo name="app-switcher/basic" />

`AppSwitcher` is for apps on separate hosts that belong together. An IconButton, a grid of dots by default, opens a [Popover](/ui/popover) holding a tile for each app, an icon above its name. It sits at the far end of a header, in [AppHeader](/ui/app-header)'s `@end` block or in one of your own.

## Apps

`apps` is a list of `{ id, href, label, icon, description }`. `current` is the `id` of the app on screen: its tile is marked with `aria-current` and drawn bold with a bar under it, so the mark is not a colour alone. An app with no `icon` shows the first letter of its name. `description` is shown as the tile's tooltip.

## Same tab or a new one

A tile is a real link. It opens in the same tab, even when it leads to another origin, as the apps are one place to the visitor. Set `newTab` on the switcher to open every tile in a new tab, or on one app to open only that one. A tile in a new tab carries `rel="noopener"`, which an app's `rel` replaces.

## Words and icon

`label` names the trigger and the panel, `Apps` unless the `ui.appSwitcher.label` message says otherwise. `icon` replaces the dots on the trigger, and `placement` is `bottom-end` by default.

`@tile(app)` replaces the text under a tile's icon.

## Keyboard

Opening the panel focuses the current tile. The arrow keys move between tiles, three to a row, Home and End jump to the first and last, and Escape closes the panel and gives the focus back to the trigger.
