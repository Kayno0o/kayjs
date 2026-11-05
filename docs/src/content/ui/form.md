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

Without JavaScript the form posts to the action as any `form(action={add})` does, and the page comes back with the messages in place. With JavaScript it calls the action, so the page does not reload. The fields can be the page's own markup: after a call made with JavaScript the form writes each message into the FormField of that `name`, links it to the control, marks the control invalid and focuses the first one, with no island of yours.

## Checking as you type

`validate="submit"` checks the fields against the action's schema when the form is sent: a refused field shows its message with the same words the server would give, the first one takes the focus and the action is not called. `validate="blur"` also checks each field as it loses focus, and the message goes once the value is fixed. By default the check is the server's. Files and missing fields are always the server's.

A message appearing under a field moves what follows it, which can shift the page under a click on the next control: with `blur`, reserve room for the message (a minimum height on the FormField's message area).

The check reads the schema the page carries for the action. Form, a SaveForm or FormDialog with `validate` and a `form(action)` bring it, and a form drawn only in the browser, inside an island that no page render collected, has none, so `validate="submit"` accepts it and the server decides. A check replaces the last outcome of the action, so a blur check clears what `succeeded()` returned.

The same goes for a `form(action={add})` of your own: write `validate` (or `validate="blur"`) on it and the messages show as text in the FormFields of the form that no island draws, with the control marked invalid, instead of the browser's bubble. `novalidate` and `formnovalidate` still skip the check.

## Saving

A refused field shows its message on its FormField and takes the focus. Any other message is toasted, and `refused` words a handler's refusals, as in a [FormDialog](/ui/form-dialog). A failure carrying no message toasts `failureLabel`.

A call that goes through toasts `saved` when given and calls `onSaved` with what the action returned. When it is refused or fails, `onError` is called first with `{ error }`.

## A form of your own

A `form(action={add})` written in a template needs none of this to show messages. A FormField, Checkbox or Toggle inside it with a `name` shows `add.error('name')`, with and without JavaScript. Use Form when you want the call, the toast and the focus. An empty message is dropped. An island's own template does not know a `form(action)` of the page around it, so inside an island use Form or the `issue` prop.
