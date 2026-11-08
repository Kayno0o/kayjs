# Refused fields and their messages

## Common tasks

- Show why a post was refused: the tasks of [Actions](actions.md#common-tasks).

## Reference

### Refused fields and their messages

- A form posting to an action shows a refused post again by itself: each `input`, `textarea` and `select` in it whose `name`, and `type` if any, are written out takes the value the post sent in place of the one the template gives, a checkbox or radio button whether it was ticked, a field named like a secret (a password), a file, the honeypot and the form's own callback fields excepted. Forms posting to one action share one refused post. A component inside the form reads the same post with `postedValue(name, fallback?)`, `postedChecked(name, value?, fallback?)` and `postedValues(name, fallback?)` from `kay` (undefined outside a refused post and for a secret; in the browser they read what the server rendered, answering only a value that differs from `fallback`), which is how the kayjs-ui controls refill; a list field posts back as `name[]`, and a literal field named `foo[]` is not a list. The same components read the form's messages with `formErrors()` from `kay`, called in the script and answering `(field) => action.error(field)` of the form being rendered (nothing outside one), which is how a FormField shows `add.error('title')` with no `issue` prop; a component given an `action` (kayjs-ui's `Form`) is that form for its content: the kayjs-ui controls and the page's own `input`s in it refill and take `aria-invalid` on the server as in a `form(action)` (in the browser a component's `input` is its own). An island's own template does not know a `form(action)` of the page around it: its FormField shows nothing by name, so give the island the action (`Form(action={add})` inside it) or an `issue` prop.
- Each field the post was refused for gets `aria-invalid="true"`, and `aria-describedby` naming the element showing its message, so a screen reader reads the message with the field. In an island the mark goes once the field is no longer refused, unless a component still marks it through `markInvalid` (see [Islands](navigation.md#forms-posting-in-place)), such as a kayjs-ui `FormField` showing a message of its own.
- An `error title` line inside the form shows that message: `p.error`, with the id `add-title-error`, while the post is refused for `title`, nothing otherwise.
- `error.text-sm title` adds classes.
- A quoted name such as `error "first-name"` takes any field, and the name is typed from the schema.
- A bare `error` shows the form's own message, `add.error()`, its `form` described by it.
- One inside a `for` renders without an id and describes nothing.
- A `pending` block inside the form shows its lines only while that form posts, with no JavaScript of your own and none added to the page: the runtime that posts the form in place unhides it, and hides it again once the page the answer leads to (a redirect's included) is in; when the answer ends in a document that replaces the page (a redirect to another origin, a reload), it stays shown while that loads (ten seconds at most), and a page restored from the cache hides it. It is hidden in the render, after the answer or a refused post, and without JavaScript.
- In an island the block shows as well while a call of the form's action is in flight, from `onSubmit`, an `onClick` or anywhere else (`add.pending()`, so every call of the action, `add.with(...)` included: the forms of a list sharing one action all show their block; a `track()` handle is no action a form can post to), and while an `onSubmit` returns a promise.
- The block is a `slot` laid out as its contents, so it takes no place of its own in a flex or grid form and needs no class. No style rule is involved, so a strict `style-src` leaves it working.
- Its text is announced through a live region the runtime writes outside the form, as the form's `aria-busy` may hold back a region inside it.
- Without an `error` line, the field is described by the element an `if add.error('title')` block shows first, or one holding `{add.error('title')}`, written outside a `for` in the file holding a form that posts to `add`, which keeps its own `id` or gets one such as `add-title-error`.
- The form likewise is described by the element showing `add.error()`.
- A static `aria-describedby` the template writes, such as a hint, is kept and the error's id added after it; a bound one is left as it is.
- A message rendered any other way, through a component, a `for` over `errors` or another file, describes nothing, and the field is then announced as invalid without it.
- A field with a `bind:`, a spread, `disabled` or `multiple` keeps what the template gives, and one the page renders through another component is not the form's own.
- On a page posting no refused form, every field renders as written.
