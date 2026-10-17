# kayjs-ui: Inputs, selects, editors and forms

## Components

### TextInput, Textarea, Select

- `TextInput(value={title()} onInput={title.set} onChange={save})`:
  - `onInput(value)` runs on each keystroke, and `onChange(value)` once the value is committed, on blur or Enter. `onBlur(event)` gets the box's own blur, as on an `input`.
  - `type="number"` hands back a number, or `null` once emptied, to both callbacks, and takes a number, `null` or a string as `value`: `TextInput(type="number" value={count()} onInput={count.set})` with `signal<number | null>(1)`. A box partway through a number, such as `1,`, reports nothing until it parses. A parent writing back its own spelling of the same number leaves the caret alone.
  - Without `value` and `onInput` it is a plain field keeping what is typed, for a form posting to an action without JavaScript: `TextInput(name="email" type="email" required autocomplete="email")`, with `value` to start it filled. kay refills only the fields a form's own template writes, so pass `value={failure?.values.email}` to keep what a refused post sent.
- `Textarea(value={notes()} onInput={notes.set})`: the multi-line TextInput, taking the same props, `rows` among the rest, and working as a plain field without `value` and `onInput`. While focused it keeps the text as typed, and takes the parent's reading of it, such as without a blank line, once left.
- `Select(value={kind()} options={[{ value: 'post', label: 'Post' }]} onChange={kind.set} emptyOption="Any")`:
  - `value` and `onChange` take the type of the options' values, so a union stays a union and a number option hands back a number: `const kind = signal<'post' | 'page'>('post')` passes `kind.set` with no cast.
  - `emptyOption` adds a first option worth `''`, labelled by the string, or blank with `true`; `value` and `onChange` then take `''` too, so hold a `signal<Kind | ''>`.
  - An option is `{ value, label, disabled? }`; `disabled` keeps it from being picked. A native option draws no icon, unlike the other groups' options.
  - `loading` shows a disabled row saying `loadingLabel` while the options are on their way.
  - The right option stays chosen when the options arrive after the value.
  - `submit` submits the form holding it once an option is picked, after `onChange`, for a GET filter form (see Forms).

### RangeInput, MultiSelect, FileDrop, Menu, IconPicker

- `RangeInput(label="Hours" min={0} max={24} unit="h" value={[2, null]} onChange={hours.set})`: two number boxes for a range, each bound open when empty (`null`). `onChange([from, to])` runs once a box is committed, on blur or Enter, and only when the range changed; a reversed pair is put back in order in the boxes too. Each box is named `{label} from` and `{label} to`, or `fromLabel` and `toLabel`. `rangeFrom(low, high)` reads two strings the same way, for a server reading the posted boxes.
- `MultiSelect(label="Planets" options={planets} value={['mars']} name="planet" onChange={picked.set})`:
  - A trigger summing up what is picked (`placeholder`, `Any` by default, the one label, or "2 selected", worded by `selectedLabel(count)`) opens a popover of checkboxes with All and None, a group named by `label`. Screen readers hear the trigger as `{label}: {summary}`, a count described by the labels it stands for, and `emptyLabel` from a status region once the search hides every option.
  - Past eight options, or with `search`, the panel opens on a search box filtering the options, focused; otherwise the first checkbox takes focus. ArrowDown reaches the options, where the arrows, Home and End move between them, a tint and an accent bar marking the one the keyboard is on; Tab past the last control closes the panel, and Escape closes it with focus back on the trigger.
  - What is picked stays in the options' order, an array of the options' own value type, so a union-typed list needs no cast. `name` posts each picked value as a hidden field, so the control submits inside a plain form.
- `FileDrop(accept="image/*" multiple paste onFiles={upload})` with a `@content(zone)` block:
  - Files dropped on the zone, picked through `zone.open()` or, with `paste`, pasted anywhere on the page outside a text field, reach `onFiles(files)`: those `accept` allows, one unless `multiple`, never an empty list. A file the browser gives no type, such as a `.csv` on Windows, passes a type in `accept`, for its receiver to judge by its name. `onReject(files)` gets the dropped or picked files `accept` leaves out (not pasted ones), to say why they were ignored.
  - `zone.dragging()` reads whether files hover the zone, which also carries `data-dragging`.
  - `compact` draws it as a slim row, its content from the left, to sit inline in a form rather than as a large target.
