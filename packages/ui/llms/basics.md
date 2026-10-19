# kayjs-ui: Icons, buttons, toasts, dialogs, cards, popovers and stats

## Components

Each component spreads the other attributes it is given onto its root element, `id`, `aria-*` and `data-*` included. The exceptions: Toggle and Checkbox spread them on their checkbox, Popover on its panel, and CommandPalette, ConfirmDelete, FormField, FormDialog, SaveForm, Menu, Toaster, TooltipHost, LoadMore and WhenVisible take none.

### Icon, Button, IconButton

- `Icon(icon="close")`: an `svg.kui-icon`. It is decorative unless `label` names it for screen readers. `icon` is a slot or an imported `~icons` icon.
- `Button(label="Save" tone="accent" icon="plus")`:
  - `variant` names the form: `solid` (the default, framed), `ghost` (no frame until hovered) or `inline` (reads as a link). `tone` names the meaning: `neutral` (the default), `accent` for the main action or `danger` for a destructive one. `size` is `xs`, `sm`, `md` or `lg`.
  - Its label stays on one line; a row of buttons wraps whole buttons, as the dialog and panel footers do.
  - A promise returned by `onClick` holds that button alone busy (spinner in place of the icon, `aria-busy`) and disabled until it settles; a rejection is logged. A `type="submit"` button is busy (spinner, `aria-busy`, clicks ignored) the same way, but not disabled, while its `onClick` or its form's `onSubmit` returns a promise.
  - An explicit `busy` shows a spinner and sets `aria-busy` and has the last word; it does not disable the button.
  - `expanded` sets `aria-expanded`, for a button that opens a panel.
  - `type` defaults to `button`, so a button inside a form never submits it by accident: pass `type="submit"` to submit. Children render after `label`.
  - `href` makes it a link looking like a button, `a.kui-btn`, taking a link's attributes such as `target` in place of `type`, `expanded` and `disabled`. A site path in `href` is not checked against the pages the way a literal `a(href)` is.
- `IconButton(icon="delete" label="Delete")`: an icon alone. `label` names it for screen readers and shows as its tooltip through TooltipHost. `size` is `xs`, `sm`, `md` or `lg`; `variant` is `solid`, `ghost` or `inline` and `tone` `neutral`, `accent` or `danger`.

### toast and Toaster

```ts
import { attempt, toast } from '@kaynooo/kayjs-ui'

toast.success('Saved')
toast.error('Could not save')
toast.info('Copied')

// `duration` is in milliseconds (6000, an error 10000 by default); `Infinity` keeps the toast until the reader dismisses it, or `dismissToast(id)` does, each call answering its id. Its `tone` is `danger`, `success` or `info`; `type`, `error` for `danger`, is its deprecated name.
const sticky = toast.error('Offline', { duration: Infinity })

// Resolves to what the call returned (`true` for a call returning nothing), or to undefined once it threw and `failure` was toasted, or a refusal of the whole call such as a limit.
const post = await attempt(() => publish({ id }), 'Could not publish')

// `success` is toasted once the call goes through.
if (await attempt(() => archive({ id }), { failure: 'Could not archive', success: 'Archived' }))
  selected.set([])

// A refusal of the action's handler, `ctx.fail(409, { error: 'Already published' })`, toasted as it says.
await attempt(() => publish({ id }), 'Could not publish', (data: { error: string }) => data.error)
```

`attempt(run, failure, refused?)`, or `attempt(run, { failure, success?, refused? })`, toasts, for a call that throws, the message `refused` reads from the data the action's handler passed to `ctx.fail`; else a refusal of the whole call, such as a limit; else `failure`. An empty or undefined answer from `refused` falls through to the next. Type `refused`'s parameter as the handler's data: `(data: { error: string }) => data.error`.

A call to an API route made with `call()` throws `ApiError`, which `attempt` reads too: `refused` gets its `answer`, else the words the route gave (the text it answered or the `message` of its JSON) are toasted for a 4xx when they read as a message (one line of at most 200 characters, not markup nor an all-caps code), `refused` is called only for a JSON object answer and one that throws counts as saying nothing, and `failure` stands for status 0 (no answer came), a 5xx or an answer with no words: `await attempt(() => call(notes, '/:id', { method: 'delete', params: { id } }), 'Could not delete')`.

