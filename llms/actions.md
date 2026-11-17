# Actions

- [Actions](actions.md): declaring an action and posting a form to it.
- [Calling actions from islands](actions-from-islands.md): `pending()`, `track()`, optimistic changes and streaming answers.
- [Protecting actions](action-protection.md): cross-site posts, honeypot, minimum time and proof of work; [Rate limits](rate-limits.md) holds every rate limit.

## Common tasks

### Post a form to the server

An action is an Elysia schema and a handler a page's server fence exports, and `form(action={subscribe})` posts to it, with or without JavaScript:

```kay
--- server
import { s, action } from 'kay'

export const subscribe = action(
  { email: s.string({ min: 3, max: 200 }) },
  async ({ email }) => email.toLowerCase(),
)
---
form(action={subscribe})
  input(field="email" type="email")
  button Subscribe
```

### Show why a post was refused

An `error` line inside the form shows the message of the field, the schema's `error` option when set, and a bare `error` the form's own:

```kay
--- server
import { s, action } from 'kay'

export const rename = action(
  { name: s.string({ min: 1, max: 80, error: 'Write a name' }) },
  async ({ name }, ctx) => {
    if (name === 'admin')
      return ctx.deny(409, { message: 'That name is taken' })

    return name
  },
)
---
form(action={rename})
  error
  input(field="name")
  error name
  button Rename
```

A field's `error` is a text, or a function such as `error: () => t('names.required')` that kay calls in the request's locale, for the server's refusal and for the rules rendered into the page, so a visitor reads their language with or without JavaScript. A function that throws or returns no string leaves the field its default wording. A `query` or `defineEnv` schema field reads its `error` the same way.

### Show that a form is posting

A `pending` block inside the form shows only while that form posts, in a static page too:

```kay
form(action={subscribe})
  input(field="email")
  button Subscribe
  pending
    p Subscribing...
```

