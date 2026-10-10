---
description: A searchable list of actions and links, opened from the keyboard.
---

<Demo name="command-palette/basic" />

## Entries

`entries` mixes two kinds: an action with an `onSelect`, and a link with an `href`. Both take a `label`, a `group`, an `icon` and `keywords` the search also matches. `groups` sets the order the groups are listed in.

## Opening it

Ctrl or Cmd with `hotkey` (`k` by default) opens and closes the palette from anywhere. Pass `open` and `onOpenChange` to drive it from a button as above, or `hotkey={null}` to leave opening to your app.

<Callout type="tip">

`recent` and `onRecentChange` list the links followed lately on top while the query is empty. Keep the list wherever your app keeps its state.

</Callout>