A toast stays for six seconds, an error for ten, or until its close button is pressed, named by `dismissLabel` on Toaster. Screen readers hear each one from a status region kept in the page, an error from an alert region. Its clock stops while the pointer rests on the toasts or focus is inside them, and goes on with the time it had left once both are gone. Alt and `t` (`hotkey` on Toaster, `null` for none) moves focus to the toasts on screen, where Escape dismisses the focused one. Toaster is a manual popover in the top layer, so toasts show above an open dialog.

### Dialog, ConfirmDelete

```kay
Dialog(open={editing()} title="Rename" onOpenChange={() => editing.set(false)})
  @footer
    Button(label="Cancel" onClick={() => editing.set(false)})
    Button(label="Rename" tone="accent" onClick={rename})
  input.kui-field-input(name="name")
```

- Dialog is a modal `dialog`. It closes when its parent sets `open` to false, on Escape, or on a click outside. `onOpenChange(false)` runs however it closed. Closed by Escape or a click outside, its content is still there to read; closed by the parent, it is already gone. Its title names it for screen readers, an `h2` unless `level` says otherwise.
- Once something has been typed inside, or while `dirty` is set (for example while a request is in flight), Escape and a click outside leave it open: only its own buttons close it. A Dialog with no footer still closes on Escape after typing, as it has no button to close it.
- `ConfirmDelete(message="Delete this post?" failure="Could not delete" onConfirm={remove})` renders a trigger that opens a dialog asking before deleting:
  - While the promise `onConfirm` returns is pending, the dialog's buttons are disabled.
  - Once it resolves, the dialog closes. If it throws, the dialog stays open and `failure` is toasted, or a refusal of the whole call such as a limit, as `attempt` does; an `onConfirm` made with `call()` is read the same way, its `ApiError` toasting the route's own words.
  - `refused` reads a refusal of the action's handler, or the `answer` of an `ApiError`, as `attempt` does, and its message is toasted in place of `failure`: `ConfirmDelete(... failure="Could not delete" refused={(data: { error: string }) => data.error})`.
  - `trigger="button"` makes the trigger a labelled danger button rather than an icon, and `trigger="link"` a plain underlined text button, for a confirm inside running text. `label` renames the trigger, for "Revoke link" or "Empty trash", and `class` goes on it. `size` and `variant` style the icon trigger only, a `variant` giving it the `tone` too (danger-coloured by default, neutral for `tone="neutral"`; the icon is neutral without one), `size` also sizing the cancel button when asking inline.
  - `success` is toasted once `onConfirm` went through, as `attempt`'s is.
  - `title` (`Confirm Deletion`), `confirmLabel` (`Delete`) and `pendingLabel` (`Deleting…`) replace the dialog's words: `ConfirmDelete(message="Rotating breaks every link already shared." failure="Could not rotate" onConfirm={rotate} trigger="link" label="Rotate link" title="Rotate link" confirmLabel="Rotate" pendingLabel="Rotating…")`.
  - `tone="neutral"` is for a confirm that is not a deletion, such as a save with a consequence: accent buttons, a check icon, and the title and confirm button worded by `label` (`Confirm`) unless given: `ConfirmDelete(tone="neutral" trigger="button" label="Save" message="Save without your own IP?" failure="Could not save" success="Saved" onConfirm={save})`.
  - `ask="inline"` asks in place instead of in a dialog, for a row of a list: a click hides the trigger and shows a danger button saying `confirmLabel` and a cancel button, the focus on the first. `message` names the pair for screen readers and is the danger button's tooltip. Escape or cancel brings the trigger back, focused; a failed delete toasts and stays armed, the focus back on the danger button.

### Card, Badge, EmptyState, Notice, Avatar

