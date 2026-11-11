# kayjs-ui: Forms, FormDialog and Steps

## Common tasks

### Forms and Steps

FormField frames a control with its label, hint and messages; inside an island a `group` given a message marks each input, select and textarea in it `aria-invalid` and described by the message, so `focusInvalid` reveals its tab and focuses its first field. A `required` FormField gives its control, each field of a `group`, `aria-required="true"` unless it sets its own, as the `*` and the `required` word after it (`ui.field.required`) are hidden from screen readers, and the native `required` (not on the boxes of a group of checkboxes, which would all be asked for), server-rendered too, so the browser and a post with no JavaScript know it; turning it off takes both back. FormDialog calls a page's action from a dialog and shows the message of each refused field on its FormField. SaveForm does the same for an editor page, with a sticky bar of unsaved changes.

```kay
--- server
import { s, action } from 'kay'

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
Button(label="Rename" onClick={() => editing = true})
FormDialog(open={editing()} title="Rename" action={rename} submitLabel="Rename" failureLabel="Could not rename" onSave={saved => title = saved.title} onOpenChange={() => editing = false})
  input(type="hidden" name="id" value={post.id})
  FormField(label="Title" name="title" required)
    input.kui-field-input(name="title" value={title()})
```

- FormDialog calls `action` with `new FormData(form)`, read on the server as a plain form post and answered as a call. An action that redirects takes the browser there instead.
- When the action refuses a field, its message shows on the FormField with that `name`, and the dialog stays open. That is the `formIssues` context of kayjs-ui, which FormDialog, SaveForm and Form provide in an island and a FormField reads: a form of your own that calls an action by hand does `formIssues.provide(() => ({ title: 'Too short' }))` to show messages the same way.
- A refused message no FormField shows is toasted instead, a refusal of the whole form under the empty name included. A failure carrying no message toasts `failureLabel`, `Could not save.` by default.
- A refusal of the handler, `ctx.fail(400, { error: 'Slug taken' })`, reaches the dialog through `refused`, which reads that data and answers a message per field (`{ slug: data.error }`), shown on the FormFields, or one message (`data.error`), toasted. Without `refused`, or when it answers undefined, a string `ctx.fail` data or a string `error` or `message` in it that reads as a message is toasted, else `failureLabel`: `FormDialog(... failureLabel="Could not save" refused={data => data.error})`.
- A save hands what the action returned to `onSave`, then closes the dialog. A refusal or a failure calls `onError({ error })` before the toast, with the `ActionError` (its `errors` by field, its `data`) or whatever the call threw, and the dialog stays open.
- `rowEditing<Row, Draft>()`, from the package, keeps which row one dialog adds or edits for a list: `edit(row)` opens it on a row, `create(draft)` on what a new row starts from, `close` shuts it, forgetting both, and `open()`, `row()` and `draft()` read it: `FormDialog(open={friend.open()} title={friend.row() ? 'Edit friend' : 'Add friend'} ... onOpenChange={friend.close})`. Without `Draft`, `create()` takes nothing.
- The submit button sits in the footer, paired with the form by `id`. Without an `id`, it draws one unique on the page.
- Enter submits from a single-line field, and Ctrl+Enter from a textarea. While the call is under way, the buttons are disabled, and Escape or a click outside leaves the dialog open.
- `extra` fills the left end of the footer, for a ConfirmDelete with `triggerLook="button"`.

A form needs no wiring per field: a FormField (and a Checkbox or Toggle) with a `name` inside any `form(action={add})` shows `add.error('name')`, with and without JavaScript, so `issue` is for a message of your own only. `formErrors()` from `kay` is what they read, for a component of yours drawing a field: `const errors = formErrors()` in its script, then `errors('title')` where it shows the message. An empty message (`''`) is dropped, so a field shows nothing for it. An island's own template does not know a `form(action)` of the page around it: inside an island, wrap the fields in `Form(action={add})` or pass `issue`. `validate` on Form, SaveForm and FormDialog checks the fields against the action's schema in the browser, with the messages the server would give, shown on their FormField like a refusal's: `validate="submit"` when the form is sent (nothing is called while a field is refused, the first invalid field takes the focus) and `validate="blur"` also each field as it loses focus, its message going once the value is fixed. `false`, the default, leaves it to the server; files and missing fields are the server's either way, and a SaveForm with `save` reads none. It is `action.validate(form, field?)` underneath (see [Actions](../../../llms/actions.md)), which an island of your own calls to fill `add.error(field)`. A plain `form(action)` keeps the browser's bubble at submit.