- `Menu(label="Actions" icon="plus" items={[{ label: 'Rename', onSelect: rename }, 'separator', { label: 'Delete', icon: 'delete', danger: true, onSelect: remove }]})`:
  - An IconButton opening a `role="menu"` popover; `'separator'` draws a rule between groups, and `class` styles that button.
  - Opening focuses the first enabled entry; the arrows, Home and End move between enabled entries, an accent bar marking the one the keyboard is on, and Tab closes it.
  - An entry's `onSelect` runs once the menu has closed and focus is back on the trigger, so a dialog it opens takes focus from there.
- `IconPicker(search={findIcons} value={post.icon} name="icon" onChange={icon.set})`:
  - A search box over a grid of the icons `search(query, limit, offset)` returns, from the `offset`th on, as `IconChoice`s, `{ name, icon }` with `icon` the IconProps to draw: typically an action, since a whole icon set is too large to ship, as `search={(query, limit, offset) => findIcons({ query, limit, offset })}`. The app's action builds them on the server with kay's `iconNames` and `iconProps` over the set's JSON, so the set never ships to the browser:

    ```ts
    import tabler from '@iconify-json/tabler/icons.json'
    import { s } from 'kay'
    import { iconNames, iconProps } from 'kay/icons'

    export const findIcons = action(s.Object({ query: s.String({ maxLength: 200 }), limit: s.Integer(), offset: s.Integer() }), async ({ query, limit, offset }) =>
      iconNames(tabler).filter(name => name.includes(query)).slice(offset, offset + limit).map(name => ({ name: `tabler:${name}`, icon: iconProps(tabler, name)! })))
    ```

  - The search runs 200ms after the typing pauses, from 50 icons; `Show more` asks for the next 50, at `offset` 50, 100 and so on, once a page comes back full, and adds them to the grid. A page with no icon the grid lacks, as an app ignoring `offset` gives, ends the paging. The last grid stays while a search is in flight, and a search a later one overtook is dropped.
  - Picking the chosen icon again, or the selection's clear button, clears it: `onChange` gets the name, or an empty string. The tooltip and label read the name without its `prefix:`.
  - `name` submits the chosen name as a hidden field, which fires a bubbling `input` event on each pick. Enter in the search box never submits the form.
  - The selection draws the chosen icon once a search found it; a `value` no search returned yet shows its name alone.
- MultiSelect and Menu draw their popover's id as Popover does, or take an `id`. RangeInput and MultiSelect take data alone, so a static page can hold them; FileDrop, Menu and IconPicker take functions, so they render inside an island.

### MarkdownEditor

- `MarkdownEditor(value={body()} onInput={body.set} onImage={upload} name="body")`: a markdown `textarea` that writes like an editor, in an island.
  - Ctrl or Cmd with B, I or K wraps the selection in bold, italics or a link; Enter continues a list, and Tab indents a list item, leaving Tab alone elsewhere and after Escape, so the keyboard can always leave the field; `keysHint` tells screen readers so, as the field's description. These go through the browser's own editing, so Ctrl+Z undoes them like typing.
  - A page pasted as HTML turns into markdown.
  - With `onImage(file)`, a pasted or dropped image is embedded behind an `![Uploading …]()` placeholder at once, swapped for `![](url)` once `onImage` resolves with its url, or removed, line break included, with `uploadFailure` toasted if it throws (or a refusal of the whole call such as a limit, as `attempt` does). Writing goes on meanwhile, and a finished upload never takes focus back; the field is `aria-busy` while one is under way.
  - It shows about 12 lines and grows with its text up to 70% of the screen, where the browser sizes a field by its content (Chromium); it can be resized by hand.
  - `onInput(value)` reports the text after every change, typed or applied. A parent passing other text replaces it; passing back what it was given leaves the caret alone.

## Forms

