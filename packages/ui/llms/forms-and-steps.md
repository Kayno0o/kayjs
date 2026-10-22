# kayjs-ui: Forms, FormDialog and Steps

## Common tasks

### Forms and Steps

FormField frames a control with its label, hint and messages; inside an island a `group` given a message marks each input, select and textarea in it `aria-invalid` and described by the message, so `focusInvalid` reveals its tab and focuses its first field. A `required` FormField gives its control, each field of a `group`, `aria-required="true"` unless it sets its own, as the `*` is hidden from screen readers. FormDialog calls a page's action from a dialog and shows the message of each refused field on its FormField. SaveForm does the same for an editor page, with a sticky bar of unsaved changes.

```kay
--- server
import { s } from 'kay'

export const rename = action(s.Object({ id: s.String({ maxLength: 64 }), title: s.String({ minLength: 2, maxLength: 200, error: 'Two letters at least' }) }), async ({ id, title }) => posts.rename(id, title))
---
```

```kay
---
import { signal } from 'kay'
import Button from '@kaynooo/kayjs-ui/button.kay'
import FormDialog from '@kaynooo/kayjs-ui/form-dialog.kay'
import FormField from '@kaynooo/kayjs-ui/form-field.kay'
import { rename } from '../routes/posts/[id].kay'

const { post } = props<{ post: Post }>()

const editing = signal(false)
const title = signal(post.title)
---
Button(label="Rename" onClick={() => editing.set(true)})
FormDialog(open={editing()} title="Rename" action={rename} submitLabel="Rename" failure="Could not rename" onSaved={saved => title.set(saved.title)} onOpenChange={() => editing.set(false)})
  input(type="hidden" name="id" value={post.id})
  FormField(label="Title" name="title" required)
    input.kui-field-input(name="title" value={title()})
```

- FormDialog calls `action` with `new FormData(form)`, read on the server as a plain form post and answered as a call. An action that redirects takes the browser there instead.
- When the action refuses a field, its message shows on the FormField with that `name`, and the dialog stays open. That is the `formIssues` context of kayjs-ui, which FormDialog and SaveForm provide in an island and a FormField reads: a form of your own calling an action does `formIssues.provide(() => ({ title: 'Too short' }))` to show messages the same way.
- A refused message no FormField shows is toasted instead, a refusal of the whole form under the empty name included. A failure carrying no message toasts `failure`.
- A refusal of the handler, `ctx.fail(400, { error: 'Slug taken' })`, reaches the dialog through `refused`, which reads that data and answers a message per field (`{ slug: data.error }`), shown on the FormFields, or one message (`data.error`), toasted. Without `refused`, or when it answers undefined, `failure` is toasted: `FormDialog(... failure="Could not save" refused={data => data.error})`.
- A save hands what the action returned to `onSaved`, then closes the dialog.
- `editing<Row, Draft>()`, from the package, keeps which row one dialog adds or edits for a list: `edit(row)` opens it on a row, `create(draft)` on what a new row starts from, `close` shuts it, forgetting both, and `open()`, `row()` and `draft()` read it: `FormDialog(open={friend.open()} title={friend.row() ? 'Edit friend' : 'Add friend'} ... onOpenChange={friend.close})`. Without `Draft`, `create()` takes nothing.
- The submit button sits in the footer, paired with the form by `id`. Without an `id`, it draws one unique on the page.
- Enter submits from a single-line field, and Ctrl+Enter from a textarea. While the call is under way, the buttons are disabled, and Escape or a click outside leaves the dialog open.
- `extra` fills the left end of the footer, for a ConfirmDelete with `trigger="button"`.

SaveForm is the form of an editor page: `SaveForm(action={rename} failure="Could not save" saved="Saved.")` around the fields, each control named as for FormDialog, draws a sticky bar with a status line, Discard and Save.

- The form is dirty while its controls differ from what they held when it was last clean, so typing a change back cleans it, and a control added or removed counts. A control set from code needs an `input` event dispatched on it.
- Save calls `action` like FormDialog, with `refused` and `failure` working the same, and does nothing while the form is clean or a save runs. A failure keeps the bar dirty, a refused field takes the focus, and edits made during the save stay unsaved. A save toasts `saved` when given, calls `onSaved(result)` and leaves the form clean.
- An editor whose state is signals and whose save takes an object gives `dirty={isNew || changed()}` and `onSave={() => save({ name, config })}` instead of `action`: the bar, the leave guard, Save and the shortcut follow `dirty`, `onSave` answers the call's promise (a rejection is handled as an action's refusal is, `refused`, the messages on their FormField and `failure` included; `false` is a refusal the app shows itself; both leave the bar unsaved; `onSaved` is for `action` only), the app clears `dirty` once it has saved, and `status` replaces the status line. `failure` defaults to a message of the page's language.
- Discard resets the controls to their initial values, or to the saved ones once a save has run, clears the messages and calls `onDiscard`, for state the page keeps beyond the controls. The signal-driven controls (Checkbox, Toggle, ChipGroup, Segmented, Select, MultiSelect, IconPicker, TextInput, Textarea, MarkdownEditor, RangeInput, DateInput, DateRangeInput, TimeInput) follow any `form.reset()`, a `<button type="reset">` included, and tell their `onChange` (a text field, `onInput` or else `onChange`) what they went back to. The start is what the control was first drawn with, so a controlled one whose value arrived later goes back to the first; a Segmented that started with none picked shows none and tells `onChange` `null`, which its type allows only when `value` is typed nullable. A Checkbox, Toggle, ChipGroup or Segmented busy with a promise from its `onChange` lets a reset wait for it, then goes back and tells the app, unless the refusal already put it there. The search box of an IconPicker or MultiSelect is no saved value: a reset empties it after a save.
- Leaving with unsaved changes asks as `guardLeave` does, except while a save runs. Cmd+S on macOS and Ctrl+S elsewhere save from any field, on the key that types an S whatever the layout (`shortcut('mod+s')`); `shortcut="ctrl+enter"` changes the keys, any string kay's `shortcut` takes, and `shortcut={false}` binds none.
- The status line is a live region; the buttons use `aria-disabled`, so the focus stays on the one pressed as the form turns clean. `dirtyLabel`, `cleanLabel`, `savingLabel`, `saveLabel` and `discardLabel` replace the texts.

