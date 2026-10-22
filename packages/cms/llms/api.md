# Form fields and drafts

The functions the screens and the editor are made of, for a site building its own form or editor.

## Common tasks

### List the form fields of a collection

`fieldsOf(schema)` gives the form fields of a collection's JSON Schema, in order, each `{ key, label, required, hint, kind }`.

```ts
import { fieldsOf } from '@kaynooo/kayjs-cms'

const fields = fieldsOf(schema).map(field => field.label)
```

### Word a key as a label

`humanize(key)` gives a key as words, as the screens title a collection with no `title`.

```ts
humanize('seoURL') // 'Seo URL'
```

### Hold the unsaved edits of a page

`createDrafts({ show, delay, keep })` holds the edits and renders the page with them once typing pauses.

```ts
const drafts = createDrafts({ show, delay: '150ms', keep: browserKeeper() })
drafts.set(ref, 'title', 'New title')
```

## Reference

- `fieldsOf(schema)`: the form fields of a collection's JSON Schema, in order, each `{ key, label, required, hint, kind }`. Kinds: `text`, `textarea`, `lines`, `markdown`, `number`, `integer`, `boolean`, `date`, `datetime`, `image`, `file`, `json`, `select` (an enum or a union of literals, with `options`, each `{ value, label, raw }`; a literal's `title` is its label), `reference` (with `collection`), `list` (with `item`, `minItems`, `maxItems`, and `blocks` for a `blocks()` list, each `{ type, label, fields }` ([Blocks](fields.md#blocks)); a list of single controls shows one label, then compact rows, a list of groups, lists or files heads each item with its own title (the first filled `text` field of a group, else `Item N` or the item schema's title) that folds it away; each item has up, down, duplicate and remove buttons, and Alt+Shift with an arrow key moves the item in focus (not from a textarea, where macOS selects a paragraph with it); a move is said to screen readers as `Moved {item} to {position} of {count}`, a numbered item named by the place it left; the list shows its item count and `minItems`/`maxItems`, Add and Duplicate stop at the maximum and Remove at the minimum; a new item starts as the item schema's `default`, else blank, a select staying unpicked; removing an item offers Undo, and focus lands on the item that took its place, or on the new item after Add) and `group` (with `fields`), and `custom` (with `name`, a kind the app's `customField` names). kay's `x-kay: { kind }` hint wins over the type. A `datetime` (an `s.Date()` is one) is shown and typed on the wall clock of the editor's browser zone (UTC on the server render and until the browser mounts), with a hint naming it, `Time in Europe/Paris`, and stores the instant it names as a full UTC date, so the entry says the same at any editor's zone; a time the zone's clocks skip is stored an hour on, as a `Date` reads it, and one they repeat at its first turn; clearing a date field stores nothing. A nullable field is optional. `s.Integer()`, `s.Numeric()`, `s.BooleanString()` and `s.Date()`, which accept a string too, are read as their plain kind.
- `fieldOf(key, schema, required)`: the one field a property's JSON Schema makes, as `fieldsOf` makes each, `key` a number for a list item (labelled `Item 1`, `Item 2`).
- `humanize(key)`: a key as words for a label, `publishedAt` as `Published at`, an acronym keeping its capitals, `seoURL` as `Seo URL`, `_` and `-` only separating words, as the screens title a collection with no `title`.
- `emptyValue(field)`: what a new list item starts as.
- `parseMarker(value, body?)`, `formatMarker(marker)`, `entryKey(ref)`: read and write kay's markers.
- `fieldsAt(node)`: the fields rendered at a node, innermost first.
- `createDrafts({ show, delay, keep })`: the unsaved edits of a page's entries; `keep` is a `DraftKeeper` (`browserKeeper()`) holding them across a reload, none by default. `anyChanged()`, `discardAll()`, `recovery(ref)`, `adopt(ref, entry, version)` and `differences(ref, other)` serve the leave guard, Stop editing and the conflict choice. `open(entry, version?)`, `version(ref)`, `value(ref, path)`, `set(ref, path, value)`, `changed(ref)`, `reset(ref)`, `markSaved(ref, sent, version?)` (what was sent becomes the saved state, an edit typed meanwhile staying unsaved), `refuse(ref, refusal)`, `refusal(ref)` and `keepEdits(ref)` (why a save was refused as a whole, kept until the entry saves or resets, and taking a conflict's version), `issues(ref, path?)`, `failure()`, `rendering()`, `stale()` (the changed entries the last render or save reported issues for, whose saved text the page shows) and `reapply()` (renders again with the edits, for a page that replaced the one they were shown on). Each change renders the page with every changed entry once typing pauses `delay` (a duration, `'150ms'`), keeping only the latest render's issues; `report(issues)` shows a refused save's, which a render scheduled before it leaves be until the next edit.
- `valueAt(data, path)`, `withValueAt(data, path, value)`, `joinPath(parent, key)`: field paths.
