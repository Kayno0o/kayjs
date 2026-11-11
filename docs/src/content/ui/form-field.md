---
description: Frames a form control with its label, hint and error message.
---

<Demo name="form-field/basic" />

The control goes inside as the child. `label` names it, `hint` explains it below, and `required` marks the label with a `*` followed by the word `required` (the `ui.field.required` message), so a visitor does not have to know what the star means. Pass `name` to match the field's name in an action. Pass `group` for a control made of several inputs, which becomes a labelled `fieldset`.

## In a filter bar

`size="sm"` sizes the field by its control rather than the row, so several fit side by side. A Select inside is as wide as its options. A `sm` field holds no message unless given a `name` or an `issue`. A medium Button in the same row, such as a submit button at its end, is as tall as the fields at any `--density`, with no class or prop; a Button of another size, an inline one and one outside such a row keep their height.

<Demo name="form-field/compact" />

## Messages

`issue` shows a message of the page's own, such as `rename.failed()?.errors.title` after a plain form post. Inside a FormDialog, the message the action refused that field with shows here by itself.

<Demo name="form-field/issue" />

A form of your own that calls an action from an island can feed its FormFields the same way. Inside it, `formIssues.provide(() => ({ title: 'Too short' }))` from kayjs-ui gives a message per field name, and each FormField reads the one for its `name`. FormDialog and SaveForm do exactly this.

<ReadMore href="/ui/form-dialog">FormDialog shows each refused field's message on its FormField.</ReadMore>

## Screen readers

The control is described by the hint and, while one shows, by its messages. They sit beside the ids its own `aria-describedby` holds.

A `required` field is announced as required: its control gets `aria-required="true"`, on a static page and in an island, since the `*` is hidden from a screen reader, and so does each field of a `group`. A control that sets its own `aria-required` keeps it.

The control also gets the native `required`, so the browser's validation and a post with no JavaScript know the field is required, and so does each field of a `group`, except the boxes of a group of checkboxes: the browser would ask for every one, so they take `aria-required` alone. A control of a type that takes no `required` (a range or a colour input) keeps the `aria-required` where its role has one, and one that sets its own `required` keeps it. Turning `required` off takes both back.

On a static page the server writes the link. Inside an island, as in a FormDialog, the browser keeps it as messages come and go, and marks the control `aria-invalid` while one shows. A FormDialog refusing a field focuses the first one marked so, which reads its message with it.

A choice made of several inputs (RadioGroup, Segmented, ChipGroup, Rating, RangeInput) is the described field, not its first input: the group is named by the field's label (one with its own `label` or `aria-label` keeps it), described by the hint and message, marked `aria-invalid` while one shows, and `aria-required` when it is a radio group. A static page's group links itself once the browser has it. With `group`, the fieldset names the choice instead, and each input inside takes the mark.

Inside an island, a `group` with a message marks every input, select and textarea inside it the same way. So kay's `focusInvalid` shows the tab holding the group and focuses its first field.

On a static page, kay marks the fields of a refused plain form post `aria-invalid` itself.
