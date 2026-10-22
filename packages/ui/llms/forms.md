# kayjs-ui: Inputs, selects, editors and forms

## Common tasks

### TextInput, Textarea, Select

- `TextInput(value={title()} onInput={title.set} onChange={save})`:
  - `onInput(value)` runs on each keystroke, and `onChange(value)` once the value is committed, on blur or Enter. `onBlur(event)` gets the box's own blur, as on an `input`.
  - `type="number"` hands back a number, or `null` once emptied, to both callbacks, and takes a number, `null` or a string as `value`: `TextInput(type="number" value={count()} onInput={count.set})` with `signal<number | null>(1)`. A box partway through a number, such as `1,`, reports nothing until it parses. A parent writing back its own spelling of the same number leaves the caret alone.
  - Without `value` and `onInput` it is a plain field keeping what is typed, for a form posting to an action without JavaScript: `TextInput(name="email" type="email" required autocomplete="email")`, with `value` to start it filled. kay refills only the fields a form's own template writes, so pass `value={failure?.values.email}` to keep what a refused post sent.
- `Textarea(value={notes()} onInput={notes.set})`: the multi-line TextInput, taking the same props, `rows` among the rest, and working as a plain field without `value` and `onInput`. While focused it keeps the text as typed, and takes the parent's reading of it, such as without a blank line, once left, except an empty text, which it takes at once, as a chat clears its draft after a send; `writeFocused` lets any write land while focused, the caret going to the end.
- `Select(value={kind()} options={[{ value: 'post', label: 'Post' }]} onChange={kind.set} emptyOption="Any")`:
  - `value` and `onChange` take the type of the options' values, so a union stays a union and a number option hands back a number: `const kind = signal<'post' | 'page'>('post')` passes `kind.set` with no cast.
  - `emptyOption` adds a first option worth `''`, labelled by the string, or blank with `true`; `value` and `onChange` then take `''` too, so hold a `signal<Kind | ''>`.
  - An option is `{ value, label, disabled? }`; `disabled` keeps it from being picked. A native option draws no icon, unlike the other groups' options.
  - `loading` shows a disabled row saying `loadingLabel` while the options are on their way.
  - The right option stays chosen when the options arrive after the value.
  - `submit` submits the form holding it once an option is picked, after `onChange`, for a GET filter form (see Forms). A pointer pick submits at once; a keyboard pick, reported by some browsers on each arrow key, waits for Enter or blur.

### DateInput, DateRangeInput, TimeInput

- `DateInput(aria-label="Due" name="due" value={due()} min="2026-01-01" max="2026-12-31" onChange={due.set})`: a native `input type="date"` holding `YYYY-MM-DD` (or `''` for none), so a form posts it with no JavaScript and the browser keeps its own keyboard entry. Once the island runs it adds a calendar button opening a popover in the page's locale, its weeks starting on the locale's first day or on `firstDay` (0 for Sunday to 6 for Saturday); days outside `min` and `max` are disabled.
  - Without `value` it keeps what is picked, for a form posting it by its `name`; with it, `onChange(value)` hears every change, typed, picked or reset by a form, and the field follows the parent.
  - Keyboard: the calendar opens on the chosen day (else today); the arrows move by day and week, Home and End to the ends of the week, PageUp and PageDown by month and with Shift by year, Enter or Space picks, Escape closes with focus back on the button. It is a labelled dialog holding a `grid` of day buttons named in full (`Wednesday 21 October 2026`), the month announced as it changes.
  - Other props are the input's own (`name`, `required`, `disabled`, `id`); `openLabel`, `previousLabel`, `nextLabel` and `todayLabel` replace the `ui.dateInput.*` messages.
