---
description: A text input with a listbox of options, filtered from a list or loaded from the server as the visitor types.
---

<Demo name="combobox/basic" />

`options` is a list of `{ value, label, disabled? }`, filtered by what is typed. `value` is the value picked, empty while nothing is, and `onChange(value, option)` runs when one is picked or the pick is dropped by typing again. With `create`, the text typed is offered as a last row, `Create "text"`, unless an option already bears it; picking it hands the text as the value and to `onCreate(text)`.

A label typed whole, with no row chosen, counts as a pick of that option once the input loses focus or Enter is pressed. That Enter only adopts the option, so a form around the input is not submitted by it; the next Enter submits.

## Options loaded as the visitor types

Give `options` a function instead of a list. It is called with `{ q }` a moment after the last key, once `minLength` characters (one by default) are typed, and answers the options. An action or an API call wrapped in a function fits; only the latest answer is shown, so a slow answer to an older question never replaces a newer one. A failed call says `failureLabel` in the status line and the list stays closed.

<Demo name="combobox/remote" />

```kay
Combobox(label="Customer" options={searchCustomers} value={customer()} valueLabel={customerName} onChange={customer.set} name="customer")
```

A `value` no list holds yet, such as the saved id of a customer, shows that id as the input's text. Give `valueLabel` the text to show instead, and the loader is not asked for it when the input takes focus.

## Forms

`name` submits the value picked in a hidden field, or the text typed while nothing is. Without JavaScript the input is a plain text field posting its text, with a list of options offered through the browser's own suggestions. When the browser runs, kayjs-ui's listbox replaces them. A form reset puts the text and the pick back.

## Keyboard and screen readers

The input is a `combobox` with `aria-autocomplete="list"`, controlling a `listbox` and pointing at the active row with `aria-activedescendant`, so focus never leaves the input. ArrowDown and ArrowUp open the list and move through the rows, skipping disabled ones and wrapping at both ends. Alt+ArrowDown opens it without moving.

Enter picks the active row, Escape closes the list, even one with no rows, and, closed, clears the text. A status line reads out the number of results, the loading and the failure.

## Props and labels

`label` names the input for screen readers, unless a FormField labels it, in which case the FormField's label text alone names it, not the status line nor the rows. `id` is the listbox's id. `createLabel(text)`, `loadingLabel`, `emptyLabel` and `failureLabel` replace the texts, which read `Create "text"`, `Loading…`, `No match` and `Could not load the options`. The other attributes land on the input, and `class` on the wrapper or, as an object, on its parts: `list`, `option` and `status`.
