# Actions

- [Actions](actions.md): declaring an action and posting a form to it.
- [Calling actions from islands](actions-from-islands.md): `pending()`, `track()`, optimistic changes and streaming answers.
- [Protecting actions](action-protection.md): cross-site posts, honeypot, minimum time and proof of work; [Rate limits](rate-limits.md) holds every rate limit.

## Common tasks

### Post a form to the server

An action is an Elysia schema and a handler a page's server fence exports, and `form(action={subscribe})` posts to it, with or without JavaScript:

```kay
--- server
import { s } from 'kay'

export const subscribe = action(
  s.Object({ email: s.String({ minLength: 3, maxLength: 200 }) }),
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
import { s } from 'kay'

export const rename = action(
  s.Object({ name: s.String({ minLength: 1, maxLength: 80, error: 'Write a name' }) }),
  async ({ name }, ctx) => {
    if (name === 'admin')
      return ctx.fail(409, 'That name is taken')

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

### Show what a post returned

The handler's result comes back on the next render of the page, once, through `ctx.succeeded`:

```kay
--- server
import { s } from 'kay'

export const createToken = action(s.Object({ label: s.String({ maxLength: 80 }) }), async () => crypto.randomUUID())

const done = ctx.succeeded(createToken)
---
if done
  p Your token: {done.data}
form(action={createToken})
  input(field="label")
  button Create
```

### Go to another page after a post

`ctx.redirect` sends the browser to a location instead of back to the page:

```kay
--- server
import { s } from 'kay'

export const create = action(s.Object({ title: s.String({ maxLength: 200 }) }), async ({ title }, ctx) => {
  const id = crypto.randomUUID()
  return ctx.redirect(`/posts/${id}`)
})
---
form(action={create})
  input(field="title")
  button Create
```

### Accept a file

`s.File()` in the schema, `input(type="file" name="avatar")` in the form, and the handler gets a `File`:

```kay
--- server
import { s } from 'kay'

