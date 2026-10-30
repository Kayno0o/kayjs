# kayjs-ui: Page layout, command palette and trees

## Common tasks

### PageHeader, PageSection, CollapsibleSection, Accordion, Widget, CardRow, SidePanel, Toolbar, SplitLayout

```kay
PageSection(title="Moons")
  @actions
    a(href="/moons/new") New moon
  CollapsibleSection(title="Archived" open={false} boxed)
    @meta
      Badge(label={archived.length})
    for moon of archived
      CardRow
        @left
          Icon(icon="success")
        @right
          span {moon.radius} km
        @actions
          a(href={`/moons/${moon.id}`}) Edit
        | {moon.name}
```

- `PageHeader(title)`: the head of a page, its one `h1`. `@meta` sits beside the title, for a badge, a count or a link back, `@actions` after it, past a divider, `description` is a quieter line under the title's, and the children come under that. A long word with no space, such as an image reference or a digest, breaks in the title and the description instead of widening a phone's page, as it does in `Card`, `Notice` and `Table` cells, so an app adds no `wrap-anywhere`.
- `PageSection(title)`: a titled `section` of a page, its `h2` one level under the page's own, or the heading `level` given, `1` for a section holding a whole page. `@actions` sits at the end of the head line. `subtitle` is a muted line under the title; `sticky` keeps the head at the top of the scrolling area it is in, on one line (the title is cut before the actions), clear of a fixed bar with `--kui-sticky-top`.
- `CollapsibleSection(title)`: a native `details`, so it folds without script. `open` is whether it starts unfolded, `true` by default. It takes no `onOpenChange`, which would make it an island on every page: listen to the native `toggle` event of its `details` in an island of your own. `boxed` draws it as a card whose title is a band over a padded body. `@meta` sits in the band before the chevron, for a count the folded section would hide.
- `Accordion(items)`: CollapsibleSections as one group, `items` listing each `{ value, title, open? }` and `@panel(value)` drawing its body. The sections share a native `details` `name`, so opening one closes the others without script; `multiple` lets several stay open. `boxed` is `true` by default. Arrow, Home and End move between the headers, which makes it an island.
- `Widget(title icon)`: a dashboard tile, a framed body under a head line of icon, title and `@actions`. `isEmpty` swaps the body for the `@empty` block, keeping the frame; with no `@empty` block, an empty widget renders nothing.
- `CardRow`: one line of a list drawn as cards. Children are its body, `@left` leads, `@right` trails, and `@actions` comes last, dimmed until the row is hovered or focused.
- `SidePanel(open title onOpenChange)` (`onOpenChange` is optional with `closeHref`): a modal `dialog` along the edge, driven by `open` like Dialog and named by its title. `@actions` sits in its head before the close button, such as previous and next; `@footer` under its body. A click outside, Escape and its close button all close it through `onOpenChange(false)`; `closeLabel` names that button, `Close` by default. `modal={false}` shows it beside the page instead (`show()`): the page under it stays interactive, a click outside leaves it open, Escape and the close button close it, and it renders open on the server; `dock="right"` or `"bottom"` (with `modal={false}`) makes it a tool panel docked to that edge: fixed beside the dev tool's docked drawer (`--kay-dev-inset-right`, `-bottom`), padding the page's `body` by its size, publishing it as `--kay-panel-right` or `-bottom` and `--kui-dock-right` or `-bottom` on `html`, resized by a grip on its inner edge (a `separator`, drag or arrow keys, Shift for four steps; `resizeLabel`, `Resize`) within what the panel and the page need (280 by 160 px at least, the page keeps 22rem or 10rem tall). `size` (px) and `onSizeChange(size, settled)` let the parent keep it, `settled` false while a drag runs; `sizeKey="pane"` keeps it with no handler, in a `persisted` cookie of that name the server reads, so the saved width is drawn from the first paint (a `size` given wins over it). SplitLayout's `listWidthKey` does the same for its list. `scrollKey` (a string or number) brings the body back to the top whenever it changes, for a panel kept in place by a `persist` island whose content changes under it (`scrollKey={commit.sha}`); a kept island keeps the scroll of every element inside it. Only its close control closes a docked panel, not Escape; a fixed header across the top is cleared with `--kui-dock-top` on `html`, its `z-index` with `style`. `launcher="Edit this page"` leaves a button of that label in the window's bottom right corner while a docked panel is closed, off the dev tool's drawer (`--kay-dev-inset-*`), opening it through `onOpenChange(true)` (`launcherLayer` sets its `z-index`, the one thing of it a parent sets: the panel's `style` does not reach it; it names the panel through `aria-controls`, the panel's `id`) and publishing its room as `--kay-panel-right`. `closeHref` makes the close button a link, so a panel driven by the URL closes with no JavaScript; with JavaScript the link navigates and `onOpenChange(false)` is called as well. With `closeHref`, `onOpenChange` is optional: left out, a server page renders the panel with no island of its own, and Escape follows `closeHref` too; its `launcher` then needs a `launcherHref` (types refuse one without), which makes the launcher a link to that URL, also allowed beside an `onOpenChange`, which is called too.
- `Toolbar(label)`: a `role="toolbar"` row of buttons acting on one thing, `label` naming it. `floating` frames it as a card fixed at a point of the window, which `style` places (`left`, `top`) and layers (`z-index`); `caption` is a line of text before the buttons for the eyes only, such as what they act on; `role="group"` for a lone button.
- `SplitLayout`: a list and a detail pane side by side from `md` up, given as `@list` and `@detail`, each with an optional `@listHead` and `@detailHead`. Below `md`, the list and detail are `inert` while the sidebar overlay is open, and a pane that opens (`sidebarOpen` or `detailOpen` turning true) takes focus on its first control, which gets focus back to what had it when the pane closes.
  - `@sidebar` adds a navigation column left of the list, rendered once: below `md` it is an overlay shown while `sidebarOpen` is set, titled `sidebarTitle`, whose back button calls `onSidebarOpenChange(false)` for the parent to set it back to false.
  - Below `md`, `detailOpen` shows the detail pane in the list's place.
  - `resizableList` adds a handle on the list's right edge, a `separator` dragged with the pointer or moved 20px at a time with the arrow keys, between 180px and 560px. `listWidthKey` keeps the width in a `persisted` cookie of that name, written when a drag or key press settles, which the server reads: the page is drawn at the kept width from the first paint, 260px otherwise. A width an earlier version kept in `localStorage` under the same key moves to the cookie once.
  - It renders inside an island, since its panes are blocks and its handle has handlers.