The FormFields (and Checkboxes and Toggles) a static page hands Form, FormDialog or SaveForm as children need no component of yours: after a call made with JavaScript the form writes the message into each, links it and marks the control `aria-invalid`, and takes them away once a call goes through, a SaveForm discards or a FormDialog closes, from a chunk fetched only for a form holding such a field.

`Form(action={add})` is the plain form of a page, the FormDialog's call without the dialog: it posts as a form without JavaScript, and with JavaScript calls the action, shows each refused field's message on its FormField, focuses the first invalid field and toasts what no field shows. It takes `failureLabel`, `refused`, `saved`, `onSave` and `onError` as SaveForm and FormDialog do, and `class` and any other `form` attribute; the submit button is yours.

```kay
Form(action={add} saved="Added.")
  FormField(label="Title" name="title" required)
    input(name="title")
  Button(type="submit" label="Add")
```

SaveForm is the form of an editor page: `SaveForm(action={rename} failureLabel="Could not save" saved="Saved.")` around the fields, each control named as for FormDialog, draws a sticky bar with a status line, Discard and Save.

- The form is dirty while its controls differ from what they held when it was last clean, so typing a change back cleans it, and a control added or removed counts. A control set from code needs an `input` event dispatched on it.
- Save calls `action` like FormDialog, with `refused` and `failureLabel` working the same, and does nothing while the form is clean or a save runs. A failure keeps the bar dirty, a refused field takes the focus, and edits made during the save stay unsaved. A save toasts `saved` when given, calls `onSave(result)` and leaves the form clean. A refusal or a failure calls `onError({ error })` first, with the `ActionError` (its `errors` by field, its `data`) or whatever the call threw, before the toast.
- An editor whose state is signals and whose save takes an object gives `dirty={isNew || changed()}` and `save={() => save({ name, config })}` instead of `action`: the bar, the leave guard, Save and the shortcut follow `dirty`, `save` answers the call's promise (a rejection is handled as an action's refusal is, `refused`, the messages on their FormField and `failureLabel` included; `false` is a refusal the app shows itself; both leave the bar unsaved; `onSave` is for `action` only), the app clears `dirty` once it has saved, and `status` replaces the status line. `failure` defaults to a message of the page's language.
- Discard resets the controls to their initial values, or to the saved ones once a save has run, clears the messages and calls `onDiscard`, for state the page keeps beyond the controls. The signal-driven controls (Checkbox, Toggle, ChipGroup, Segmented, Select, MultiSelect, IconPicker, TextInput, Textarea, MarkdownEditor, RangeInput, DateInput, DateRangeInput, DateTimeInput, TimeInput) follow any `form.reset()`, a `<button type="reset">` included, and tell their `onChange` (a text field, `onInput` or else `onChange`) what they went back to. The start is what the control was first drawn with, so a controlled one whose value arrived later goes back to the first; a Segmented that started with none picked shows none and tells `onChange` `null`, which its type allows only when `value` is typed nullable. A Checkbox, Toggle, ChipGroup or Segmented busy with a promise from its `onChange` lets a reset wait for it, then goes back and tells the app, unless the refusal already put it there. The search box of an IconPicker or MultiSelect is no saved value: a reset empties it after a save.
- `cancelHref="/sites"` adds a Cancel link before Discard, for a new item with nothing to go back to but the page it came from. `confirm="Apply this change?"` asks in a dialog before saving, the shortcut included, and saves once confirmed (`confirmLabel`, `saveLabel` by default; `cancelLabel`); the dialog is a chunk fetched as the form mounts, so a Save pressed before it is there stays busy until it opens, and one that cannot fetch it toasts `failureLabel` and saves nothing. `saveDisabled="The name is empty."` keeps Save and the shortcut off, the string being Save's tooltip, which the keyboard reaches; `true` gives no reason.
- Leaving with unsaved changes asks as `guardLeave` does, except while a save runs. Cmd+S on macOS and Ctrl+S elsewhere save from any field, on the key that types an S whatever the layout (`shortcut('mod+s')`); `shortcut="ctrl+enter"` changes the keys, any string kay's `shortcut` takes, and `shortcut={false}` binds none.
- The status line is a live region; the buttons use `aria-disabled`, so the focus stays on the one pressed as the form turns clean. `dirtyLabel`, `cleanLabel`, `savingLabel`, `saveLabel` and `discardLabel` replace the texts.