In a snippet or a child component, `error` and `pending` follow the form that renders it (the form around a snippet's declaration when there is one), so a field row holds its own. The values behind them, `add.form.error('title')` and, in an island, `add.pending()`, read from any expression.

### Show what a post returned

The handler's result comes back on the next render of the page, once, through `createToken.data()`:

```kay
--- server
import { s, action } from 'kay'

export const createToken = action({ label: s.string({ max: 80 }) }, async () => crypto.randomUUID())

const done = createToken.data()
---
if done
  p Your token: {done}
form(action={createToken})
  input(field="label")
  button Create
```

### Go to another page after a post

`ctx.redirect` sends the browser to a location instead of back to the page:

```kay
--- server
import { s, action } from 'kay'

export const create = action({ title: s.string({ max: 200 }) }, async ({ title }, ctx) => {
  const id = crypto.randomUUID()
  return ctx.redirect(`/posts/${id}`)
})
---
form(action={create})
  input(field="title")
  button Create
```

### Accept a file

`s.file()` in the schema, `input(type="file" name="avatar")` in the form, and the handler gets a `File`:

```kay
--- server
import { s, action } from 'kay'

export const upload = action(
  { avatar: s.file({ type: 'image/png' }) },
  async ({ avatar }) => avatar.size,
  { maxSize: '10mb' },
)
---
form(action={upload})
  input(type="file" name="avatar")
  error avatar
  button Upload
```

## Reference

### Declaring an action

A page's or a layout's server fence exports actions: an Elysia schema and a handler. Each one becomes `POST /_kay/action/<file>/<name>`, with its input validated.

```kay
--- server
import { s, action } from 'kay'
import { addTodo, listTodos } from '../data'

const newTodo = s.object({
  title: s.string({ min: 1, max: 200, error: 'Write a title' }),
})

export const add = action(newTodo, async ({ title }, ctx) => {
  if ((await listTodos()).some(todo => todo.title === title))
    return ctx.deny(409, { message: 'Already on the list', data: { listed: true } })

  return (await addTodo(title)).id
})

const todos = await listTodos()
---
ul
  for todo of todos
    li: a(href={`/todos/${todo.id}`}) {todo.title}
form(action={add})
  input(field="title" placeholder="New todo")
  error title
  if add.form.failed()?.data then data
    p.error {data.message}
  button Add
```

- `actions: { protect, maxSize, messages }` in `kay.config.ts` is the default of every action, `protect` key by key: an action's own `rateLimit` replaces the app's, and `protect: false` takes none of the app's checks (the app's `maxSize` and `messages` still apply). `actions: { beforeRun, onSuccess, onError }` hook every run, before the action's own hooks of the same name: [hooks](hooks.md#the-apps-own-hooks).
- An action with no input leaves the schema out: `action(async (ctx) => { ... }, protection?)`, validated as an empty object, its handler getting the context alone, called as `signOut()`, `signOut(undefined, { refresh: false })` or `site.call(signOut)`, and posted by `form(action={signOut})`.
- An action several pages and components share lives in an `_actions.kay` of a routes directory, a `--- server` fence alone, no closing `---` needed: it is served like a layout's actions, behind the guards of its directory and above, reading the params of every page below it, and `page = { guards: false }` opens it as a layout's.
- A page or a component imports it by its path, `import { removeTissue } from '../routes/admin/_actions.kay'`, in the server fence of a page or an island alike; no route file is imported, and `kay build`, `kay check` and `kay routes` see it as they see a layout's actions.
- `s.email()` accepts one plain address, the same check in the browser, on the server, in kayjs-auth and in kayjs-mail: letters and digits of any script, `+tag`, an internationalised domain; a local part up to 64 characters, labels up to 63, no quotes, comments, IP domain, name with angle brackets, list, line break or space around it, 254 characters at most, a host typed as is (no soft hyphen, zero-width space, fullwidth letter or ideographic full stop). Non-ASCII local parts and IDN domains pass for every app field; kayjs-auth alone also refuses a Latin, Cyrillic or Greek mix. `isEmail(value)` from `kay` is that check, `normalizeAddress(value)` from `kay/library` the form to store (trimmed, lower case, punycode domain).
- A string field with no `max` (`maxLength`) of its own is refused past 10,000 characters, with the error of a declared `maxLength`, and carries that bound to the form's `maxlength` and to the tool's schema; whatever builder wrote it, `t.Record` values, tuples and a string in an API route's `body` included. A field with an `enum`, a `const`, or a secret name such as `password` keeps none. Declare a tighter one for a name, an email or a title, which `kay check` warns of (`unbounded-string`), and a longer one for a field that takes more.
- `s` from `kay` builds the schema. A schema shared by API modules, server fences and islands, and the types an island reads off it, are in [Schemas](schemas.md).
- The handler's second argument is the request context every route shares (see routing, "The request context"), `request`, `url`, `locale`, `params`, `cookies`, `locals`, `headers`, `redirect`, `notFound` and `deny`, with `status(code)`.
- `ctx.redirect`, `ctx.notFound()` and `ctx.deny()` throw, as in a page, and a handler writes `return ctx.redirect(...)`, as a guard does; a call or a form post is answered with the redirect or a 404 as plain text, `redirect` with 303 unless given. `ctx.deny(status, { message, errors, data })` fails the post as in the next lines when it holds a `message`, `data` or `errors` (400 to 599), a `message` alone being the form's message (`add.form.error()`, an `ActionError`'s text); `deny(status)` with nothing, and `deny(status, 'text')` until 1.108, stop with plain text. A helper given the action's `ctx`, such as `limit.check(ctx)`, fails the form with its message and keeps the `Retry-After` it set; a stream that denies before its first value fails the call, and one denying after it ends the stream in an `ActionError`.
- Its `url` is the page's the post came from, as its guards read it, and its `locale` that page's, or the site's `lang` without `i18n`.
- A location outside ASCII, such as `/blog/日本語`, goes out percent-encoded, from pages and guards too.
- A location holding a control character, or a scheme other than `http:` and `https:`, such as `javascript:`, throws.

### Forms