export const upload = action(
  s.Object({ avatar: s.File({ type: 'image/png' }) }),
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
import { s } from 'kay'
import { addTodo, listTodos } from '../data'

const newTodo = s.Object({
  title: s.String({ minLength: 1, maxLength: 200, error: 'Write a title' }),
})

export const add = action(newTodo, async ({ title }, ctx) => {
  if ((await listTodos()).some(todo => todo.title === title))
    return ctx.fail(409, { message: 'Already on the list' })

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
  if add.failed()?.data as data
    p.error {data.message}
  button Add
```

- An action with no input leaves the schema out: `action(async (ctx) => { ... }, protection?)`, validated as an empty object, its handler getting the context alone, called as `signOut()`, `signOut(undefined, { refresh: false })` or `site.call(signOut)`, and posted by `form(action={signOut})`.
- An action several pages and components share lives in an `_actions.kay` of a routes directory, a `--- server` fence alone, no closing `---` needed: it is served like a layout's actions, behind the guards of its directory and above, reading the params of every page below it, and `page = { guards: false }` opens it as a layout's.
- A page or a component imports it by its path, `import { removeTissue } from '../routes/admin/_actions.kay'`, in the server fence of a page or an island alike; no route file is imported, and `kay build`, `kay check` and `kay routes` see it as they see a layout's actions.
- `s` from `kay` builds the schema. A schema shared by API modules, server fences and islands, and the types an island reads off it, are in [Schemas](schemas.md).
- The handler's second argument is the request context every route shares (see routing, "The request context"), `request`, `url`, `locale`, `params`, `cookies`, `locals`, `headers`, `redirect`, `notFound` and `deny`, with `status(code)` and `fail(status, data)`, whose status is an error status, 400 to 599.
- `ctx.redirect`, `ctx.notFound()` and `ctx.deny()` throw, as in a page, and a handler writes `return ctx.redirect(...)`, as a guard does; a call or a form post is answered with the redirect, a 404 or the denial as plain text, `redirect` with 303 unless given.
- Its `url` is the page's the post came from, as its guards read it, and its `locale` that page's, or the site's `lang` without `i18n`.
- A location outside ASCII, such as `/blog/日本語`, goes out percent-encoded, from pages and guards too.
- A location holding a control character, or a scheme other than `http:` and `https:`, such as `javascript:`, throws.

### Forms

- `form(action={add})` posts without JavaScript.
- Inside it, `input(field="title")`, on an `input`, `textarea` or `select`, renders `name="title"` plus the constraints the browser checks without JavaScript that the schema gives `title`: `required` where the server would refuse the field left blank (never for a boolean, so a checkbox stays optional, nor a list), `minlength`, `maxlength`, `pattern` (matched anywhere, as the schema matches it, and left out when the browser could not read it), `min`, `max` and `type="email"`, each unless the template writes it.
- `s.UnionKeys(TOPICS)` is a `UnionEnum` of a record's keys, typed as their union with no cast, for a `select(field="topic")` whose options come from `Object.entries(TOPICS)`.
- `field` takes written text, never both `field` and `name`, and only inside such a form.
- `kay check` verifies every `field` and `name` against the schema.
- Once kay's script runs it sets `novalidate` on every form posting to an action and checks the form against the schema itself, so the schema's `error` messages show rather than the browser's, then the constraints the template wrote itself.
- An island renders its fields without the constraints, kay's check covering them.
- `form(action={move.with({ id, to: 2 })})` posts those fields as hidden inputs would, with or without JavaScript, from a page or an island, with no input for them in the form: they travel in the form's action URL, `?kay_with=` holding them URL-encoded, and the server reads them as the form's own fields, coerced by the schema, standing over a posted field of the same name.
- `with` takes the schema's fields, text, numbers, booleans, dates or lists of them, `undefined` and `null` left out; a call from an island sends its input as it is and reads none of it.
- `with` on a `with` adds to its fields; they are in the URL, so in logs and referrers: no secrets.
- An `_actions.kay` is served for the pages at or below its directory, so it sits at or above a page.
- A button alone is one such form: `form(action={move.with({ id, to: 2 })}) button(aria-label="Move up") ↑`.
- After the post the browser goes back to the page, or wherever the handler's `ctx.redirect` points.
- The page it goes back to is answered as a path (`/shop/cart?x=1`), never an absolute URL, so behind a proxy that ends TLS and reaches kay over http the browser stays on its own https origin and the page swap updates the page in place, with or without `proxy` or `X-Forwarded-Proto`.
- A visitor following a link to another page while the post is under way stays where it led, what the post answers dropped.
- A line break a form posts, CRLF per the standard, is read as `\n`, the one character the `textarea` the visitor typed in counts, so a `maxLength` matches what the browser let them write.

### Form values

- A plain form posts text, read against the schema before it validates.
- An `s.Number()`, `s.Integer()` or `s.Boolean()` field becomes one, a number only from decimal text such as `-1.5` or `2e3`, never `0x10`.
- A ticked checkbox posts `on`, read as `true`, and an unticked one nothing, read as `false` when the field is required.
- An `s.Array()` field takes a single value or none as a list.
- The spaces around each text are dropped, so `minLength: 10` counts what was typed and ten spaces fill nothing.
- An optional field left blank counts as left out, `undefined` for `s.Optional(s.String())`.
- A field named like a password or a secret keeps its spaces, as does one whose schema says so, `s.String({ trim: false })` for a code block.
- A call from an island with its input, not a form's fields, reaches the schema as sent.
- An island holding a form may call the action with its fields instead, `await add(new FormData(form))`: the server reads them as it reads a plain form post, numbers, booleans and arrays coerced from their text, spaces around text dropped and a blank optional field left out, files and the honeypot included, and answers as a call, so the island shows the field errors of the `ActionError` and goes on once it resolves.
- To check a form in the browser with rules of its own, showing their messages as text rather than the browser's bubbles, an island holding the form gives it `onSubmit` and `novalidate`.
- The island's handler runs before kay's listener on the document, so `event.preventDefault()` keeps kay from posting, `novalidate` skips kay's own check against the schema, and once the fields pass the island posts them, `await add(new FormData(form), { refresh: false })`.
- The handler checks the same rules from a module both import, so the form holds without JavaScript too.
- See [Forms](site.md#forms) for the whole form.

### Refused posts

- A post the schema refuses, or whose handler returns `ctx.fail(status, data)`, is answered with the page it came from, rendered with the failure's status, rather than with a redirect.
- There `ctx.failed(add)` returns `{ status, values, errors, data }`, typed from the action, or `undefined`.
- `values` is what the form posted (fields named like a password left out).
- `errors` is a message per refused field, the schema's `error` option when set.
- `data` is what `ctx.fail` received.
- A string passed to `ctx.fail` is the form's message too, under `errors['']` where a rate limit's refusal sits: `return ctx.fail(502, 'Not sent; try again later')`, read by `add.error()`.
- The page renders as a visit of it would, through the app's plugins and the page's guards, and nothing the visitor typed is lost however long it is.
- Reloading it posts again, as after any form a server answers in place.
- The page is the one the post was sent from, as `ctx.params` reads it below, the home page when it names none or another site.
- Without the page swap the browser shows the action's URL, so the page carries a `base` naming its own URL, and its relative links lead where they did.
- Each form on it posting to an action names that page in a `kay_back` query parameter, so a post refused again renders the same page, however many times in a row, and one that goes through goes back to it.
- A handler that throws, a mail server down say, is logged as any server error, `onError` included, and answered as a refusal with status 500.
- A plain form post then renders its page with the message under the form and what was typed kept, read by `add.error()`, and a call throws `ActionError` with it in `errors['']`.
- The message is `Something went wrong on our side; try again later` unless the site words it as `kay.action.serverError` ([Locales](locales.md#texts-from-kay-and-its-libraries)) or the action words its own, `action(schema, handler, { messages: { serverError: 'Not sent; write to hello@example.com instead' } })`, so a handler needs no `try`/`catch` of its own to tell the visitor.
- `serverError` may be a function given the error and `ctx`, sync or async, to word it from what is loaded per request or the page's `ctx.locale`: `serverError: async () => 'Write to ' + (await settings.one()).email`. Its text is answered with the same status 500; one that throws, or answers a blank text, leaves kay's message (a throw logged beside the handler's error), and a redirect or denial thrown from it is no answer either.
- A redirect or a guard's denial thrown is no error.

### Refused fields and their messages

- A form posting to an action shows a refused post again by itself: each `input`, `textarea` and `select` in it whose `name`, and `type` if any, are written out takes the value the post sent in place of the one the template gives, a checkbox or radio button whether it was ticked, a password, a file and the honeypot excepted.
- Each field the post was refused for gets `aria-invalid="true"`, and `aria-describedby` naming the element showing its message, so a screen reader reads the message with the field. In an island the mark goes once the field is no longer refused, unless a component still marks it through `markInvalid` (see [Islands](navigation.md#forms-posting-in-place)), such as a kayjs-ui `FormField` showing a message of its own.
- An `error title` line inside the form shows that message: `p.error`, with the id `add-title-error`, while the post is refused for `title`, nothing otherwise.
- `error.text-sm title` adds classes.
- A quoted name such as `error "first-name"` takes any field, and the name is typed from the schema.
- A bare `error` shows the form's own message, `add.error()`, its `form` described by it.
- One inside a `for` renders without an id and describes nothing.
- A `pending` block inside the form shows its lines only while that form posts, with no JavaScript of your own and none added to the page: the runtime that posts the form in place unhides it, and hides it again once the page the answer leads to (a redirect's included) is in; when the answer ends in a document that replaces the page (a redirect to another origin, a reload), it stays shown while that loads (ten seconds at most, for a download), and a page restored from the cache hides it. It is hidden in the render, after the answer, after a refused post and with JavaScript off.
- In an island the block shows as well while a call of the form's action is in flight, from `onSubmit`, an `onClick` or anywhere else (`add.pending()`, so every call of the action, `add.with(...)` included: the forms of a list sharing one action all show their block; a `track()` handle is no action a form can post to), and while an `onSubmit` returns a promise.
- The block is a `slot` laid out as its contents, so it takes no place of its own in a flex or grid form and needs no class. No style rule is involved, so a strict `style-src` leaves it working.
- Its text is announced through a live region the runtime writes outside the form, as the form's `aria-busy` may hold back a region inside it.
- Without an `error` line, the field is described by the element an `if add.error('title')` block shows first, or one holding `{add.error('title')}`, written outside a `for` in the file holding a form that posts to `add`, which keeps its own `id` or gets one such as `add-title-error`.
- The form likewise is described by the element showing `add.error()`.
- A static `aria-describedby` the template writes, such as a hint, is kept and the error's id added after it; a bound one is left as it is.
- A message rendered any other way, through a component, a `for` over `errors` or another file, describes nothing, and the field is then announced as invalid without it.
- A field with a `bind:`, a spread, `disabled` or `multiple` keeps what the template gives, and one the page renders through another component is not the form's own.
- On a page posting no refused form, every field renders as written.

### Params of the posting page

- `ctx.params` holds the params of the page the action was posted from, matched against the route of the page exporting it, as its guards read them.
- A layout's action gets the ones every page it wraps names.
- The page is the one a refused post's form names in `kay_back`, else the one kay's script names in an `x-kay-page` header on a call or a form the page swap posts, else the post's `Referer`.
- An action whose route has params, posted from no page of that route, is refused with 400: before any guard or the handler runs when guards cover its file, so a guard reading them is never skipped, else once the handler first reads `ctx.params`, so an action reading none, such as a save a page of another route calls, runs from any page.
- A `referrer-policy` hiding the path from the site itself (`no-referrer`, `origin`, `strict-origin`) leaves a form posted without JavaScript in that case.
- The guards checked the visitor against those params, not against the input, which the visitor chooses, so the handler scopes what it touches by them: `projects.remove({ org: ctx.params.org, id })`.

### Reading the outcome

- `add.failed()`, `add.succeeded()` and `add.error('title')` read the same as `ctx.failed(add)` and `ctx.succeeded(add)`, from any template, layout, component or island, and from the server fence.
- `error()` without a field is the form-wide message, `errors['']`.
- The field name is typed from the schema.
- An island reads them in the browser too, as its server render did, but for `values`, which stay on the server, so no field the server cannot tell is a secret reaches the page's source: the fields hold what was sent.
- Once the page shown called the action, they read how its last call went instead, reactively, a call clearing them as it starts: an island calling `add({ title })` catches the `ActionError` and `add.error('title')` shows the message, the field marked invalid.
- A post that succeeds goes back to the page with what the handler returned: `ctx.succeeded(add)` returns `{ data }`, typed from the action, or `undefined`, on that one render only.
- `data` travels in a cookie, sealed (AES-GCM under a key derived from [the app secret](environment.md#the-app-secret), else a key of the process, which a restart changes), so a secret shown once, such as a new API token, can be neither read nor altered in it.
- Data too big for it, over about 3.5 KB sealed, is left out with a warning, and `ctx.succeeded` returns `undefined`, as it does for a cookie that does not open, forged or sealed before a restart.
- A prerendered page reads both too: the request carrying that cookie renders it afresh, see [Prerendering](prerendering.md#prerendering).
- The cookie carrying `ctx.succeeded` back is `HttpOnly`, `SameSite=Lax`, and `Secure` when the request came over https, `X-Forwarded-Proto` included, as is every request in production when `site` is https.

### Files

- What an action takes of a file, `s.File()`, `s.Files()`, the form encoding and the body limit, is in [Stored files](files.md#files-posted-to-an-action).