FormField frames a control with its label, hint and messages; inside an island a `group` given a message marks each input, select and textarea in it `aria-invalid` and described by the message, so `focusInvalid` reveals its tab and focuses its first field. FormDialog calls a page's action from a dialog and shows the message of each refused field on its FormField. SaveForm does the same for an editor page, with a sticky bar of unsaved changes.

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
- When the action refuses a field, its message shows on the FormField with that `name`, and the dialog stays open.
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
- Discard resets the controls to their initial values, or to the saved ones once a save has run, clears the messages and calls `onDiscard`, for state the page keeps beyond the controls. The signal-driven controls (Checkbox, Toggle, ChipGroup, Segmented, Select, MultiSelect, IconPicker, TextInput, Textarea, MarkdownEditor, RangeInput) follow any `form.reset()`, a `<button type="reset">` included, and tell their `onChange` (a text field, `onInput` or else `onChange`) what they went back to. The start is what the control was first drawn with, so a controlled one whose value arrived later goes back to the first; a Segmented that started with none picked shows none and tells `onChange` `null`, which its type allows only when `value` is typed nullable. A Checkbox, Toggle, ChipGroup or Segmented busy with a promise from its `onChange` lets a reset wait for it, then goes back and tells the app, unless the refusal already put it there. The search box of an IconPicker or MultiSelect is no saved value: a reset empties it after a save.
- Leaving with unsaved changes asks as `guardLeave` does, except while a save runs. Cmd+S on macOS and Ctrl+S elsewhere save from any field, on the key that types an S whatever the layout (`shortcut('mod+s')`).
- The status line is a live region; the buttons use `aria-disabled`, so the focus stays on the one pressed as the form turns clean. `dirtyLabel`, `cleanLabel`, `savingLabel`, `saveLabel` and `discardLabel` replace the texts.

FormField also works outside a dialog, in a plain form posting to an action:

- `issue` shows a message of the page's own, such as `ctx.failed(rename)?.errors.title`.
- `hint` explains the control, under it. `action` sits at the end of the label's line. `required` marks the label with a `*` hidden from screen readers, which read the control's own `required`.
- The label holds only the label's text and the control, so the hint, the messages and the action stay out of the control's accessible name.
- Inside an island, as in a FormDialog, the control's `aria-describedby` gains the hint and, while one shows, the messages, beside the ids it had, and the control is `aria-invalid` while a message shows. A FormDialog refusing a field focuses the first one marked so. On a static page, kay marks the fields of a refused plain post `aria-invalid` itself.
- `group` makes it a `fieldset` with a `legend`, for a control made of several inputs.
- Its messages sit in an `aria-live` region, so a screen reader reads them as they appear.
- `compact` sizes it by its control rather than the row, for a filter bar of fields side by side, a Select inside as wide as its options with no class. It holds no message region then unless given a `name` or an `issue`.

`ContactForm(action={contact})` is the form for the action `contactForm(mail, ...)` from kayjs-mail builds (any action with `name`, `email` and `message` fields works): a `form` posting without JavaScript, a FormField per field with the message the action refused it with, a submit button, and a `Notice` that the message went out (`sentLabel`) or why not (`contact.error()`). The labels read the `ui.contactForm.*` messages, then kayjs-mail's `mail.contact.form` ones in the page's language (English else), and the `*Label` props replace them.

- Fields beyond the three go in as children, between the email and the message, in a `FormField` with `issue={contact.error('topic')}` and a control named with `name`, since `field` is only valid inside the form's own markup.
- `nameLabel`, `emailLabel`, `messageLabel`, `submitLabel`, `sentLabel` replace the labels from the `ui.contactForm.*` messages, then kayjs-mail's `mail.contact.form` ones, `rows` sets the message box, `class` goes on the form.

A GET filter form, whose every pick lands in the URL, submits as soon as a Select changes with `submit`, no ref to the form needed:

```kay
form.flex.flex-wrap.items-end.gap-3(method="get" role="search")
  FormField(label="Period" compact)
    Select(name="period" value={filters.period} options={PERIODS} emptyOption="Last 7 days" submit)
  FormField(label="Host" compact)
    input(name="host" value={filters.host} autocomplete="off")
  Button(type="submit" label="Filter")
```
