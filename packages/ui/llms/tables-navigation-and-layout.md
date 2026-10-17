# kayjs-ui: Tables, tabs, pagination, page layout, command palette and trees

## Components

### Table

```ts
import type { Column } from '@kaynooo/kayjs-ui'

const columns: Column<Post>[] = [
  { key: 'title', header: 'Title', sortValue: true },
  { key: 'views', header: 'Views', numeric: true },
  { key: 'author', header: 'Author', cell: false },
]
```

```kay
Table(columns={columns} rows={posts} rowKey="id" filter={['title', 'author']} filterParam="q")
  @cell(post, column)
    if column.key === 'title'
      a(href={`/posts/${post.id}`}) {post.title}
    else
      | {post.views.toLocaleString()}
  @empty
    EmptyState(title="No posts yet")
  @noMatch
    EmptyState(title="No post matches")
```

- With a `@cell(row, column)` block, every column shows what it draws, but one with `cell: false`, which shows the row's value at `key` as text, as every column does without the block. A table where any column sets `cell: true` draws only those through the block.
- `numeric: true` marks a count or an amount: aligned to the end, its digits in columns, sorted by its own value and largest first, each overridable by `align`, `sortValue` and `defaultDirection`.
- A column with `sortValue` sorts when its header is clicked. `true` sorts by the row's value at `key`; a function sorts by what it returns.
- The first click sorts in `defaultDirection`, `desc` unless set, and the next click flips it. `sort` gives the sort to start from.
- `serverSort` leaves the rows in the order they came. The headers show the sort, and `onSort(sort)` lets the page fetch the rows sorted that way, from a load or an action.
- With `sortValue: true`, dates sort by time, booleans as 0 and 1, and a missing value sorts last in either direction.
- `rowKey` is a field of the row or a function of it, and tells rows apart across a sort.
- `filter` shows a search box above the rows, `filterLabel` (`Filter`) naming it, and keeps the rows where a value it reads holds the typed text, case and surrounding spaces ignored: the fields it names, or what a function of the row returns, `filter={post => [post.title, post.author.name]}`. `filterParam="q"` keeps the text in the page's URL as `?q=`, which the server reads too, so a reload or a shared link renders filtered. Screen readers hear how many rows the typed text keeps from a status region, worded by `countLabel(count)`. `@noMatch` shows when the filter hides every row, `@empty` when there are none.
- Narrower than 30rem, its own width and not the screen's, so a table in a sidebar does it too, each row stacks as a card: a line per cell, its column `header` beside it as the label, the labels as wide as the longest up to 40% of the card, every value starting right after its label whatever its column's `align`, which a wide table keeps, and only the sortable headers kept, as a row of sort buttons. A column with an empty `header` spans the card's width. `narrow="scroll"` keeps the table whole and scrolls it sideways instead. A stacking table's wrapper is a size container, so it takes its width from its parent and never from its content: in an `auto`-sized grid column it collapses, where `narrow="scroll"` does not.
- `selectable` puts a checkbox on each row and, above the rows, a select-all box (ticked, indeterminate or not) with `N selected` beside it, a status screen readers hear, once rows are picked, outside the table so stacked cards have it too. `selected={keys}` gives the keys to start from (a new list from the parent is followed) and `onSelect(keys)` hears every change, the keys in the rows' order. A key whose row is no longer in `rows` leaves the selection, `onSelect` told, so a reload or an infinite list's new rows never keep a ghost; select-all acts on the rows the filter shows and leaves hidden ones as they are. `@bulk(keys, clear)` draws the page's bulk actions beside the count while something is picked, `clear()` emptying the selection: `Table(columns={columns} rows={sites} rowKey="name" selectable)` then `@bulk(names, clear)` holding `Button(label="Disable" onClick={async () => { await disable(names); clear() }})`. Row boxes are named `Select <first column's text>`; `selectAllLabel` (`Select all`, also the column's header for screen readers), `selectedLabel(count)` (`{n} selected`) and `selectRowLabel(row)` replace the words.

### Segmented, ChipGroup, TabNav, SiteNav, Tabs, Toggle, Checkbox

```kay
Tabs(tabs={[{ value: 'details', label: 'Details' }, { value: 'reviews', label: 'Reviews' }]} value="details" label="Product")
  @panel(tab)
    if tab === 'details'
      ProductDetails(product={product})
    else
      Reviews(product={product})
