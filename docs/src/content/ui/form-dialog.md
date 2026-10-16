---
description: A dialog that calls a page's action with its form and shows each refused field's message.
---

FormDialog needs an action exported by a page, so it is shown here as code. `src/routes/posts/[id].kay`:

```kay
--- server
import { s } from 'kay'

const renaming = s.Object({
  id: s.String({ maxLength: 64 }),
  title: s.String({
    minLength: 2,
    maxLength: 200,
    error: 'Two letters at least',
  }),
})

export const rename = action(
  renaming,
  async ({ id, title }) => posts.rename(id, title),
)
---
```

Then a component of the app, which has an island because it holds a signal:

```kay
---
import Button from '@kaynooo/kayjs-ui/button.kay'
import FormDialog from '@kaynooo/kayjs-ui/form-dialog.kay'
import FormField from '@kaynooo/kayjs-ui/form-field.kay'
import { rename } from '../routes/posts/[id].kay'

const { post } = props<{ post: Post }>()

const editing = signal(false)
const title = signal(post.title)
---
Button(label="Rename" onClick={() => editing.set(true)})
FormDialog(
  open={editing()}
  title="Rename"
  action={rename}
  submitLabel="Rename"
  failure="Could not rename"
  onSaved={saved => title.set(saved.title)}
  onClose={() => editing.set(false)}
)
  input(type="hidden" name="id" value={post.id})
  FormField(label="Title" name="title" required)
    input.kui-field-input(name="title" value={title()})
```

The dialog calls `action` with the form's data. Give each control the `name` of its field in the action's schema. When the action refuses a field, its message shows on the [FormField](/ui/form-field) with that `name` and the dialog stays open. `onSaved` receives what the action returned, then the dialog closes.

## Refusals of the handler

A handler refusing with `ctx.fail(400, { error: 'Slug taken' })` reaches the dialog through `refused`, which answers a message per field, or one message that is toasted. Without it, `failure` is toasted.

```kay
FormDialog(
  open={editing()}
  title="Rename"
  action={rename}
  submitLabel="Rename"
  failure="Could not rename"
  refused={data => ({ slug: data.error })}
  onClose={() => editing.set(false)}
)
```

`extra` fills the left end of the footer, for a [ConfirmDelete](/ui/confirm-delete) with `trigger="button"`.

<ReadMore href="/essentials/forms-and-actions">Actions and forms are covered in their own guide.</ReadMore>

## Adding and editing rows

A list adding and editing its rows through one dialog keeps which row is open with `editing()`, from the package: `edit(row)` opens the dialog on a row, `create(draft)` on what a new row starts from, and `close` shuts it, forgetting both.

```kay
---
import { editing } from '@kaynooo/kayjs-ui'
import Button from '@kaynooo/kayjs-ui/button.kay'
import FormDialog from '@kaynooo/kayjs-ui/form-dialog.kay'
import FormField from '@kaynooo/kayjs-ui/form-field.kay'
import { save } from '../routes/friends.kay'

const { friends } = props<{ friends: Friend[] }>()

const friend = editing<Friend, { name: string }>()
---
Button(label="Add" onClick={() => friend.create({ name: '' })})
for one of friends key={one.id}
  Button(label={one.name} onClick={() => friend.edit(one)})
FormDialog(
  open={friend.open()}
  title={friend.row() ? 'Edit friend' : 'Add friend'}
  action={save}
  submitLabel="Save"
  failure="Could not save"
  onClose={friend.close}
)
  input(type="hidden" name="id" value={friend.row()?.id ?? ''})
  FormField(label="Name" name="name" required)
    input.kui-field-input(name="name" value={friend.row()?.name ?? friend.draft()?.name})
```

`row()` and `draft()` read undefined while the other is open, and both while it is closed. Leave the draft's type out, `editing<Friend>()`, and `create()` takes nothing.