A form in steps keeps the step in the URL: `Steps(steps={[{ key: 'account', label: 'Account' }]} current={current} done={done} url={url} label="Signup")`, `url` being the fence's `ctx.url`, draws the numbered row, a step before the current one or in `done` a link back (`param`, `step` by default; `doneLabel`). Parts: `root`, `list`, `item`, `link`, `marker`, `label`, `state`; an item carries `data-step` (`current`, `done` or `upcoming`) and `data-outcome` (`error`, `skipped`). `onSelect(key)` drives a wizard with no navigation (`url` can then be left out, a done or `linkable` step is a button; with a `url` the link stays and a plain click calls it instead), a step takes `state`, `icon` and `linkable`, and the `@step(step, state)` block draws its markup and `stepLabel(step, state)` returns its text.

- `currentStep(ctx.url, keys, done)` reads the step off the URL, never past the first one not done; `stepHref(url, key)` links to a step, keeping the other params.
- `steps` is an `OptionsSource` like the options of RadioGroup: a list, a promise or a function returning one, asked in the browser, the row `aria-busy` with a `status` row of `loadingLabel` (`ui.steps.loading`) until it answers or an alert row of `failureLabel` with a `retryLabel` button (a function source only) when it rejects, with `onLoad(steps, query)` and `onError({ error, query })`. New parts `status` and `retry`.
- Each step posts to an action whose schema is its part of the form. The action calls `stepDraft(ctx.cookies, 'signup', { check, request: ctx.request }).save('account', input)` and redirects to `stepHref(ctx.url, 'profile')`; the last reads `merged()` and calls `clear()`. The draft is an `httpOnly` cookie for an hour (`maxAge` as a duration such as `'30m'`, `path`), `secure` when `request` came over https (`secure` forces it), not tied to a session so `clear()` it on sign-out, `save` throwing a `RangeError` past 3,800 encoded bytes, and a step counts as `done()` only while the required `check(step, values)` accepts its values (a schema with `additionalProperties: false`), as the visitor can edit the cookie. The full flow is in the [Steps page](/ui/steps).

FormField also works outside a dialog, in a plain form posting to an action:

- `issue` shows a message of the page's own, such as `rename.failed()?.errors.title`.
- `hint` explains the control, under it. `@actions` sits at the end of the label's line. `required` marks the label with a `*` hidden from screen readers, which read the control's own `required`.
- The label holds only the label's text and the control, so the hint, the messages and the action stay out of the control's accessible name.
- Inside an island, as in a FormDialog, the control's `aria-describedby` gains the hint and, while one shows, the messages, beside the ids it had, and the control is `aria-invalid` while a message shows. A FormDialog refusing a field focuses the first one marked so. On a static page, kay marks the fields of a refused plain post `aria-invalid` itself.
- `group` makes it a `fieldset` with a `legend`, for a control made of several inputs.
- Its messages sit in an `aria-live` region, so a screen reader reads them as they appear.
- `size="sm"` (`md` by default) sizes it by its control rather than the row, for a filter bar of fields side by side, a Select inside as wide as its options with no class, up to the row: a long option is cut in the closed select, never pushing the page sideways. It holds no message region then unless given a `name` or an `issue`, and a `class` such as `w-48` on it replaces its width. A medium Button in the same parent, such as the submit button below, or beside a MultiSelect or any island holding such fields, is as tall as the fields at any `--density`; another size, `variant="inline"` and a Button elsewhere keep their height.

`ContactForm(action={contact})` is the form for the action `contactForm(mail, ...)` from kayjs-mail builds (any action with `name`, `email` and `message` fields works): a `form` posting without JavaScript, a FormField per field with the message the action refused it with, a submit button, and a `Notice` that the message went out (`sentLabel`) or why not (`contact.error()`). The labels read the `ui.contactForm.*` messages, then kayjs-mail's `mail.contact.form` ones in the page's language (English else), and the `*Label` props replace them.
- `onSend(data)` runs once the message went out, with what the action returned (an analytics conversion, closing a dialog around the form), and `onError(failure)` when the post was refused or failed, with `contact.failed()`'s `{ status, message, errors, data }`; the notice and the messages still show. `@sent` replaces the success notice. A form given neither stays static; the callbacks are functions, so they go to a form inside an island.