### CommandPalette

```kay
CommandPalette(entries={[{ label: 'Moons', group: 'Pages', href: '/moons' }, { label: 'New moon', group: 'Actions', icon: 'plus', onSelect: () => creating = true }]} groups={['Actions', 'Pages']} recent={recent()} onRecentChange={keepRecent})
```

- A modal search over places to go and things to do, opened and closed by Cmd on macOS and Ctrl elsewhere with `hotkey` (`k` by default) from anywhere, unless something handled the key first; `hotkey={null}` leaves opening to the app through `open`, and `onOpenChange(open)` reports each change.
- An entry has a `label`, a `group` it is listed under, an optional `icon`, and `keywords` a query matches without showing them. A `PaletteLink` has an `href`, followed in place or in a new tab with Ctrl or Cmd held, or always with `external`; a `PaletteAction` has an `onSelect`, run once the palette has closed.
- With no query, entries are listed under their groups in `groups` order, the rest after them, below the links of `recent` that still exist; following a link hands the new list to `onRecentChange(recent)`, for the app to keep.
- A query ranks the matches in one list: a label starting with it, then a label holding it, then its group or keywords, then its characters in order. The arrows walk it, wrapping, an accent bar marking the highlighted row, and Enter takes it.
- `siteSearch` searches the text of the pages too, as kay indexes them under `search: true`: a query lists the sections it finds, `{ limit }` of them, after the entries it matches, under `siteSearchLabel` (`In the pages`), each with the lines it was found in, the words found marked in the accent colour there and in its heading, then how many more its text holds (`siteSearchMore(count)`, `2 more matches`), leaving out a section an entry already links to, and listing an entry that matches by its characters in order alone after them; a followed section's page marks the words typed (kay's `?kay_q=`, which the dedupe ignores); a followed section is not kept in `recent`, and an index that fails to load shows `siteSearchError`. It is read once, as the palette is set up.
- `label` and `placeholder` (`Search`) and `emptyLabel` (`No results`) are its words; screen readers hear how many rows a query lists from a status region, worded by `resultsLabel(count)`. It renders inside an island, since actions are functions.

### Bell

```kay
---
import Bell from '@kaynooo/kayjs-ui/bell.kay'
---
header
  Bell
```

- An icon button with the unread count of the signed-in visitor's in-app notifications and a menu listing the newest 20, stored by `notify(userId, { title, url })` from `kay/server` ([Notifications](../../../llms/notifications.md)). Opening an item marks it read and follows its link; "Mark all as read" marks the rest. It shows nothing to a visitor nobody is signed in as, and updates in every open tab, announcing a notification that arrives while the page is open.
- The visitor is the user the auth library names (kayjs-auth does), read on the server: `Bell` has no `user` prop. A page with a `Bell` is private and rendered per request, and `ui()` serves its `GET /_kay/ui/inbox` and `POST /_kay/ui/inbox/read`.
- `label` (`Notifications`) names the button and `placement` is the menu's, as `Menu` takes it. The `bell` icon slot maps its icon ([Setup](setup.md)); `ui.bell.*` are its words ([Words](words.md)).
- A title is text and a link is drawn only for a path of the site or an http(s) URL; an external one opens in a new tab.

