# kayjs-ui: Open state, transitions and data sources

## Common tasks

### CollapsibleSection, Accordion

- `CollapsibleSection(title open={open()} onOpenChange={now => ...})`: `open` follows the page when it changes, `onOpenChange(open)` is called on every fold and unfold, however it came about. Passing it makes the section an island; without it the section stays static. `disabled` keeps it as it is, `title` takes a string or a block.
- `Accordion(items value={open()} onChange={values => ...})`: `value` is the open value, or an array of them with `multiple`, and the accordion follows it when the page passes a new one; left out, the reader decides. `onChange(values)` gets the values open (at most one without `multiple`), and closing a section as another opens reports only the opening. An item takes `disabled` and `meta` (a string); `@title(value)` and `@meta(value)` replace the heading and the band content.

## Reference

- The shape every component of the library follows: state the app can hold is a prop followed when it changes plus a callback on each transition (`open`/`onOpenChange` as Popover, `value`/`onChange` as the pickers), a data source is a list or a function returning a promise, and each visible part can be replaced by a block.
