---
description: Frames a form control with its label, hint and error message.
---

<Demo name="form-field/basic" />

The control goes inside as the child. `label` names it, `hint` explains it below, and `required` marks the label with a `*`. Pass `name` to match the field's name in an action, and `group` for a control made of several inputs, which becomes a labelled `fieldset`.

## Messages

`issue` shows a message of the page's own, such as `ctx.failed(rename)?.errors.title` after a plain form post. Inside a FormDialog, the message the action refused that field with shows here by itself.

<Demo name="form-field/issue" />

<ReadMore href="/ui/form-dialog">FormDialog shows each refused field's message on its FormField.</ReadMore>