### TreeView

```kay
TreeView(nodes={[{ id: 'work', label: 'Work', children: [{ id: 'specs', label: 'Specs' }] }, { id: 'inbox', label: 'Inbox', icon: 'info' }]} label="Folders" selected={folder()} onSelect={folder.set})
```

- Nested nodes, such as folders: a `TreeNode` (from the package) has an `id`, a `label`, an optional `icon`, and `children` when it is a branch, even an empty one; ids are strings, or numbers in a `TreeNode<number>[]`. `label` names the tree for screen readers.
- `selected` marks a node, drawn with the branches holding it open from the server's HTML on, and a tree whose parent passes another follows it, opening those branches; `expanded` lists the branches open to start with. `onSelect(id, node)` runs, with the id `selected` takes and the node picked, on a click on a row, or Enter or Space on the focused one, and the chevron opens or closes its branch alone.
- `href` on a node makes its row a real link (new tab, page swap), the whole row stretched over by the anchor with the chevron and the controls above it; Enter or Space on the focused row follows it. With no `selected`, the node whose `href` is the page's address (path, trailing slash and hash ignored; a query in the `href` must match and wins over an `href` without one) is the selected one, server HTML included, following the page as it changes, and its link has `aria-current="page"`. A page rendered once at build time has no address to follow, so pass `selected` there. The page's address is compared as the app wrote the `href`, so on a site with a locale prefix pass `selected`.
- `@trailing(node)` draws a block at the end of each row, such as a star or a count, hidden until the row is hovered or holds focus and always shown with a coarse pointer (parts `trailing`, `link`); a click or key inside it never selects the row nor moves in the tree.
- `menu` on a node is its context menu, `MenuEntry[]` as `Menu`'s `items` and named by the node's label: a right click opens it at the pointer, Shift+F10 and the Menu key under the focused row, and focus returns to the row on close. A node without one keeps the browser's menu.
- One stop in the tab order (a link row's anchor is out of it). The arrows walk the rows shown, as the ARIA tree pattern has it: Right opens a branch, then goes to its first child, Left closes it, else goes to the branch holding the row, Home and End go to the first and the last, a letter to the next row whose label starts with it. Chords stay the browser's.

### Timeline

```kay
Timeline(entries={[{ key: 'home', time: '08:00 - 09:10', text: 'At home', icon: 'info' }, { key: 'gap', time: '09:10 - 09:40', text: 'No data', tone: 'muted', pickable: false }]} label="Today" selected={picked()} onSelect={picked.set})
```

- Entries in time order, as given (the timeline never sorts): a `TimelineEntry` (from the package) has a `key`, a `time` (the time or range as the app words it), a `text`, an optional `icon` and `tone`, and `pickable`. `tone="muted"` greys a gap; `accent`, `success`, `warning`, `danger` and `info` colour the icon. `label` names the list for screen readers.
- With `onSelect` or `selected` every entry is a button marked `aria-pressed`, one picked at a time, reachable with Tab; pressing the picked one again clears it. `selected` is the bindable key, a new one from the parent is followed, and `onSelect(key, entry)` gets the key as `selected` takes it (`undefined` when cleared), so `onSelect={picked.set}` round-trips. `pickable: false` keeps an entry plain text. Hover, picked and muted looks follow the theme and every skin; the parts are `root`, `item`, `entry`, `time`, `icon` and `text` ([Restyle a component](restyle.md)).

### DescriptionList

```kay
DescriptionList(items={[{ label: 'Host', value: 'relay.example.com' }, { label: 'State' }]})
  @value(item)
    Badge(label="Healthy" tone="success")
```

- A `dl` of label and value pairs: `items` are `DescriptionItem`s (from the package), a `label`, a `value` (text or a number) and an optional `key` (the label by default). The labels share one column, so the values line up.
- An item with no `value` is drawn by the `@value(item)` block, for a badge, a link or a copy button, and as a dash when there is no block either; one with a `value` shows it as text. Using the block makes the list an island.
- Narrower than 24rem, its own width and not the screen's, each label sits above its value. Parts: `root`, `item`, `term` and `detail`.

## Reference

- The words of these components, their props and the tokens they read are listed in their sections above; a component taking a function or a block with parameters renders as an island, as [Tables, navigation and layout](tables-navigation-and-layout.md) says under Reference.
