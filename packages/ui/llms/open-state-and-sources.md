# kayjs-ui: Open state, transitions and data sources

## Common tasks

### CollapsibleSection, Accordion

- `CollapsibleSection(title open={open()} onOpenChange={now => ...})`: `open` follows the page when it changes, `onOpenChange(open)` is called on every fold and unfold, however it came about. Passing it makes the section an island; without it the section stays static. `disabled` keeps it as it is, `title` takes a string or a block.
- `Accordion(items value={open()} onChange={values => ...})`: `value` is the open value, or an array of them with `multiple`, and the accordion follows it when the page passes a new one; left out, the reader decides. `onChange(values)` gets the values open (at most one without `multiple`), and closing a section as another opens reports only the opening. An item takes `disabled` and `meta` (a string); `@title(value)` and `@meta(value)` replace the heading and the band content.

### TreeView

- `TreeNode.children` may be `() => TreeNode[] | Promise<TreeNode[]>`, called once the first time the branch opens, the nodes kept; the row is `aria-busy` with a spinner meanwhile, and a throw or rejection shows `failureLabel` (`ui.treeView.failure`) beside a `retryLabel` button (`ui.treeView.retry`), opening the branch again also retrying. A tree with such a branch is an island.
- `onToggle(id, open, node)` runs for each click or key opening or closing a branch. `expanded` is followed when the parent passes a new list, the selected node's branches staying open. Parts `spinner`, `failed`, `retry`.

### Avatar, SiteFavicon, CopyButton, AudioPlayer

- `Avatar` and `SiteFavicon` take `onLoad(event)`, `onError(event)` and `@fallback`, drawn in place of the initial or the globe when there is no picture or it fails.
- `CopyButton(text={() => signedLink()} onCopy={copied => ...} onFail={error => ...})`: `text` is a string, a function returning one or a promise of one, copied inside the click so Safari accepts it. `onCopy(text)` follows a successful copy, `onFail(error)` a text that could not be built or a refused copy, beside the `failure` toast.
- `AudioPlayer` takes `onPlay`, `onPause`, `onEnded` and `onError(error)`, the `MediaError` of a file that fails to load or the `DOMException` of a refused play.

### Pagination

- `Pagination(page pages)` with no `url` links the address the page has, the page parameter set. `@step(direction)` draws the content of Previous and Next (`'previous'` or `'next'`) in place of their words, an icon for instance, and `previousLabel` and `nextLabel` still name the links. It stays a static component of plain links: a handler for a list paged in the browser is not offered, since it would make every `Pagination(of={list})` of a page an island whose props must serialize.

## Reference

- The shape every component of the library follows: state the app can hold is a prop followed when it changes plus a callback on each transition (`open`/`onOpenChange` as Popover, `value`/`onChange` as the pickers), a data source is a list or a function returning a promise, and each visible part can be replaced by a block.
