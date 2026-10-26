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

- `PageHeader(title)`: the head of a page, its one `h1`. `@meta` sits beside the title, for a badge, a count or a link back, `@actions` after it, past a divider, `description` is a quieter line under the title's, and the children come under that.
- `PageSection(title)`: a titled `section` of a page, its `h2` one level under the page's own, or the heading `level` given, `1` for a section holding a whole page. `@actions` sits at the end of the head line. `subtitle` is a muted line under the title; `sticky` keeps the head at the top of the scrolling area it is in, on one line (the title is cut before the actions), clear of a fixed bar with `--kui-sticky-top`.
- `CollapsibleSection(title)`: a native `details`, so it folds without script. `open` is whether it starts unfolded, `true` by default. It takes no `onOpenChange`, which would make it an island on every page: listen to the native `toggle` event of its `details` in an island of your own. `boxed` draws it as a card whose title is a band over a padded body. `@meta` sits in the band before the chevron, for a count the folded section would hide.
- `Accordion(items)`: CollapsibleSections as one group, `items` listing each `{ value, title, open? }` and `@panel(value)` drawing its body. The sections share a native `details` `name`, so opening one closes the others without script; `multiple` lets several stay open. `boxed` is `true` by default. Arrow, Home and End move between the headers, which makes it an island.
- `Widget(title icon)`: a dashboard tile, a framed body under a head line of icon, title and `@actions`. `isEmpty` swaps the body for the `@empty` block, keeping the frame; with no `@empty` block, an empty widget renders nothing.
- `CardRow`: one line of a list drawn as cards. Children are its body, `@left` leads, `@right` trails, and `@actions` comes last, dimmed until the row is hovered or focused.
- `SidePanel(open title onOpenChange)` (`onOpenChange` is optional with `closeHref`): a modal `dialog` along the edge, driven by `open` like Dialog and named by its title. `@actions` sits in its head before the close button, such as previous and next; `@footer` under its body. A click outside, Escape and its close button all close it through `onOpenChange(false)`; `closeLabel` names that button, `Close` by default. `modal={false}` shows it beside the page instead (`show()`): the page under it stays interactive, a click outside leaves it open, Escape and the close button close it, and it renders open on the server; `dock="right"` or `"bottom"` (with `modal={false}`) makes it a tool panel docked to that edge: fixed beside the dev tool's docked drawer (`--kay-dev-inset-right`, `-bottom`), padding the page's `body` by its size, publishing it as `--kay-panel-right` or `-bottom` and `--kui-dock-right` or `-bottom` on `html`, resized by a grip on its inner edge (a `separator`, drag or arrow keys, Shift for four steps; `resizeLabel`, `Resize`) within what the panel and the page need (280 by 160 px at least, the page keeps 22rem or 10rem tall). `size` (px) and `onSizeChange(size, settled)` let the parent keep it, `settled` false while a drag runs. Only its close control closes a docked panel, not Escape; a fixed header across the top is cleared with `--kui-dock-top` on `html`, its `z-index` with `style`. `launcher="Edit this page"` leaves a button of that label in the window's bottom right corner while a docked panel is closed, off the dev tool's drawer (`--kay-dev-inset-*`), opening it through `onOpenChange(true)` (`launcherLayer` sets its `z-index`, the one thing of it a parent sets: the panel's `style` does not reach it; it names the panel through `aria-controls`, the panel's `id`) and publishing its room as `--kay-panel-right`. `closeHref` makes the close button a link, so a panel driven by the URL closes with no JavaScript; with JavaScript the link navigates and `onOpenChange(false)` is called as well. With `closeHref`, `onOpenChange` is optional: left out, a server page renders the panel with no island of its own, and Escape follows `closeHref` too.
- `Toolbar(label)`: a `role="toolbar"` row of buttons acting on one thing, `label` naming it. `floating` frames it as a card fixed at a point of the window, which `style` places (`left`, `top`) and layers (`z-index`); `caption` is a line of text before the buttons for the eyes only, such as what they act on; `role="group"` for a lone button.
- `SplitLayout`: a list and a detail pane side by side from `md` up, given as `@list` and `@detail`, each with an optional `@listHead` and `@detailHead`. Below `md`, the list and detail are `inert` while the sidebar overlay is open, and a pane that opens (`sidebarOpen` or `detailOpen` turning true) takes focus on its first control, which gets focus back to what had it when the pane closes.
  - `@sidebar` adds a navigation column left of the list, rendered once: below `md` it is an overlay shown while `sidebarOpen` is set, titled `sidebarTitle`, whose back button calls `onSidebarOpenChange(false)` for the parent to set it back to false.
  - Below `md`, `detailOpen` shows the detail pane in the list's place.
  - `resizableList` adds a handle on the list's right edge, a `separator` dragged with the pointer or moved 20px at a time with the arrow keys, between 180px and 560px. `listWidthKey` keeps the width in `localStorage` under that key: the page renders at 260px, then takes the kept width once mounted.
  - It renders inside an island, since its panes are blocks and its handle has handlers.

### CommandPalette

```kay
CommandPalette(entries={[{ label: 'Moons', group: 'Pages', href: '/moons' }, { label: 'New moon', group: 'Actions', icon: 'plus', onSelect: () => creating.set(true) }]} groups={['Actions', 'Pages']} recent={recent()} onRecentChange={keepRecent})
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
- One stop in the tab order. The arrows walk the rows shown, as the ARIA tree pattern has it: Right opens a branch, then goes to its first child, Left closes it, else goes to the branch holding the row, Home and End go to the first and the last, a letter to the next row whose label starts with it. Chords stay the browser's.

## Reference

- The words of these components, their props and the tokens they read are listed in their sections above; a component taking a function or a block with parameters renders as an island, as [Tables, navigation and layout](tables-navigation-and-layout.md) says under Reference.
