---
description: A searchable list of actions and links, opened from the keyboard.
---

<Demo name="command-palette/basic" />

## Entries

`entries` mixes two kinds: an action with an `onSelect`, and a link with an `href`. Both take a `label`, a `group` and an `icon`. `groups` sets the order the groups are listed in.

## Searching

`keywords` are words the search also matches without showing them, so "csv" finds Export report. Once the query is not empty the groups give way to one ranked list. The arrows walk it, an accent bar marking the row Enter takes.

<Demo name="command-palette/search" />

## Opening it

Ctrl or Cmd with `hotkey` (`k` by default) opens and closes the palette from anywhere. Pass `open` and `onOpenChange` to drive it from a button as above, or `hotkey={null}` to leave opening to your app.

<Demo name="command-palette/hotkey" />

## Recent links

`recent` lists the links followed lately on top while the query is empty, and `onRecentChange` hands the new list over. Keep it wherever your app keeps its state. Open a link below, then open the palette again.

<Demo name="command-palette/recent" />
