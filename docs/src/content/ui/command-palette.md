---
description: A searchable list of actions and links, opened from the keyboard.
---

<Demo name="command-palette/basic" />

## Entries

`entries` mixes two kinds: an action with an `onSelect`, and a link with an `href`. Both take a `label`, a `group` and an `icon`. `groups` sets the order the groups are listed in. Screen readers hear how many rows a query lists, worded by `resultsLabel(count)`.

## Searching

`keywords` are words the search also matches without showing them, so "csv" finds Export report. Once the query is not empty the groups give way to one ranked list. The arrows walk it, an accent bar marking the row Enter takes.

<Demo name="command-palette/search" />

## Searching the pages

With `search: true` in `kay.config.ts`, `siteSearch` searches the text of your pages too. A query lists the sections it finds after the entries it matches, under `siteSearchLabel` (`In the pages`), each with the line it was found in.

`siteSearch={{ limit: 40 }}` lists more of them than the 20 it lists by default. A section an entry already links to is left out.

If the index fails to load, as under `kay dev`, which writes none, the palette says so with `siteSearchError`. This site's search, behind Ctrl K, is one.

## Opening it

Cmd on macOS and Ctrl elsewhere with `hotkey` (`k` by default) opens and closes the palette from anywhere. Pass `open` and `onOpenChange` to drive it from a button as above, or `hotkey={null}` to leave opening to your app.

<Demo name="command-palette/hotkey" />

## Recent links

`recent` lists the links followed lately on top while the query is empty, and `onRecentChange` hands the new list over. Keep it wherever your app keeps its state. Open a link below, then open the palette again.

<Demo name="command-palette/recent" />

## Texts

`placeholder` fills the search box, `Search` by default, and `emptyLabel` is what the list says when nothing matches, `No results`.
