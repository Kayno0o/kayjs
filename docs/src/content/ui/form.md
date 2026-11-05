---
description: The form of a page that calls a page's action, showing each refused field's message on its FormField, with or without JavaScript.
---

<Demo name="form/basic" />

Form is a form with its action, for a page that adds or changes something. The fields go inside as the children, and the submit button is yours.

Give each control the `name` of its field in the action's schema. A [FormField](/ui/form-field) with a `name` shows the message the action refused that field with, so the fields need no `issue`.

```kay
---
import Button from '@kaynooo/kayjs-ui/button.kay'
import FormField from '@kaynooo/kayjs-ui/form-field.kay'
import Form from '@kaynooo/kayjs-ui/form.kay'
import { add } from './_actions.kay'
---
Form(action={add} saved="Added.")
  FormField(label="Title" name="title" required)
    input.kui-field-input(name="title")
  Button(type="submit" tone="accent" label="Add")
```

Without JavaScript the form posts to the action as any `form(action={add})` does, and the page comes back with the messages in place. With JavaScript it calls the action, so the page does not reload.

## Saving

A refused field shows its message on its FormField and takes the focus. Any other message is toasted, and `refused` words a handler's refusals, as in a [FormDialog](/ui/form-dialog). A failure carrying no message toasts `failureLabel`.

A call that goes through toasts `saved` when given and calls `onSaved` with what the action returned. When it is refused or fails, `onError` is called first with `{ error }`.

## A form of your own

A `form(action={add})` written in a template needs none of this to show messages. A FormField, Checkbox or Toggle inside it with a `name` shows `add.error('name')`, with and without JavaScript. Use Form when you want the call, the toast and the focus.
