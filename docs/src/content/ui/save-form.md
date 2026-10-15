---
description: A form for an editor page that calls a page's action, with a sticky bar showing unsaved changes, the save under way, Discard and Save.
---

<Demo name="save-form/basic" />

SaveForm is a form with its action and its bar, for a page that edits something in place. The fields go inside as the children; the bar sticks to the bottom of the screen and shows whether the form holds unsaved changes, the save under way, a Discard button and a Save button. Give each control the `name` of its field in the action's schema, as for a [FormDialog](/ui/form-dialog), and the form calls the action with its `FormData`.

```kay
---
import FormField from '@kaynooo/kayjs-ui/form-field.kay'
import SaveForm from '@kaynooo/kayjs-ui/save-form.kay'
import { rename } from '../routes/posts/[id].kay'

const { post } = props<{ post: Post }>()
---
SaveForm(action={rename} failure="Could not save" saved="Saved.")
  input(type="hidden" name="id" value={post.id})
  FormField(label="Title" name="title" required)
    input.kui-field-input(name="title" value={post.title})
```

The form is dirty when what its controls hold differs from what they held when it was last clean, so typing a change back makes it clean again, and the page needs no `dirty` or `saving` signal of its own. A control added or removed counts as a change.

- **Save** calls the action, and does nothing while the form is clean or a save is under way. A failure keeps the bar dirty: a refused field shows its message on its [FormField](/ui/form-field) and takes the focus, any other message is toasted, as in a FormDialog, with `refused` for a handler's refusals. Edits made while the save runs stay unsaved. A save toasts `saved` when given, calls `onSaved` with what the action returned and leaves the form clean.
- **Discard** puts the controls back to their initial values, or to the saved ones once a save has run, and clears the messages. The library's controls follow it and tell their `onChange` or `onInput` what they went back to, so the page needs nothing in `onDiscard`, which is for state it keeps beyond the controls. A Checkbox, Toggle, ChipGroup or Segmented still waiting on the promise of its `onChange` finishes that change first, then goes back. The search box of an IconPicker or a MultiSelect is not a saved value: Discard empties it even after a save.
- **Leaving** with unsaved changes asks, as `guardLeave` does: a link of the app, going back, a reload or closing the tab, but not while a save is under way.
- **Ctrl+S**, or Cmd+S on macOS, saves from any field of the form, on the key that types an S whatever the layout.
- The bar's status is a live region, so a screen reader hears the changes pile up, the save start and the form come back clean. The buttons stay focusable as the form turns clean, so the focus stays on the one pressed.
- `dirtyLabel`, `cleanLabel`, `savingLabel`, `saveLabel` and `discardLabel` replace the texts.

A control set by a signal changes the form with no input event: after setting one from code, dispatch an `input` event on it.

<ReadMore href="/essentials/forms-and-actions">Actions and forms are covered in their own guide.</ReadMore>
