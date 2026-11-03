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

With `search: true` in `kay.config.ts`, `siteSearch` searches the text of your pages too. A query lists the sections it finds after the entries holding the query, under `siteSearchLabel` (`In the pages`), each with the line it was found in. The words found stand out in the accent colour, in that line and in the heading. When the section holds them again past that line, the row says how many more times, through `siteSearchMore`.

An entry matching only by its characters in order is listed after those sections.

`siteSearch={{ limit: 40 }}` lists more of them than the 20 it lists by default. A section an entry already links to is left out. A page opened from a section marks the words you typed.

If the index fails to load, as under `kay dev`, which writes none, the palette says so with `siteSearchError`. This site's search, behind Ctrl K, is one.

## Searching on the server

`search` lists rows your app looks up itself for the query, such as commits a server finds. It is a function from the query to a promise of entries, links or actions, and an action works as is: `search={async query => (await findCommits(query)).map(commit => ({ label: commit.title, group: 'Commits', href: `/commits/${commit.sha}` }))}`.

It is called once typing pauses, and its rows are listed under `searchLabel` (`Found`) after the entries and the pages found. An answer for an older query is dropped, and a rejection says so with `searchError` (`The search failed`) while the entries stay listed. A followed link is not kept in `recent`.

## Opening it

Cmd on macOS and Ctrl elsewhere with `hotkey` (`k` by default) opens and closes the palette from anywhere. Pass `open` and `onOpenChange` to drive it from a button as above, or `hotkey={null}` to leave opening to your app.

<Demo name="command-palette/hotkey" />

## Recent links

`recent` lists the links followed lately on top while the query is empty, and `onRecentChange` hands the new list over. Keep it wherever your app keeps its state. Open a link below, then open the palette again.

<Demo name="command-palette/recent" />

## Texts

`placeholder` fills the search box, `Search` by default, and `emptyLabel` is what the list says when nothing matches, `No results`. `recentLabel` heads the recent links, `Recent`.

## Attributes

Other attributes, such as a `data-testid`, go on the `dialog` element.

## Size

`size` takes the names of every overlay: `sm`, `md` (the default), `lg` or `full`. Its `md` is 36rem, narrower than the 42rem of a Dialog.
