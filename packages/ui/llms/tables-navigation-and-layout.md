# kayjs-ui: Tables, tabs and pagination

## Common tasks

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
- `selectable` puts a checkbox on each row and, above the rows, a select-all box (ticked, indeterminate or not) with `N selected` beside it, a status screen readers hear, once rows are picked, outside the table so stacked cards have it too. `selected={keys}` gives the keys to start from (a new list from the parent is followed) and `onSelect(keys)` hears every change, the keys in the rows' order. A key whose row is no longer in `rows` leaves the selection, `onSelect` told, so a reload or an infinite list's new rows never keep a ghost; select-all acts on the rows the filter shows and leaves hidden ones as they are. The keys (and `selected`, `onSelect`) have the type of the `rowKey` field or function result, so a `string[]` parameter takes them with no cast. `@bulk(keys, clear)` draws the page's bulk actions beside the count while something is picked, `clear()` emptying the selection: `Table(columns={columns} rows={sites} rowKey="name" selectable)` then `@bulk(names, clear)` holding `Button(label="Disable" onClick={async () => { await disable(names); clear() }})`. Row boxes are named `Select <first column's text>`; `selectAllLabel` (`Select all`, also the column's header for screen readers), `selectedLabel(count)` (`{n} selected`) and `selectRowLabel(row)` replace the words.
- `exportable` puts an `Export CSV` button above the rows (`exportLabel` words it, `exportName` is the file, `table.csv` by default) that downloads the rows as they are on screen: the filter applied and the sort on screen, one column each with the headers on top and the row's own value at the column's `key`, whatever a `@cell` block draws. A value starting a formula (`=`, `+`, `-`, `@`, a tab or a carriage return) gets a leading apostrophe so a spreadsheet reads text, a number is left alone, and the file is UTF-8 with a byte order mark.
  - For rows the page holds only a part of, give a string: `Table(exportable="/orders.csv" filterParam="q")` links that address, with the sort as `sort` and `direction` and the typed text under `filterParam` (`q` without one). The endpoint reads them and answers with `new Response(toCsv(rows, columns), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="orders.csv"' } })`; `toCsv(rows, columns)` comes from the package.
- `virtual` draws only the rows in view, between two spacer rows standing for the others, so a table of ten thousand rows and more stays light. The table scrolls in a box of its own, 70vh tall unless `--kui-table-height` says otherwise, headers kept on top; rows start at an estimated 48px and take the height they measure (stacked cards included). The table is `aria-rowcount` and each row `aria-rowindex`, so a screen reader hears the real position. Filtering, sorting, selection and the CSV export work on all the rows. It is decided once, when the table is made; the server draws the first screenful only, and an `aria-label` names the scroll box. The box takes the focus to scroll by keyboard (arrows, Page Up and Down, Home, End); find-in-page sees the drawn rows alone, and a focused control in a row that scrolls out of the window loses its focus, so keep a filter for finding a row.

### Segmented, ChipGroup, TabNav, Breadcrumb, SiteNav, AppHeader, Tabs, Toggle, Checkbox

```kay
Tabs(tabs={[{ value: 'details', label: 'Details' }, { value: 'reviews', label: 'Reviews' }]} value="details" label="Product")
  @panel(tab)
    if tab === 'details'
      ProductDetails(product={product})
    else
      Reviews(product={product})
```

- `Segmented(options={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }]} value="day" label="Period" name="period" onChange={period.set})`: real radios, so arrow keys move between options (`orientation="vertical"` stacks them in a column) and the group posts as `name` inside a form. `disabled` on the group disables every option, and an option's own `disabled` applies without it. An option may carry an `icon` and be `disabled`, as ChipGroup's and Tabs' do. A parent passing another `value` moves the choice, and `null` picks none, for a state matching no option, such as a zoomed range beside a period picker; a reset to none tells `onChange` `null`, typed only when `value` is typed nullable. Without `name`, the group draws one unique on the page, which keeps two groups apart. A pick made while a change is busy takes nothing, and a refused change is put back: the check goes back and keyboard focus moves to the checked radio with it. Option values may be numbers: `Segmented(options={[{ value: 10, label: '10' }, { value: 25, label: '25' }]} value={size()} label="Round size" onChange={size.set})` hears `10`, not `'10'`, and `0` is a value like any other.
  - `onChange` may return a promise, as Toggle's may: the group is `aria-busy` and takes no other pick until it settles, and goes back to the previous option when it resolves to `false`, rejects or throws (logged), unless the parent set `value` meanwhile.
- `TabNav(links={[{ href: '/settings', label: 'Profile' }, { href: '/settings/keys', label: 'Keys' }]} current={pathname} label="Settings")`: tabs as links, one page each. The current tab is marked `aria-current="page"`, and a bar too narrow for every tab scrolls to centre it, without moving the page. Following a tab keeps the window where it was, as `data-keep-scroll` does (so an app needs none on the bar), except a link to a `#section`, which scrolls to it; going back restores the saved position. `current={url}` with `keep={['period', 'site']}` carries those params of the page's URL onto each link that does not set them itself, for tabs sharing filters; a URL `current` marks the link whose path matches and whose own params the URL holds. `pathname` and `url` come from `ctx.url`, read in the fence.
- `SiteNav(links={[{ href: '/', label: 'Home' }, { href: '/rooms', label: 'Rooms' }]} current={pathname} label="Main" menuLabel="Menu")`: a site's main links, in a row from the `lg` breakpoint and folded behind a menu toggle below it, a popover the browser opens and closes (Escape, a press outside, the focus handed back), so it ships no JavaScript.
  - The page on screen is marked `aria-current="page"`, and a link to a section holding it `aria-current="true"`, as `/rooms` for `/rooms/blue`; `/` only marks itself.
  - The toggle is a `popovertarget` button and the list a `popover`: the browser opens it, closes it on Escape or a press outside, gives the focus back, and exposes `aria-expanded` itself, and a page swap closes one left open. A link to a `#section` of the page leaves the menu open until a press outside or Escape.
  - It needs the Popover API (Chrome and Edge 114, Firefox 125, Safari 17); in an older browser the links show as a plain list and the toggle is hidden. The list sits under the toggle through CSS anchor positioning, as for `Popover`.
  - It is a static component, so a layout holds it and a page of it ships no island. It takes data alone, with the logo and any call to action beside it in the app's own header: `AppHeader` is that header.
  - A link (`NavLink`, `{ href, label, icon? }`) may carry an `icon` (a slot name or an imported icon), drawn before its label as decoration, the label naming the link. Type links holding an `icon` `as const`, so a name stays a slot name.
- `AppHeader(links={links} current={pathname} label="Main")` with `@brand` and `@end` blocks: the bar across the top of an app, the brand at the start, a `SiteNav` of the `links` (same props, `menuLabel` too) and the `@end` area at the far end, such as a user menu or a theme toggle. `sticky` is on, so it stays at the top while the page scrolls; `sticky={false}` lets it scroll away.
  - A block left out draws no wrapper. Below `lg` the links fold behind the menu button, which follows the brand, `@end` keeping the far end; a long brand or end area wraps. A sticky header covers what an anchor scrolls to: give the page `scroll-padding-top` the header's height.
  - It is a `header` with `.kui-app-header`, `-brand`, `-nav` and `-end` parts, painted by `--color-kui-*` tokens, so a skin restyles it with no CSS of the app's own.
- `Breadcrumb(items={[{ label: 'Home', href: '/' }, { label: 'Moons', href: '/moons' }, { label: 'Phobos' }]} label="Breadcrumb")`: a `nav` holding an ordered list of the trail, top first and the page on screen last. The last item is marked `aria-current="page"` and is never a link; an earlier item without an `href` is plain text. Separators are drawn by the style and hidden from screen readers. From four items on, a phone shows the first and the last two with an ellipsis for the middle. `structured` also writes the trail as a `BreadcrumbList` JSON-LD script in the head, each `href` made absolute by `site` in kay.config.ts (which it then needs). Use it on one Breadcrumb per page.
- `Tabs`: panels that switch in place, without navigating, each tab `{ value, label, icon?, disabled? }`, the arrow keys going past a disabled one, for settings or a product's details; use TabNav when each tab is a page of its own.
  - A `tablist` of buttons, each paired with its `tabpanel` through ids drawn with `uid()`. `@panel(tab)` draws each tab's panel once, hidden while another tab shows, so what a panel holds survives a switch.
  - A click, or the arrows (wrapping), Home and End, show a tab and focus it; only the shown tab is in the page's tab order. `onChange(value)` runs on each switch, and a parent passing another `value` shows that tab.
  - A panel not shown is `hidden="until-found"`, so the browser's find in page or a link to an id inside it shows its tab, and so does kay's `focusInvalid`: after a refused save, `focusInvalid(form)` shows the tab holding the first field marked `aria-invalid` and focuses it, with no work out of which tab that is.
  - It renders inside an island, since its panels come from a block.
- `Toggle(label="Public" checked={post.public} name="public" onChange={setPublic})`: a checkbox drawn as a switch, with `role="switch"`, that posts like a checkbox. Without `label`, give it `aria-label`.
  - `onChange` may return a promise: the switch is `aria-busy` and flips no further until it settles, and goes back where it was when it resolves to `false`, rejects or throws (logged), unless the parent set `checked` meanwhile. A void answer leaves the switch as clicked. The switch jumping back is all the user sees, so toast the failure too. `attempt` resolves to `undefined` on failure, so turn that into `false`: `onChange={async checked => (await attempt(() => setPublic({ id, public: checked }), 'Could not publish')) ?? false}`.
- `Checkbox(label="I agree" checked={agreed()} name="terms" onChange={agreed.set})`: a native checkbox and its label, posting like one. `hint` adds a quieter note after the label, and `indeterminate` draws it as neither ticked nor not, for a box over a partly ticked list: a click toggles it from `checked`, and it is drawn so again while the parent keeps `indeterminate`. Without `label`, give it `aria-label`. `onChange` may return a promise, as Toggle's may. Use Toggle for a setting that applies as it is flipped.
- `ChipGroup(options={[{ value: 'films', label: 'Films' }, { value: 'games', label: 'Games', icon: 'star' }]} value={decks()} label="Decks" name="decks" onChange={decks.set})`: chips to pick several options from, real checkboxes posting each picked option under `name` (one unique on the page without it). `onChange` gets every picked option in the order of `options`, and may return a promise, as Segmented's may. An option may be `disabled`, or `disabled` on the group disables every chip. Option values may be numbers, such as `Date.getDay()` weekdays: `onChange` hears numbers, not their text. A parent passing another `value` moves the picks.

### Pagination, QrCode

- `Pagination(page={page} pages={pages} url={url})`: links to the pages of a list through the URL's query, so it renders on the server with no island and each page has a URL of its own.
  - Each link keeps `url`'s path and query, `param`, `page` by default, set to its page and left out for the first one. Read the page in a server fence: `const page = Number(ctx.url.searchParams.get('page') ?? 1)`. A page past the ends, or no whole number, such as `?page=abc`, shows as the nearest that exists, so clamp it the same way where the page's own query reads it.
  - It shows the first and last pages and `siblings` on each side of the current one, 1 by default, an ellipsis for those left out, or the page itself when only one would be. The current page is marked `aria-current="page"`; Previous and Next are links with `rel="prev"` and `rel="next"`, and plain text at the ends. With one page or none it draws nothing.
  - `label` (`Pagination`), `previousLabel` and `nextLabel` replace its words.
- A list whose length is unknown, which fetches one row past the page to know whether another follows, passes `more` in place of `pages`, and gets Previous and Next alone, Next a link while `more` is true: `Pagination(page={page} more={next !== null} url={ctx.url})`, or by offset, `Pagination(offset={offset} limit={20} more={next !== null} url={ctx.url})`, which steps `?offset=` by `limit`, `param` then being `offset` by default. With no step to link, it draws nothing.
- `Pagination(of={list})`: the same links for a page kay's `paginate()` from `kay/content` gave, `const list = await blog.page(ctx.params.page) ?? ctx.notFound()` in a `blog/[[page=integer]].kay` route, each page at its own path, `/blog`, `/blog/2`, rather than through the query. `of` takes any `{ page, pages, href(n) }`.
- `QrCode(value={shareUrl} label="Scan to open the list" size={160})`: the value as a QR code, an SVG image drawn where the page renders, on the server for a static page. `label` is its `alt`, and may be left out for a decorative code, which is then hidden from assistive technology. Without `size` it takes the width CSS gives it.
  - `inline` draws the SVG in the page instead of an image, so the colours in `options` may be CSS ones and follow the page: `QrCode(value={url} inline options={{ foreground: 'currentColor', eyeColor: 'var(--color-accent)', background: null }})`. A `label` then makes it `role="img"`; `size` sets the box's width and height.
  - It keeps dark modules on a light ground with a quiet zone, which every scanner reads, whatever the theme. `options` takes what `qrCodeSvg` from @kaynooo/utils does, `ecc`, `moduleShape`, `eyeColor`, `foreground`, `background`, `margin` and the rest, its colours written out since the image cannot read the page's CSS, unless it is `inline`.

## Reference

- Any parent, a layout and a page included, passes an island children and slots without parameters, which the server renders as static markup. A component or a page without a `--- server` fence passing one a function, a block with parameters or a class instance (such as Tabs' `@panel`, a Table's `@cell` or a function `rowKey`) renders as an island itself; a layout, or a page with a `--- server` fence, cannot, and moves that markup into a component of its own.