- `form(action={add})` posts without JavaScript.
- Inside it, `input(field="title")`, on an `input`, `textarea` or `select`, renders `name="title"` plus the constraints the browser checks without JavaScript that the schema gives `title`: `required` where the server would refuse the field left blank (never for a boolean, so a checkbox stays optional, nor a list), `minlength`, `maxlength`, `pattern` (matched anywhere, as the schema matches it, and left out when the browser could not read it), `min`, `max` and `type="email"`, each unless the template writes it.
- `s.enum(values)` has no `default` unless the options give one: an optional enum field left out reads `undefined` and a required one is refused with a 422, where Elysia's own fills the first value in.
- `s.enum(TOPICS)` of a record is an enum of its keys, typed as their union with no cast, for a `select(field="topic")` whose options come from `Object.entries(TOPICS)`.
- `field` takes written text, never both `field` and `name`, and only inside such a form.
- `kay check` verifies every `field` and `name` against the schema.
- Once kay's script runs it sets `novalidate` on every form posting to an action and checks the form against the schema itself, so the schema's `error` messages show rather than the browser's, then the constraints the template wrote itself. `validate` (or `validate="blur"`) on the `form` shows them as text instead, in the `data-field="<name>"` elements outside islands (a FormField's); `blur` checks each field as it loses focus too.
- An island renders its fields without the constraints, kay's check covering them.
- `form(action={move.with({ id, to: 2 })})` posts those fields as hidden inputs would, with or without JavaScript, from a page or an island, with no input for them in the form: they travel in the form's action URL, `?kay_with=` holding them URL-encoded, and the server reads them as the form's own fields, coerced by the schema, standing over a posted field of the same name.
- `with` takes the schema's fields, text, numbers, booleans, dates or lists of them, `undefined` and `null` left out; a call from an island sends the fixed fields over its input. The browser can change them as it could hidden inputs, so a handler checks what an id names (ownership, permission) as for any posted field.
- `with` on a `with` adds to its fields; they are in the URL, so in logs and referrers: no secrets.
- An `_actions.kay` is served for the pages at or below its directory, so it sits at or above a page.
- A button alone is one such form: `form(action={move.with({ id, to: 2 })}) button(aria-label="Move up") ↑`.
- After the post the browser goes back to the page, or wherever the handler's `ctx.redirect` points.
- The page it goes back to is answered as a path (`/shop/cart?x=1`), never an absolute URL, so behind a proxy that ends TLS and reaches kay over http the browser stays on its own https origin and the page swap updates the page in place, with or without `proxy` or `X-Forwarded-Proto`.
- A visitor following a link to another page while the post is under way stays where it led, what the post answers dropped.
- A line break a form posts, CRLF per the standard, is read as `\n`, the one character the `textarea` the visitor typed in counts, so a `maxLength` matches what the browser let them write.

### Form values