- `DateRangeInput(label="Stay" fromName="from" toName="to" value={stay()} onChange={stay.set})`: two DateInputs for a `DateRange` (`[from, to]` of `YYYY-MM-DD` or `null`, open when empty), named `{label} from` and `{label} to` or by `fromLabel` and `toLabel`. `onChange` runs when a date is set and only when the range changed; a reversed pair is put back in order in both boxes. `dateRangeFrom(from, to)` reads the two posted strings the same way on the server.
- `TimeInput(aria-label="Start" name="start" value="09:30" step={900} onChange={start.set})`: a native `input type="time"` holding `HH:MM` (`HH:MM:SS` under a minute's `step`), the same plain field without `value`.

### RangeInput, Slider, MultiSelect, Combobox, FileDrop, Menu, IconPicker

- `RangeInput(label="Hours" min={0} max={24} unit="h" value={[2, null]} onChange={hours.set})`: two number boxes for a range, each bound open when empty (`null`). `onChange([from, to])` runs once a box is committed, on blur or Enter, and only when the range changed; a reversed pair is put back in order in the boxes too. Each box is named `{label} from` and `{label} to`, or `fromLabel` and `toLabel`. `rangeFrom(low, high)` reads two strings the same way, for a server reading the posted boxes.
- `Slider(label="Delay" min={0} max={500} step={10} value={delay()} formatValue={ms => `${ms} ms`} name="delay" onInput={delay.set})`: one value on a native `input type="range"`, the label and the value written above the track, drawn from the theme (accent thumb, field-border track) so an app styles no `::-webkit-slider-thumb`. Pick Slider for one number, RangeInput for a from/to pair. `onInput(number)` runs on every move of the thumb and after a form reset with the value it went back to; `showValue={false}` hides the written value, `formatValue` words it and the `aria-valuetext`. A `value` the parent passes later is followed, and `name`, `id`, `disabled` and the other input attributes go on the input, which posts its number in a plain form.
- `MultiSelect(label="Planets" options={planets} value={['mars']} name="planet" onChange={picked.set})`:
  - A trigger summing up what is picked (`placeholder`, `Any` by default, the one label, or "2 selected", worded by `selectedLabel(count)`) opens a popover of checkboxes with All and None, a group named by `label`. Screen readers hear the trigger as `{label}: {summary}`, a count described by the labels it stands for, and `emptyLabel` from a status region once the search hides every option.
  - Past eight options, or with `search`, the panel opens on a search box filtering the options, focused; otherwise the first checkbox takes focus. ArrowDown reaches the options, where the arrows, Home and End move between them, a tint and an accent bar marking the one the keyboard is on; Tab past the last control closes the panel, and Escape closes it with focus back on the trigger.
  - An option is `{ value, label, icon?, disabled? }` as in the other groups: `icon` sits before the label, and a `disabled` option cannot be flipped and stays as it is under All and None.
  - What is picked stays in the options' order, an array of the options' own value type, so a union-typed list needs no cast. `name` posts each picked value as a hidden field, so the control submits inside a plain form.
- `FileDrop(accept="image/*" multiple paste onFiles={upload})` with a `@content(zone)` block:
  - Files dropped on the zone, picked through `zone.open()` or, with `paste`, pasted anywhere on the page outside a text field, reach `onFiles(files)`: those `accept` allows, one unless `multiple`, never an empty list. A file the browser gives no type, such as a `.csv` on Windows, passes a type in `accept`, for its receiver to judge by its name. `onReject(files)` gets the dropped or picked files left out (not pasted ones), those `accept` refuses and, without `multiple`, the matching ones beyond the first, to say why they were ignored.
  - `zone.dragging()` reads whether files hover the zone, which also carries `data-dragging`.
  - `compact` draws it as a slim row, its content from the left, to sit inline in a form rather than as a large target.
- `Menu(label="Actions" icon="plus" items={[{ label: 'Rename', onSelect: rename }, 'separator', { label: 'Delete', icon: 'delete', tone: 'danger', onSelect: remove }]})`:
  - An IconButton opening a `role="menu"` popover; `'separator'` draws a rule between groups, and `class` styles that button.
  - Opening focuses the first enabled entry; the arrows, Home and End move between enabled entries, an accent bar marking the one the keyboard is on, and Tab closes it.
  - An entry's `onSelect` runs once the menu has closed and focus is back on the trigger, so a dialog it opens takes focus from there.
- `IconPicker(search={findIcons} value={post.icon} name="icon" onChange={icon.set})`:
  - A search that rejects is logged and shown as `errorLabel` (`ui.iconPicker.errorLabel`), the last grid kept.
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

- `Combobox(label="Planet" options={planets} value={planet()} onChange={planet.set} name="planet" create)`: a text input with a listbox, filtered from the list as the visitor types.
  - `options` is a list of `{ value, label, disabled? }`, or a function handed `{ q }` once `minLength` (1) characters are typed, after a 200 ms pause, answering the options: an action, or an API call in a function. Only the latest answer lands; a failed call says `failureLabel`. `onChange(value, option)` runs on a pick, and with `''` when typing drops it.
  - `valueLabel` is the text of `value` for a remote list that has not returned it: the input shows it and no load is made on focus, and without it a remote `value` leaves the input empty (a fixed list shows the value). Inside a FormField the label's text alone names the input.
  - `create` offers the typed text as a last row (`createLabel(text)`) unless an option bears it; picking it hands the text as the value and to `onCreate(text)`.
  - `name` submits the value picked, else the text typed; a label typed whole counts as a pick, and the Enter adopting it does not submit the form. Without JavaScript it is a text field posting its text, a list offered as the browser's own suggestions. A form reset puts back the text and pick.
  - The combobox pattern: the input stays focused, ArrowDown and ArrowUp open and move through the rows (disabled ones skipped, wrapping), Alt+ArrowDown opens, Enter picks, Escape closes (an open list with no rows too) then clears; a status line reads the count, `loadingLabel`, `emptyLabel` and `failureLabel`. Parts: `list`, `option`, `status`.

### RadioGroup

- `RadioGroup(options={[{ value: 'free', label: 'Free', description: 'Up to 3 sites' }, { value: 'pro', label: 'Pro' }]} value="free" name="plan" label="Plan" onChange={plan.set})`: a labelled list of real radios, so the arrow keys move between options and the group posts as `name` without JavaScript. Options are `{ value, label, description?, disabled? }`, values strings or numbers; a `description` sits under its label and is read after it. `value` starts the pick (`null` for none), and a parent passing another follows it. `onChange` may return a promise, as Segmented's may: the group is busy until it settles and a refused change is put back. A form reset goes back to the start. Use Segmented for a compact toggle row.
- A field error comes from the FormField around it: `FormField(label="Plan" name="plan" group)` shows the message refused for `plan` and marks each radio invalid. Leave `label` out there if the legend names the group; pass `aria-label` or `aria-labelledby` if a screen reader should hear the group named.

### MarkdownEditor

- `MarkdownEditor(value={body()} onInput={body.set} onImage={upload} name="body")`: a markdown `textarea` that writes like an editor, in an island.
  - Ctrl or Cmd with B, I or K wraps the selection in bold, italics or a link; Enter continues a list, and Tab indents a list item, leaving Tab alone elsewhere and after Escape, so the keyboard can always leave the field; `keysHint` tells screen readers so, as the field's description. These go through the browser's own editing, so Ctrl+Z undoes them like typing.
  - A page pasted as HTML turns into markdown.
  - A toolbar over the field offers bold, italic, a heading, bulleted and numbered lists, a link and an image, each as the shortcuts do, undone with Ctrl+Z. `toolbar={false}` hides it and `toolbar={['bold', 'italic', 'link']}` keeps those, in that order; the names are `bold`, `italic`, `heading`, `bulletList`, `numberedList`, `link` and `image`. `image` opens the file picker when `onImage` is given, else writes `![](url)` with the url selected. The toolbar is one Tab stop, the arrows, Home and End moving between its buttons. Its buttons and icons load in a chunk of their own after the editor, so `toolbar={false}` with no `preview` ships neither.
  - `preview={markdown => renderOnServer(markdown)}` (a promise of HTML) adds a Preview button: the rendered text shows beside the field where the editor is wide and replaces it, with the formatting buttons, where it is narrow (under 36rem of its own width, so a side panel counts). It renders after a short pause in typing, the last answer winning, and says so in the pane if the call throws. The HTML is inserted as it comes, so give it your own renderer's output, such as `renderMarkdown(text)` from an API route, not user input; no parser ships with the editor. The pane's code loads the first time the preview is shown, and `previewClass="prose"` gives the HTML the classes your pages style rendered Markdown with. kayjs-cms wires it to the site's own Markdown pipeline.
  - `class` and the other attributes land on the `textarea`, which sits in a wrapper that holds the toolbar and the preview. Inside a FormField the field is named by the label's text alone, and Tab goes from the field to the toolbar, as one stop.
  - With `onImage(file)`, a pasted or dropped image is embedded behind an `![Uploading …]()` placeholder at once, swapped for `![](url)` once `onImage` resolves with its url, or removed, line break included, with `uploadFailure` toasted if it throws (or a refusal of the whole call such as a limit, as `attempt` does). Writing goes on meanwhile, and a finished upload never takes focus back; the field is `aria-busy` while one is under way.
  - It shows about 12 lines and grows with its text up to 70% of the screen, where the browser sizes a field by its content (Chromium); it can be resized by hand.
  - `onInput(value)` reports the text after every change, typed or applied. A parent passing other text replaces it; passing back what it was given leaves the caret alone.

## Reference

- FormField, SaveForm, ContactForm, FormDialog and Steps are in [Forms and Steps](forms-and-steps.md).
