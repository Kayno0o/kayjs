---
description: A list of rows of text boxes with Add and Remove, for headers, addresses and other repeated entries.
---

<Demo name="rows-field/basic" />

`rows` are plain objects of strings, one box per column, and `onChange` hears the new rows after every edit, added row and removed row. Each box is named for screen readers by its column and row, such as `Header 2`, the headings sit once above the rows, and Add moves the focus to the new row. `min` and `max` bound the number of rows, `removeLabel` words each Remove button, and a column may carry a `placeholder` and a `type`.

## In a form

Without `onChange` the field keeps its rows itself. Give it a `name` and each column posts under `<name>_<key>`, once per row in order with blank cells kept, so an action reads the columns as lists of one length. A reset brings back the rows it started with, and inside a [SaveForm](/ui/save-form) an added or removed row counts as an unsaved change.