A form in steps keeps the step in the URL: `Steps(steps={[{ key: 'account', label: 'Account' }]} current={current} done={done} url={ctx.url} label="Signup")` draws the numbered row, a step before the current one or in `done` a link back (`param`, `step` by default; `doneLabel`). Parts: `list`, `item`, `link`, `marker`, `label`.

- `currentStep(ctx.url, keys, done)` reads the step off the URL, never past the first one not done; `stepHref(url, key)` links to a step, keeping the other params.
- Each step posts to an action whose schema is its part of the form. The action calls `stepDraft(ctx.cookies, 'signup', { check, request: ctx.request }).save('account', input)` and redirects to `stepHref(ctx.url, 'profile')`; the last reads `merged()` and calls `clear()`. The draft is an `httpOnly` cookie for an hour (`maxAge`, `path`), `secure` when `request` came over https (`secure` forces it), not tied to a session so `clear()` it on sign-out, `save` throwing a `RangeError` past 3,800 encoded bytes, and a step counts as `done()` only while the required `check(step, values)` accepts its values (a schema with `additionalProperties: false`), as the visitor can edit the cookie. The full flow is in the [Steps page](/ui/steps).

FormField also works outside a dialog, in a plain form posting to an action:

- `issue` shows a message of the page's own, such as `rename.failed()?.errors.title`.
- `hint` explains the control, under it. `action` sits at the end of the label's line. `required` marks the label with a `*` hidden from screen readers, which read the control's own `required`.
- The label holds only the label's text and the control, so the hint, the messages and the action stay out of the control's accessible name.
- Inside an island, as in a FormDialog, the control's `aria-describedby` gains the hint and, while one shows, the messages, beside the ids it had, and the control is `aria-invalid` while a message shows. A FormDialog refusing a field focuses the first one marked so. On a static page, kay marks the fields of a refused plain post `aria-invalid` itself.
- `group` makes it a `fieldset` with a `legend`, for a control made of several inputs.
- Its messages sit in an `aria-live` region, so a screen reader reads them as they appear.
- `compact` sizes it by its control rather than the row, for a filter bar of fields side by side, a Select inside as wide as its options with no class. It holds no message region then unless given a `name` or an `issue`.

`ContactForm(action={contact})` is the form for the action `contactForm(mail, ...)` from kayjs-mail builds (any action with `name`, `email` and `message` fields works): a `form` posting without JavaScript, a FormField per field with the message the action refused it with, a submit button, and a `Notice` that the message went out (`sentLabel`) or why not (`contact.error()`). The labels read the `ui.contactForm.*` messages, then kayjs-mail's `mail.contact.form` ones in the page's language (English else), and the `*Label` props replace them.

- Fields beyond the three go in as children, between the email and the message, in a `FormField` with `issue={contact.error('topic')}` and a control named with `name`, since `field` is only valid inside the form's own markup.
- `nameLabel`, `emailLabel`, `messageLabel`, `submitLabel`, `sentLabel` replace the labels from the `ui.contactForm.*` messages, then kayjs-mail's `mail.contact.form` ones, `rows` sets the message box, `class` goes on the form.
- An action with `consent: true` gets a consent checkbox (`consentLabel`), read from the `consent` field `contactForm({ consent: true })` marks, so an app's own `consent` extra field or hand-written schema gets none (write `consent` on the form to force the box, as inside an island, where the action carries no schema to read), and `privacy="/privacy"` links the privacy page after it (`privacyLabel`).

A GET filter form, whose every pick lands in the URL, submits as soon as a Select changes with `submit`, no ref to the form needed:

```kay
form.flex.flex-wrap.items-end.gap-3(method="get" role="search")
  FormField(label="Period" compact)
    Select(name="period" value={filters.period} options={PERIODS} emptyOption="Last 7 days" submit)
  FormField(label="Host" compact)
    input(name="host" value={filters.host} autocomplete="off")
  Button(type="submit" label="Filter")
```

## Reference

- FormDialog gives the action the form's `FormData`: give each control the `name` of its field in the action's schema, and numbers, booleans and lists are coerced from their text, while files and the honeypot come along.
