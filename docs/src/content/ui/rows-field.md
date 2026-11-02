---
description: A list of rows of text boxes with Add and Remove, for headers, addresses and other repeated entries.
---

<Demo name="rows-field/basic" />

`rows` are plain objects of strings, one box per column, and `onChange` hears the new rows after every edit, added row and removed row. Each box is named for screen readers by its column and row, such as `Header 2`, the headings sit once above the rows, and Add moves the focus to the new row. `min` and `max` bound the number of rows, `removeLabel` words each Remove button, and a column may carry a `placeholder` and a `type`.

## In a form

Without `onChange` the field keeps its rows itself. Give it a `name` and each column posts under `<name>_<key>`, once per row in order with blank cells kept, so an action reads the columns as lists of one length. A reset brings back the rows it started with, and inside a [SaveForm](/ui/save-form) an added or removed row counts as an unsaved change.

## Numbers, selects and other cells

A column of `type: 'number'` is a number box; the row keeps the figure as text, `''` once emptied. For anything else, mark the column `cell: true` and draw it in the `@cell(column, row, index, set)` block: a Select of units, a checkbox, a Combobox. `set(text)` writes the value into the row, so the cell takes part in `onChange`, adding and removing, posting and reset like a text box.

The `column` it gets carries the `name` the cell posts under (`<name>_<key>`), which the control takes as its own, and the cell is named for screen readers by `${column.label} ${index + 1}`. Add and Remove move focus to the first control of a row, whatever it is.

```kay
---
import RowsField from '@kaynooo/kayjs-ui/rows-field.kay'
import Select from '@kaynooo/kayjs-ui/select.kay'

const units = [{ value: 'm', label: 'metres' }, { value: 'kg', label: 'kilos' }]
const columns = [{ key: 'name', label: 'Item' }, { key: 'qty', label: 'Quantity', type: 'number' as const }, { key: 'unit', label: 'Unit', cell: true }]
---
RowsField(rows={[{ name: 'Cable', qty: '2', unit: 'm' }]} columns={columns} name="line" label="Quote")
  @cell(column, row, index, set)
    Select(name={column.name} aria-label={`${column.label} ${index + 1}`} options={units} value={row.unit || 'm'} onChange={value => set(String(value))})
```

`onAdd(row, index)` and `onRemove(row, index)` are called besides `onChange`, with the row added or removed and its place.