- A plain form posts text, read against the schema before it validates.
- An `s.number()`, `s.int()` or `s.boolean()` field becomes one, a number only from decimal text such as `-1.5` or `2e3`, never `0x10`.
- A ticked checkbox posts `on`, read as `true`, and an unticked one nothing, read as `false` when the field is required.
- An `s.list()` field takes a single value or none as a list.
- The spaces around each text are dropped, so `minLength: 10` counts what was typed and ten spaces fill nothing.
- An optional field left blank counts as left out, `undefined` for `s.string({ optional: true })`.
- A field named like a password or a secret keeps its spaces, as does one whose schema says so, `s.string({ trim: false })` for a code block.
- A call from an island with its input, not a form's fields, reaches the schema as sent.
- An island holding a form may call the action with its fields instead, `await add(new FormData(form))`: the server reads them as it reads a plain form post, numbers, booleans and arrays coerced from their text, spaces around text dropped and a blank optional field left out, files and the honeypot included, and answers as a call, so the island shows the field errors of the `ActionError` and goes on once it resolves.
- To check a form in the browser with rules of its own, showing their messages as text rather than the browser's bubbles, an island holding the form gives it `onSubmit` and `novalidate`.
- The island's handler runs before kay's listener on the document, so `event.preventDefault()` keeps kay from posting, `novalidate` skips kay's own check against the schema, and once the fields pass the island posts them, `await add(new FormData(form), { refresh: false })`.
- The handler checks the same rules from a module both import, so the form holds without JavaScript too.
- See [Forms](site.md#forms) for the whole form.

### Fill a form from a record

- `form(action={save} values={todo})` starts every field the form names from the record's property of the same name, so an edit form writes each field once: a text or a number fills `input` and `textarea`, a `Date` fills `type="date"` as its local day (`2026-03-04`), `datetime-local` as its local minute (`2026-03-04T13:05`) and `time` as `13:05`, in the zone of whoever renders it (the server's, or the browser's in an island), `true` ticks a checkbox, a list ticks the checkboxes whose `value` it holds, a text or a number ticks the radio or picks the `option` it equals, and a `null`, a missing property or a function leaves the field as written. Any other truthy value, `'yes'` or `1`, ticks no checkbox.
- A refused post's values win over the record, so a visitor's edits and blanks survive the refusal; a refusal that read no field leaves the fields and boxes blank.
- Forms sharing one action, such as an edit form per row, each write a hidden `kay_form` field (kept for a post of the form that has `values`), and a refusal refills only the form that posted, `site.submit` naming it with `kay_form`; a post naming none refills them all.
- An `input` or checkbox that writes its own `value` or `checked` keeps it over the record; a `select` and a `textarea` take the record over their own `selected` option or text, on the server and in an island alike.
- In an island the record fills a field until the visitor edits it, so a record that changes later leaves what was typed: the field's default is what moves, and a form `reset` goes back to it.
- A hidden, password, file or disabled field, a `select multiple`, a field with a spread or a `bind:` on its value is left as written.
- Each field reads `values` on its own, so a call with arguments in it is a compile error (`form-misuse`): compute it once in the script and pass the name; a signal read, `todo()`, is fine, and any `(` followed by something else, a parenthesised group included, is refused. The key of a form is its place in the template and its count in the page, so a refusal finds it when the page renders the same forms again. A form an island builds in the browser writes no `kay_form` key, so a refused post re-shows its refusal and values in every such form.
- A `Form(action={save} values={todo})` component fills the fields written in its content on the server only.

### Name a field once

- A `FormField` (kayjs-ui's, or your own under that name) given `field="title"` inside a `form(action={save})` names the control written bare in its content: `FormField(label="Title" field="title")` around an `input` with no `name` or `field` gives the input `name="title"`, the schema's constraints and the `aria-*` of `input(field="title")`, the record's value and a refused post's. A control that writes its own `name` or `field`, any nested `form`, a component that is a form itself and one given a computed `field={...}` end it. It takes `field` or `name`, not both. Any other component keeps its `field` prop to itself.
- `label(field="name")` writes the label's `for` and the `id` of the one control of that field in the form, `<action>-<field>` (`save-name`), so `label(for="name")` and `input#name(field="name")` become two `field`. It is `form-misuse` when the form has no control of that field or several (a group of radios or boxes: write `for` and `id` yourself), when the label also writes `for`, or when the control writes its own `id`. Forms posting to one action, such as one per row, repeat the id: write `for` and `id` there.
- `button(action={move.with({ id })})` outside a form posts that action: kay wraps it in a `form(action={...})` that has no box of its own (`display: contents`, set by a hashed `style` rule in the head, so a strict CSP holds), so a static page posts and an island calls it, with the `.with()` arguments; the button is then the only child of its form for `:first-child` and `first:` styles. In a `p` it is `invalid-nesting`. Inside a form it is `form-misuse`: the form's own button posts the form.

### Refused posts

- `ctx.deny(status, { message, errors, data })` is the one refusal of a guard, a page, an action and an endpoint, `refuse(status, { ... })` throws it from anywhere; `return` it so `form.failed()` types `data`. `ctx.fail` is its old spelling until 1.108 (`unreturned-fail`).
- A post the schema refuses, or whose handler denies with `ctx.deny(status, { data })`, is answered with the page it came from, rendered with the failure's status, rather than with a redirect.
- There `add.form.failed()` returns `{ status, message, values, errors, data }`, typed from the action, or `undefined`.
- `values` is what the form posted (fields named like a password left out).
- `errors` is a message per refused field, the schema's `error` option when set.
- `data` is what `ctx.deny` received.
- `return ctx.deny(409, { errors: { email: 'Already taken' } })` puts a message on a field, typed from the schema's keys, with `''` for the form's own, so `error email`, `aria-invalid`, `add.form.error('email')`, the value re-fill and an island's `ActionError.errors` (and a kayjs-ui `FormField` named `email`) follow it with and without JavaScript.
- A rate limit's refusal sits under `errors['']`, read by `add.form.error()`, and a text `data` is that message: `return ctx.deny(502, { data: 'Not sent; try again later' })`.
- The page renders as a visit of it would, through the app's plugins and the page's guards, and nothing the visitor typed is lost however long it is.
- Reloading it posts again, as after any form a server answers in place.
- The page is the one the post was sent from, as `ctx.params` reads it below, the home page when it names none or another site.
- Without the page swap the browser shows the action's URL, so the page carries a `base` naming its own URL, and its relative links lead where they did.
- Each form on it posting to an action names that page in a `kay_back` query parameter, so a post refused again renders the same page, however many times in a row, and one that goes through goes back to it.
- A handler that throws, a mail server down say, is logged as any server error, `onError` included, and answered as a refusal with status 500.
- A plain form post then renders its page with the message under the form and what was typed kept, read by `add.form.error()`, and a call answers `{ ok: false }` with it in `errors['']`.
- The message is `Something went wrong on our side; try again later` unless the site words it as `kay.action.serverError` ([Locales](locales-texts.md)) or the action words its own, `action(schema, handler, { messages: { serverError: 'Not sent; write to hello@example.com instead' } })`, so a handler needs no `try`/`catch` of its own to tell the visitor.
- `serverError` may be a function given the error and `ctx`, sync or async, to word it from what is loaded per request or the page's `ctx.locale`: `serverError: async () => 'Write to ' + (await settings.one()).email`. Its text is answered with the same status 500; one that throws, or answers a blank text, leaves kay's message (a throw logged beside the handler's error), and a redirect or denial thrown from it is no answer either.
- An action past its `timeout` (`serve.timeout` or the action's own) answers 504 the same way, worded `kay.action.timeout` (`This took too long; try again later`) and reported as a server error.
- A redirect or a guard's denial thrown is no error.

### Params of the posting page

- `ctx.params` holds the params of the page the action was posted from, matched against the route of the page exporting it, as its guards read them. In an action declared in a page, `kay check` types it from that page's route, a matcher's value as it gives it and an optional param `| undefined`, so `ctx.params.id` is a `number` under `[id=integer]` and a misspelled one is an error; a layout's or an `_actions.kay` action, and a guard, cover several routes and read `unknown`.
- A layout's action gets the ones every page it wraps names.
- The page is the one a refused post's form names in `kay_back`, else the one kay's script names in an `x-kay-page` header on a call or a form the page swap posts, else the post's `Referer`.
- An action whose route has params, posted from no page of that route, is refused with 400: before any guard or the handler runs when guards cover its file, so a guard reading them is never skipped, else once the handler first reads `ctx.params`, so an action reading none, such as a save a page of another route calls, runs from any page.
- A `referrer-policy` hiding the path from the site itself (`no-referrer`, `origin`, `strict-origin`) leaves a form posted without JavaScript in that case.
- The guards checked the visitor against those params, not against the input, which the visitor chooses, so the handler scopes what it touches by them: `projects.remove({ org: ctx.params.org, id })`.

### Reading the outcome

- `add.form.failed()`, `add.data()`, `add.status()` and `add.form.error('title')` read how a post or the last call went from any template, component, island or server fence: [Refused fields](actions-refused-fields.md#reading-the-outcome).

### Files

- What an action takes of a file, `s.file()`, `s.files()`, the form encoding and the body limit, is in [Stored files](files.md#files-posted-to-an-action).