- Fields beyond the three go in as children, between the email and the message, in a `FormField` with a `name` (`FormField(label="Topic" name="topic")`) and a control named the same.
- `nameLabel`, `emailLabel`, `messageLabel`, `submitLabel`, `sentLabel` replace the labels from the `ui.contactForm.*` messages, then kayjs-mail's `mail.contact.form` ones, `rows` sets the message box, `class` goes on the form.
- An action with `consent: true` gets a consent checkbox (`consentLabel`), a Checkbox (restyle it as `Checkbox`, its parts nested under ContactForm's `consent`), read from the `consent` field `contactForm({ consent: true })` marks, so an app's own `consent` extra field or hand-written schema gets none (write `consent` on the form to force the box, as inside an island, where the action carries no schema to read), and `privacy="/privacy"` links the privacy page after it, with or without the consent (`privacyLabel`).

`SubscribeForm(action={subscribe})` is the same for the list action `mail.list().form()` from kayjs-mail builds (any action with an `email` field works): a required email in a FormField whose refusal is tied to the input by `aria-describedby`, a notice saying what the address is used for, a submit button and a `Notice` that the confirmation mail went (`sentLabel`) or why not. The labels read the `ui.subscribeForm.*` messages, then kayjs-mail's `mail.list.form` ones.

- `noticeText` replaces the stock notice (say who writes, what and how often), `privacy="/privacy"` links the policy after it (`privacyLabel`; left out, the list's own `privacy` option, which the form reads off its action), `wordingId` names the notice's version, which the list keeps with the confirmation as proof; `label`, `submitLabel`, `sentLabel` replace the other texts, `class` goes on the form. Parts: `root`, `notice`.
- `onSend(data)`, `onError(failure)` and the `@sent` block work as ContactForm's, and children go in as extra fields, between the email and the notice.

A GET filter form, whose every pick lands in the URL, submits as soon as a Select changes with `submit`, no ref to the form needed:

```kay
form.flex.flex-wrap.items-end.gap-3(method="get" role="search")
  FormField(label="Period" size="sm")
    Select(name="period" value={filters.period} options={PERIODS} emptyOption="Last 7 days" submit)
  FormField(label="Host" size="sm")
    input(name="host" value={filters.host} autocomplete="off")
  Button(type="submit" label="Filter")
```

### RecordButton

- `RecordButton(onRecord={audio => transcribe({ audio })})`: records the microphone and hands `onRecord` a `File` (`recording.webm`, `recording.m4a` in Safari), which an `s.File()` field takes as it is. A press asks for the microphone and records, the button pressed (`aria-pressed`) with the `stop` icon and the time beside it; the next press stops and hands it over, busy while the promise `onRecord` returns pends, and a rejection says `failureLabel`. Escape drops the recording, and `maxDuration` (`5m`) stops one left running. The microphone is released however it ends.
- `onStart()` runs once the microphone is open, `onStop('press' | 'limit')` as a recording ends (before `onRecord`), `onCancel()` on Escape, and `onError({ problem, error? })` with the code of the notice below (`denied`, `missing`, `taken`, `insecure`, `unsupported`, `failed`, `lost`, `empty`) or `'send'` with `onRecord`'s rejection as `error`.
- `recording` and `onRecordingChange(recording)` are the state pair: `onRecordingChange` says `true` as a recording starts (the microphone is asked for) and `false` once it is over, however it ended (the press that stops it, Escape, `maxDuration`, a refused or lost microphone, the button going away), before `onStop` and `onRecord`. Give `recording` and the app drives it, `true` starting a recording as a press would and `false` stopping it and handing it over (one still asking for the microphone stops as soon as it opens); left out, the button keeps it itself. Only a change of `recording` acts, so a recording that ended on its own is not started again.
- A danger notice says what went wrong: a microphone blocked, missing, in use or unplugged mid-recording (which drops it), a page off https, a browser that cannot record, nothing recorded. A hidden status region says when it starts, stops and is dropped. `label` (`Record`) names it, `microphone` is its icon slot, and it takes Button's `variant`, `tone` and `size`.
- `recorder()` and `recordWords()` from `@kaynooo/kayjs-ui/lib/record` are its state for a button drawn otherwise, as kayjs-ai's Chat draws its microphone (its browser code loads once one mounts); `recorder` takes the same callbacks.

## Reference

- FormDialog gives the action the form's `FormData`: give each control the `name` of its field in the action's schema, and numbers, booleans and lists are coerced from their text, while files and the honeypot come along.