```

- `Segmented(options={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }]} value="day" label="Period" name="period" onChange={period.set})`: real radios, so arrow keys move between options and the group posts as `name` inside a form. An option may carry an `icon` and be `disabled`, as ChipGroup's and Tabs' do. A parent passing another `value` moves the choice, and `null` picks none, for a state matching no option, such as a zoomed range beside a period picker; a reset to none tells `onChange` `null`, typed only when `value` is typed nullable. Without `name`, the group draws one unique on the page, which keeps two groups apart. A pick made while a change is busy takes nothing, and a refused change is put back: the check goes back and keyboard focus moves to the checked radio with it.
  - `onChange` may return a promise, as Toggle's may: the group is `aria-busy` and takes no other pick until it settles, and goes back to the previous option when it resolves to `false`, rejects or throws (logged), unless the parent set `value` meanwhile.
- `TabNav(links={[{ href: '/settings', label: 'Profile' }, { href: '/settings/keys', label: 'Keys' }]} current={ctx.url.pathname} label="Settings")`: tabs as links, one page each. The current tab is marked `aria-current="page"`, and a bar too narrow for every tab scrolls to centre it, without moving the page. `current={ctx.url}` with `keep={['period', 'site']}` carries those params of the page's URL onto each link that does not set them itself, for tabs sharing filters; a URL `current` marks the link whose path matches and whose own params the URL holds.
- `SiteNav(links={[{ href: '/', label: 'Home' }, { href: '/rooms', label: 'Rooms' }]} current={ctx.url.pathname} label="Main" menuLabel="Menu")`: a site's main links, in a row from the `lg` breakpoint and folded behind a menu toggle below it, which closes on Escape, a followed link or a press outside.
  - The page on screen is marked `aria-current="page"`, and a link to a section holding it `aria-current="true"`, as `/rooms` for `/rooms/blue`; `/` only marks itself.
  - The menu closes as a link is followed, on Escape, which hands the focus back to the toggle, and once `current` changes, as for a `persist` island kept from page to page.
  - It takes data alone, so a static layout holds it, with the logo and any call to action beside it in the app's own header.
- `Tabs`: panels that switch in place, without navigating, each tab `{ value, label, icon?, disabled? }`, the arrow keys going past a disabled one, for settings or a product's details; use TabNav when each tab is a page of its own.
  - A `tablist` of buttons, each paired with its `tabpanel` through ids drawn with `uid()`. `@panel(tab)` draws each tab's panel once, hidden while another tab shows, so what a panel holds survives a switch.
  - A click, or the arrows (wrapping), Home and End, show a tab and focus it; only the shown tab is in the page's tab order. `onChange(value)` runs on each switch, and a parent passing another `value` shows that tab.
  - A panel not shown is `hidden="until-found"`, so the browser's find in page or a link to an id inside it shows its tab, and so does kay's `focusInvalid`: after a refused save, `focusInvalid(form)` shows the tab holding the first field marked `aria-invalid` and focuses it, with no work out of which tab that is.
  - It renders inside an island, since its panels come from a block.
- `Toggle(label="Public" checked={post.public} name="public" onChange={setPublic})`: a checkbox drawn as a switch, with `role="switch"`, that posts like a checkbox. Without `label`, give it `aria-label`.
  - `onChange` may return a promise: the switch is `aria-busy` and flips no further until it settles, and goes back where it was when it resolves to `false`, rejects or throws (logged), unless the parent set `checked` meanwhile. A void answer leaves the switch as clicked. The switch jumping back is all the user sees, so toast the failure too. `attempt` resolves to `undefined` on failure, so turn that into `false`: `onChange={async checked => (await attempt(() => setPublic({ id, public: checked }), 'Could not publish')) ?? false}`.
- `Checkbox(label="I agree" checked={agreed()} name="terms" onChange={agreed.set})`: a native checkbox and its label, posting like one. `hint` adds a quieter note after the label, and `indeterminate` draws it as neither ticked nor not, for a box over a partly ticked list: a click toggles it from `checked`, and it is drawn so again while the parent keeps `indeterminate`. Without `label`, give it `aria-label`. `onChange` may return a promise, as Toggle's may. Use Toggle for a setting that applies as it is flipped.
- `ChipGroup(options={[{ value: 'films', label: 'Films' }, { value: 'games', label: 'Games', icon: 'star' }]} value={decks()} label="Decks" name="decks" onChange={decks.set})`: chips to pick several options from, real checkboxes posting each picked option under `name` (one unique on the page without it). `onChange` gets every picked option in the order of `options`, and may return a promise, as Segmented's may. An option may be `disabled`. A parent passing another `value` moves the picks.

### Pagination, QrCode

- `Pagination(page={page} pages={pages} url={ctx.url})`: links to the pages of a list through the URL's query, so it renders on the server with no island and each page has a URL of its own.
  - Each link keeps `url`'s path and query, `param`, `page` by default, set to its page and left out for the first one. Read the page in a server fence: `const page = Number(ctx.url.searchParams.get('page') ?? 1)`. A page past the ends, or no whole number, such as `?page=abc`, shows as the nearest that exists, so clamp it the same way where the page's own query reads it.
  - It shows the first and last pages and `siblings` on each side of the current one, 1 by default, an ellipsis for those left out, or the page itself when only one would be. The current page is marked `aria-current="page"`; Previous and Next are links with `rel="prev"` and `rel="next"`, and plain text at the ends. With one page or none it draws nothing.
  - `label` (`Pagination`), `previousLabel` and `nextLabel` replace its words.
- A list whose length is unknown, which fetches one row past the page to know whether another follows, passes `more` in place of `pages`, and gets Previous and Next alone, Next a link while `more` is true: `Pagination(page={page} more={next !== null} url={ctx.url})`, or by offset, `Pagination(offset={offset} limit={20} more={next !== null} url={ctx.url})`, which steps `?offset=` by `limit`, `param` then being `offset` by default. With no step to link, it draws nothing.
- `Pagination(of={list})`: the same links for a page kay's `paginate()` from `kay/content` gave, `const list = await blog.page(ctx.params.page) ?? ctx.notFound()` in a `blog/[[page=integer]].kay` route, each page at its own path, `/blog`, `/blog/2`, rather than through the query. `of` takes any `{ page, pages, href(n) }`.
- `QrCode(value={shareUrl} label="Scan to open the list" size={160})`: the value as a QR code, an SVG image drawn where the page renders, on the server for a static page. `label` is its `alt`, and may be left out for a decorative code, which is then hidden from assistive technology. Without `size` it takes the width CSS gives it.
  - `inline` draws the SVG in the page instead of an image, so the colours in `options` may be CSS ones and follow the page: `QrCode(value={url} inline options={{ foreground: 'currentColor', eyeColor: 'var(--color-accent)', background: null }})`. A `label` then makes it `role="img"`; `size` sets the box's width and height.
  - It keeps dark modules on a light ground with a quiet zone, which every scanner reads, whatever the theme. `options` takes what `qrCodeSvg` from @kaynooo/utils does, `ecc`, `moduleShape`, `eyeColor`, `foreground`, `background`, `margin` and the rest, its colours written out since the image cannot read the page's CSS, unless it is `inline`.

### PageHeader, PageSection, CollapsibleSection, Widget, CardRow, SidePanel, SplitLayout

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
- `PageSection(title)`: a titled `section` of a page, its `h2` one level under the page's own, or the heading `level` given, `1` for a section holding a whole page. `@actions` sits at the end of the head line.
- `CollapsibleSection(title)`: a native `details`, so it folds without script. `open` is whether it starts unfolded, `true` by default. It takes no `onOpenChange`, which would make it an island on every page: listen to the native `toggle` event of its `details` in an island of your own. `boxed` draws it as a card whose title is a band over a padded body. `@meta` sits in the band before the chevron, for a count the folded section would hide.
- `Widget(title icon)`: a dashboard tile, a framed body under a head line of icon, title and `@actions`. `isEmpty` swaps the body for the `@empty` block, keeping the frame; with no `@empty` block, an empty widget renders nothing.
- `CardRow`: one line of a list drawn as cards. Children are its body, `@left` leads, `@right` trails, and `@actions` comes last, dimmed until the row is hovered or focused.
- `SidePanel(open title onOpenChange)`: a modal `dialog` along the edge, driven by `open` like Dialog and named by its title. `@actions` sits in its head before the close button, such as previous and next; `@footer` under its body. A click outside, Escape and its close button all close it through `onOpenChange(false)` (`onClose` is the deprecated name); `closeLabel` names that button, `Close` by default.
- `SplitLayout`: a list and a detail pane side by side from `md` up, given as `@list` and `@detail`, each with an optional `@listHead` and `@detailHead`.
  - `@sidebar` adds a navigation column left of the list, rendered once: below `md` it is an overlay shown while `sidebarOpen` is set, titled `sidebarTitle`, whose back button calls `onSidebarClose` for the parent to set it back to false.
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
- `siteSearch` searches the text of the pages too, as kay indexes them under `search: true`: a query lists the sections it finds, `{ limit }` of them, after the entries it matches, under `siteSearchLabel` (`In the pages`), each with the lines it was found in, the words found marked in the accent colour there and in its heading, then how many more its text holds (`siteSearchMore(count)`, `2 more matches`), leaving out a section an entry already links to; a followed section is not kept in `recent`, and an index that fails to load shows `siteSearchError`. It is read once, as the palette is set up.
- `label` and `placeholder` (`Search`) and `emptyLabel` (`No results`) are its words; screen readers hear how many rows a query lists from a status region, worded by `resultsLabel(count)`. It renders inside an island, since actions are functions.

### TreeView

```kay
TreeView(nodes={[{ id: 'work', label: 'Work', children: [{ id: 'specs', label: 'Specs' }] }, { id: 'inbox', label: 'Inbox', icon: 'info' }]} label="Folders" selected={folder()} onSelect={folder.set})
```

- Nested nodes, such as folders: a `TreeNode` (from the package) has an `id`, a `label`, an optional `icon`, and `children` when it is a branch, even an empty one; ids are strings, or numbers in a `TreeNode<number>[]`. `label` names the tree for screen readers.
- `selected` marks a node, drawn with the branches holding it open from the server's HTML on, and a tree whose parent passes another follows it, opening those branches; `expanded` lists the branches open to start with. `onSelect(id)` runs on a click on a row, or Enter or Space on the focused one, and the chevron opens or closes its branch alone.
- One stop in the tab order. The arrows walk the rows shown, as the ARIA tree pattern has it: Right opens a branch, then goes to its first child, Left closes it, else goes to the branch holding the row, Home and End go to the first and the last, a letter to the next row whose label starts with it. Chords stay the browser's.