- `Card(title="Traffic")`: a `section.kui-card` that frames its children in `.kui-card-body`. `head` sits at the far end of the title's line, for a count or a link. `bare` drops the body's inset, for content that runs to the edge, such as a table. The title is an `h3`, or the heading `level` given, from 2 to 6.
- `Badge(label="Draft" tone="warning" icon="info")`: `tone` is `neutral`, `accent`, `success`, `warning`, `danger` or `info`. Children render after `label`. `stamp` draws it as a rubber stamp: a hairline in its ink, small spaced mono capitals, its ground turning `stamp-fill-hover` while a `.group` holding it, such as a card link, is hovered. A tone colours a stamp as it does a badge.
- `EmptyState(title="No posts yet" description="Write the first one.")`: what a list shows when it holds nothing. `level` (1 to 6) makes the title a heading, `level={1}` for one standing for the whole page, such as a 404, which then needs no hidden `h1`; without it, the title is a paragraph. An `@actions` block sits below the description, for the button that adds the first item: `EmptyState(title="No posts yet")` then `@actions` holding `Button(href="/new" label="New post")`.
- `Notice(tone="danger" label={failure})`: a form's outcome or a refusal, in place. `tone` is `info`, `success`, `warning` or `danger`; a danger is `role="alert"`, read out at once, the others `role="status"`. Children render after `label`, for a link to follow up. It is a bordered box, for a page section; `compact` drops the box, for a line under a form.
- `Avatar(src={user.avatar} name={user.name} size="sm")`: the picture, or the name's first letter on a colour seeded by the name when `src` is empty or fails to load; a new `src` is tried again. `size` is `xs`, `sm`, `md` (the default) or `lg`. It is decorative, the name being written beside it, unless `label` names it for screen readers.

### Popover, TooltipHost

```kay
Popover(placement="bottom-end")
  @trigger(attributes)
    IconButton({...attributes} icon="chevron" label="More")
  Button(label="Duplicate" onClick={duplicate})
```

- Popover is the browser's popover, which needs Chrome and Edge 114, Firefox 125 or Safari 17, and it sits beside its trigger through CSS anchor positioning, Chrome and Edge 129, Firefox 147 or Safari 26, so an older browser opens it away from the trigger. A click on the trigger toggles it, and a click outside or Escape closes it. The panel draws an id unique on the page, pairing it with its trigger; an `id` given instead must be unique too, and made of letters, digits, `-` and `_`, since it also names the CSS anchor.
- `@trigger(attributes)` renders the trigger, which spreads `attributes`: `popovertarget`, `aria-expanded` and its anchor.
- `placement` is `bottom-start`, `bottom-end`, `top-start` or `top-end`, and the browser flips it when there is no room.
- `open` opens or closes it from the page, and `onOpenChange(open)` runs however it changed: a page driving `open` sets its own value back there, or it could not open the panel again after a click outside closed it.
- TooltipHost shows the `data-tooltip` of whichever element the pointer or a tab lands on. `data-tooltip-placement`, a CSS `position-area`, says where it sits, `top` by default: `button(data-tooltip="Copy link" data-tooltip-placement="bottom")`. IconButton sets `data-tooltip` to its label. While a tooltip shows, its element gets `aria-describedby` pointing at the tooltip, so a screen reader focusing it hears the text too. `TooltipHost(showDelay="200ms" hideDelay="300ms")` sets how long a tooltip waits to show (`80ms`) and to hide (`150ms`), a duration with its unit, as `"200ms"` or `"1s"`; a bare number is a type error. The pointer can cross onto the tooltip without it closing, and Escape closes it until the pointer or the focus moves to another element.

### Stat, Meter, BarList, SiteFavicon, CopyButton, Rating

- `Stat(value={12} label="moons" icon="info")`: a figure read with what it counts.
- `Meter(value={usage} label="Disk" fillClass="bg-kui-warning")`: a `role="meter"` bar named by the required `label`, holding `value` between 0 and 100. `fillClass` styles the fill alone, such as a colour picked by threshold.
- `BarList(rows={[{ key: 'fr', label: 'France', value: 120, display: '120 visits' }]})`: a bar per row, each measured against the largest value, reading `display` or else the value. `onSelect(row)` makes each row a button, from an island; `emptyLabel` is what it reads with no rows. Its rows are typed `BarListRow`, or any type extending it.
- `SiteFavicon(src={site.favicon} name={site.name})`: a site's icon, or the `globe` slot in a colour drawn from `name` when `src` is missing or fails to load.
- `CopyButton(text={url} label="Copy link")`: copies `text`, with `html` alongside for apps that paste rich text, and reads `copiedLabel` for `copiedFor` (a duration with its unit, `2s` by default). It takes Button's `variant`, `tone` and `size`. A copy the browser refuses toasts `failure`.
- `Rating(value={4.6} max={5} label="Rated 4.6 out of 5")`: stars filled to `value`'s share of `max`, part of a star included, kept between none and all. Screen readers read `label`, `4.6 out of 5` by default.
- BarList, SiteFavicon and CopyButton are islands taking data alone, so a static page passes them their props as it would to any element.
