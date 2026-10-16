---
description: Frames a form control with its label, hint and error message.
---

<Demo name="form-field/basic" />

The control goes inside as the child. `label` names it, `hint` explains it below, and `required` marks the label with a `*`. Pass `name` to match the field's name in an action. Pass `group` for a control made of several inputs, which becomes a labelled `fieldset`.

## In a filter bar

`compact` sizes the field by its control rather than the row, so several fit side by side. A Select inside is as wide as its options. A compact field holds no message unless given a `name` or an `issue`.

<Demo name="form-field/compact" />

## Messages

`issue` shows a message of the page's own, such as `ctx.failed(rename)?.errors.title` after a plain form post. Inside a FormDialog, the message the action refused that field with shows here by itself.

<Demo name="form-field/issue" />

<ReadMore href="/ui/form-dialog">FormDialog shows each refused field's message on its FormField.</ReadMore>

## Screen readers

The control is described by the hint and, while one shows, by its messages. They sit beside the ids its own `aria-describedby` holds.

On a static page the server writes the link. Inside an island, as in a FormDialog, the browser keeps it as messages come and go, and marks the control `aria-invalid` while one shows. A FormDialog refusing a field focuses the first one marked so, which reads its message with it.

Inside an island, a `group` with a message marks every input, select and textarea inside it the same way. So kay's `focusInvalid` shows the tab holding the group and focuses its first field.

On a static page, kay marks the fields of a refused plain form post `aria-invalid` itself.
