# kayjs-ui: Open state, transitions and data sources

## Common tasks

### One name for show and hide

- A component that shows and hides something takes `open` and reports through `onOpenChange(open, ...context)`, the context being what the component knows (a MediaGallery's index, a DateRangeInput's box); a Table and a TreeView open many rows, so theirs lead with the row key or node id, `onOpenChange(key, open)` and `onOpenChange(id, open, node)`. A list of things open stays `expanded` or `value` (Table and TreeView `expanded`, Accordion `value`), and a component with two such regions names each: SplitLayout `sidebarOpen` with `onSidebarOpenChange` and `detailOpen` with `onDetailOpenChange`. `open` defaults to `false` everywhere, and `boxed` to `false` on CollapsibleSection and Accordion. `onToggle` on Table and TreeView, before 1.90 the callback, works until 1.93 (`deprecated-open-change`).
- Not disclosures, so named for what they are: Notice `open` is whether it shows, adding a close button as `dismissible` does, with `onDismiss` for the press; MarkdownEditor `previewing` and RecordButton `recording` are modes of a control (edit or preview, idle or recording) with `onPreviewChange` and `onRecordingChange`.

### CollapsibleSection, Accordion

- `CollapsibleSection(title open={open()} onOpenChange={now => ...})`: `open` follows the page when it changes, `onOpenChange(open)` is called on every fold and unfold, however it came about. Passing it makes the section an island; without it the section stays static. `disabled` keeps it as it is, `title` takes a string or a block.
- `Accordion(items value={open()} onChange={values => ...})`: `value` is the open value, or an array of them with `multiple`, and the accordion follows it when the page passes a new one; left out, the reader decides. `onChange(values)` gets the values open (at most one without `multiple`), and closing a section as another opens reports only the opening. An item takes `disabled` and `meta` (a string); `@title(value)` and `@meta(value)` replace the heading and the band content.

### VirtualList, Masonry, MediaGallery, Carousel

- `list={feed}` (an `infiniteList`) replaces `items` on VirtualList, Masonry and MediaGallery and `slides` on Carousel, as it replaces `rows` on Table: exactly one of the two. VirtualList and Masonry draw `LoadMore` after their rows, so the next page loads when the end nears and a failed page shows its alert with the retry; MediaGallery and Carousel load the next page when the reader is on one of the last two items and show LoadMore's alert under the strip or the controls when a page failed. MediaGallery and Carousel are generic over the item type: a list of your own rows that carry the fields they read passes as is.

### Menu

- `Menu(items={() => loadTargets()} label="Move to")`: `items` is a list, a function returning one or a promise of one, or a promise; a function runs each time the menu opens (a promise is awaited once), the latest answer winning, with a `status` row (`ui.menu.loading`) meanwhile and, when it throws or rejects, an alert row (`ui.menu.failure`) and a `Try again` entry (`ui.menu.retry`). The first entry takes focus when the answer arrives.
- `@item(entry)` replaces an entry's icon and label with your block (a shortcut hint, a check, a badge); the entry keeps its role, its keys and its link or button. New part `status`.

### TreeView

- `TreeNode.children` may be `() => TreeNode[] | Promise<TreeNode[]>`, called once the first time the branch opens, the nodes kept; the row is `aria-busy` with a spinner meanwhile, and a throw or rejection shows `failureLabel` (`ui.treeView.failure`) beside a `retryLabel` button (`ui.treeView.retry`), opening the branch again also retrying. A tree with such a branch is an island.
- `onOpenChange(id, open, node)` runs for each click or key opening or closing a branch. `expanded` is followed when the parent passes a new list, the selected node's branches staying open. Parts `spinner`, `failed`, `retry`.

### Avatar, SiteFavicon, CopyButton, AudioPlayer

- `Avatar` and `SiteFavicon` take `onLoad(event)`, `onError({ event })` and `@fallback`, drawn in place of the initial or the globe when there is no picture or it fails.
- `CopyButton(text={() => signedLink()} onCopy={copied => ...} onError={({ error }) => ...})`: `text` is a string, a function returning one or a promise of one, copied inside the click so Safari accepts it. `onCopy(text)` follows a successful copy, `onError({ error })` a text that could not be built or a refused copy, beside the `failureLabel` toast.
- `AudioPlayer` takes `onPlay`, `onPause`, `onEnded` and `onError({ error, event })`, the `MediaError` of a file that fails to load or the `DOMException` of a refused play, and `failureLabel` for the refused play's toast.
- A failure is named the same on every component: `onError` receives one object, `{ error }` for what was thrown or rejected (`{ error, query }` on a Combobox or MultiSelect, `{ problem, error? }` on a RecordButton) and `{ event }` for what the DOM raised (Avatar, SiteFavicon, an ImageCropper's image), so a field is added without breaking a caller; the message shown is `failureLabel`, beside `loadingLabel`, `emptyLabel` and `retryLabel`.

### Pagination

- `Pagination(page pages)` with no `url` links the address the page has, the page parameter set. `@step(direction)` draws the content of Previous and Next (`'previous'` or `'next'`) in place of their words, an icon for instance, and `previousLabel` and `nextLabel` still name the links. It stays a static component of plain links: a handler for a list paged in the browser is not offered, since it would make every `Pagination(of={list})` of a page an island whose props must serialize.

### Options from a list or a function

- `MultiSelect(options={({ q }) => api.people(q)} valueLabels={{ ada: 'Ada' }})`: `options` is a list, or a function returning a promise of the options for the text typed, as Combobox's. It is asked when the panel opens and after each 200 ms pause in typing, only the latest answer lands, `minLength` holds the asks back, and the status line says `loadingLabel` or `failureLabel`. What was picked keeps its label across searches, from the answers seen or `valueLabels` for values never listed. `onLoad(options, query)` and `onError(error, query)` follow each answer.
- `Select(options={() => api.sizes()})`: the same function, asked once with an empty `q` when the select is drawn in the browser; it is busy under `loadingLabel` until the answer, or shows `failureLabel` once rejected, with `onLoad` and `onError`.
- `IconPicker(icons={...})` takes the same `OptionsSource` as the other pickers: a set or a promise of one, filtered by name and paged like an answer, or a function handed `{ q, limit, offset }`; `search` is its deprecated form.

### Drawing an option

`MultiSelect`, `RadioGroup`, `ChipGroup` and `Segmented` take `@option(option)`, drawn in place of the label (and icon) as Combobox's. The input stays, with its checked and disabled state and the option's `label` as its accessible name; RadioGroup keeps the description as its quiet line. A block taking a parameter cannot be sent to the browser as data, so the component hydrates itself on the page, as Combobox does; without the block it stays static.

## Reference

- The shape every component of the library follows: state the app can hold is a prop followed when it changes plus a callback on each transition (`open`/`onOpenChange` as Popover, `selected`/`onSelectedChange` as Table, TreeView and Timeline, `value`/`onChange` as the pickers), a press of an item with no prop behind it is `onSelect` handing back the item (BarList, the charts, Steps, Menu; `tests/callbacks.test.ts` holds it), a data source is a list or a function returning a promise, and each visible part can be replaced by a block.
