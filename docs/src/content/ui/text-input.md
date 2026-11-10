---
description: A text field that reports each keystroke and the committed value.
---

<Demo name="text-input/basic" />

`onInput` is called on each keystroke and `onChange` once the value is committed, on blur or Enter.

## Types

`type` picks the kind of field, such as `email` or `number`. A number box hands back a number, or `null` once emptied. Its `value` takes a number, `null` or a string. A number box mid-word reports nothing until it parses, so a half-typed figure never reads as a cleared field. Other attributes such as `placeholder` and `min` pass through to the input.

<Demo name="text-input/types" />


## Icon

`icon` draws an icon inside the box at its start. The text begins after it, and screen readers skip it. A `type="search"` box draws the search icon on its own, and `icon={false}` leaves it out. Pass an icon slot name or an imported icon, as a Button takes one; the `icon` part restyles it. Combobox takes `icon` too.

<Demo name="text-input/icon" />

## Size and invalid

`size` is `sm`, `md` or `lg`, `md` by default, and changes the padding and the type. `invalid` draws the line and the focus ring in the danger colour and sets `aria-invalid="true"`, for a refusal the page knows of. A FormField marks its control itself while it shows a message.

## Naming a field

A screen reader announces a box nothing names by its type alone. Give it a `label` through a FormField, or an `aria-label`, `aria-labelledby` or wrapping `label` of your own. In development, the browser logs one console warning for each kind of field drawn with no name, for TextInput and the other field components alike.

## After a refused post

Inside a form posting to an action, a field with no `value` and no `onInput` takes what a refused post sent, so a page working without JavaScript shows it again. So do Textarea, Select, RadioGroup, Segmented, ChipGroup, MultiSelect, Checkbox, Toggle, DateTimeInput, DateRangeInput, Combobox, RowsField and IconPicker. A field named like a secret is never refilled. Every field control takes `invalid`, which draws the danger line.
