# Actions

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

### Call an action from an island

An island imports the action from the page and calls it, catching `ActionError` to show the schema's messages:

```kay
---
import { ActionError } from 'kay'
import { add } from '../routes/index.kay'

const title = signal('')

async function save() {
  try {
    await add({ title: title() })
    title = ''
  }
  catch (error) {
    if (!(error instanceof ActionError))
      throw error
  }
}
---
input(bind:value={title})
if add.error('title') as message
  p.error {message}
button(onClick={save} disabled={add.pending()}) Add
```

### Show a change before the server answers

`optimistic` writes the signals at once and puts them back if the call fails:

```kay
---
import { move } from '../routes/board.kay'

const { id } = props<{ id: number }>()
const column = signal('todo')
---
button(onClick={() => move({ id, to: 'done' }, { optimistic: () => column.set('done') })}) Done
p {column()}
```

### Accept a file

`s.File()` in the schema, `input(type="file" name="avatar")` in the form, and the handler gets a `File`:

```kay
--- server
import { s } from 'kay'

export const upload = action(
  s.Object({ avatar: s.File({ type: 'image/png' }) }),
  async ({ avatar }) => avatar.size,
  { bodyLimit: 10 * 1024 * 1024 },
)
---
form(action={upload})
  input(type="file" name="avatar")
  error avatar
  button Upload
```

### Keep scripts from flooding a form

A third argument limits attempts and traps bots, `rateLimit` answering 429 past `max` posts every `window` and `honeypot` failing a form that fills a hidden field:

```kay
--- server
import { s } from 'kay'

export const contact = action(
  s.Object({ message: s.String({ maxLength: 2000 }) }),
  async ({ message }) => message.length,
  { rateLimit: { max: 5, window: '1m' }, honeypot: 'website', minTime: '3s' },
)
---
form(action={contact})
  textarea(field="message")
  error
  button Send
```

### Limit attempts in a guard or an API route

`rateLimit(name, { max, window })` from `kay/server` counts attempts from the request's client and gives the seconds to wait once over the limit:

```ts
// src/routes/account/_guard.ts
import { guard } from 'kay'
import { rateLimit } from 'kay/server'

const visits = rateLimit('account', { max: 60, window: '1m' })

export default guard(async ({ request, headers, deny }) => {
  const wait = await visits.hit(request)

  if (wait !== undefined) {
    headers.set('retry-after', String(wait))
    deny(429, `Too many requests; try again in ${wait} s`)
  }
})
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

- `s` from `kay` is Elysia's schema builder, its `t` under the name translations leave free, there to save an import in server fences and server modules, `defineEnv` and API modules included.
- The browser has none, nor Elysia's, which reads `Bun`: schemas live in modules only the server imports, and what an island needs of one, a length or a list of choices, in another module both import.
- A client build, `kay dev`'s and `kay test`'s included, refuses an island reaching kay's `s`, naming the modules taking it from `kay`.
- `t` from `kay` is the same builder, deprecated: `kay check` reports it and `--fix` renames it `s`.
- The handler's second argument has `request`, `cookies`, `locals`, `status(code)`, `headers`, `redirect(location)` and `fail(status, data)`, whose status is an error status, 400 to 599.
- A location outside ASCII, such as `/blog/日本語`, goes out percent-encoded, from pages and guards too.
- A location holding a control character, or a scheme other than `http:` and `https:`, such as `javascript:`, throws.

### Forms

- `form(action={add})` posts without JavaScript.
- Inside it, `input(field="title")`, on an `input`, `textarea` or `select`, renders `name="title"` plus the constraints the browser checks without JavaScript that the schema gives `title`: `required` where the server would refuse the field left blank (never for a boolean, so a checkbox stays optional, nor a list), `minlength`, `maxlength`, `pattern` (matched anywhere, as the schema matches it, and left out when the browser could not read it), `min`, `max` and `type="email"`, each unless the template writes it.
- `field` takes written text, never both `field` and `name`, and only inside such a form.
- `kay check` verifies every `field` and `name` against the schema.
- Once kay's script runs it sets `novalidate` on every form posting to an action and checks the form against the schema itself, so the schema's `error` messages show rather than the browser's, then the constraints the template wrote itself.
- An island renders its fields without the constraints, kay's check covering them.
- After the post the browser goes back to the page, or wherever the handler's `ctx.redirect` points.
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
- The message is `Something went wrong on our side; try again later` unless the action words its own, `action(schema, handler, { messages: { serverError: 'Not sent; write to hello@example.com instead' } })`, so a handler needs no `try`/`catch` of its own to tell the visitor.
- A redirect or a guard's denial thrown is no error.

### Refused fields and their messages

- A form posting to an action shows a refused post again by itself: each `input`, `textarea` and `select` in it whose `name`, and `type` if any, are written out takes the value the post sent in place of the one the template gives, a checkbox or radio button whether it was ticked, a password, a file and the honeypot excepted.
- Each field the post was refused for gets `aria-invalid="true"`, and `aria-describedby` naming the element showing its message, so a screen reader reads the message with the field.
- An `error title` line inside the form shows that message: `p.error`, with the id `add-title-error`, while the post is refused for `title`, nothing otherwise.
- `error.text-sm title` adds classes.
- A quoted name such as `error "first-name"` takes any field, and the name is typed from the schema.
- A bare `error` shows the form's own message, `add.error()`, its `form` described by it.
- One inside a `for` renders without an id and describes nothing.
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
- `data` travels in a cookie, sealed (AES-GCM under a key derived from the session's secret, else from the preview `secret`, else a key of the process, which a restart changes), so a secret shown once, such as a new API token, can be neither read nor altered in it.
- Data too big for it, over about 3.5 KB sealed, is left out with a warning, and `ctx.succeeded` returns `undefined`, as it does for a cookie that does not open, forged or sealed before a restart.
- A prerendered page reads both too: the request carrying that cookie renders it afresh, see [Prerendering](routing.md#prerendering).
- The cookie carrying `ctx.succeeded` back is `HttpOnly`, `SameSite=Lax`, and `Secure` when the request came over https, `X-Forwarded-Proto` included, as is every request in production when `site` is https.

### Calling from an island

- An island imports the action from the page and calls it: `import { add } from '../routes/index.kay'`, then `const id = await add({ title })`.
- Once a call went through, the page shows what it changed, its loads run again as `refresh()` runs them, where the page swap runs: islands whose props did not change keep their state.
- `add({ title }, { refresh: false })` leaves the page as it is.
- `add.pending()` reads, reactively, whether a call the page made is still in flight, and `add.progress()` how much of a call carrying files the browser sent, from 0 to 1: `button(disabled={add.pending()})`.
- `await move({ id, to }, { optimistic: () => tiers.set(moved) })` shows the change at once: if the call fails, or the function throws, each signal the function wrote goes back to what it held, those another optimistic call made inside it wrote included, unless something wrote it since, while that call's `pending()` follows its own request, and the call throws as any does.
- Two such calls over one signal failing out of order may leave the first one's value, so an island lets one move finish before the next, as `add.pending()` tells.
- Once it went through, the refresh brings what the server kept, which a `linked` signal then takes.
- `{ signal }` aborts a call: it rejects with the signal's reason, what `optimistic` showed goes back, and the action records no outcome.
- The server may still have run a call aborted once sent, so the page refreshes then as after one that went through, unless `refresh: false`.
- The call is typed, `ctx.fail` results excluded, and throws `ActionError` from `kay` with `status`, `errors` and `data` when it fails.
- `add.refused(error)` tells a refusal of a call to `add` from any other error, a redirect's included, and types its `data` as the handler passes it to `ctx.fail`, with no cast: `if (add.refused(error)) shown = error.data?.message`.
- `data` is undefined for a call refused before the handler ran, by the schema or a limit.
- Its input, its result and that `data` cross as island props do, Dates, Maps, Sets and bigints included; a result holding a function or a class instance answers 500, logging where it sits.
- When the handler or a guard redirects, the browser goes there, swapping the page in as a link would, and the call never resolves.
- A leave guard keeping the visitor on the page settles the call instead, throwing `ActionRedirect`, so `pending()` clears; a call made on a page the visitor has left since throws it too, taking them nowhere.
- Outside a browser, as in a test, a redirect throws `ActionRedirect` from `kay` with `location`.

```kay
---
import { ActionError } from 'kay'
import { add } from '../routes/index.kay'

const title = signal('')

async function save() {
  try {
    await add({ title: title() })
    title = ''
  }
  catch (error) {
    if (!(error instanceof ActionError))
      throw error
  }
}
---
input(bind:value={title} aria-invalid={add.error('title') ? 'true' : undefined})
if add.error('title') as message
  p.error {message}
button(onClick={save} disabled={add.pending()}) Add
```

### Files

- `s.File()` or `s.Files()` in the schema, `input(type="file" name="avatar")` in the form, and the handler gets a `File`, which `files.put` stores (see [Stored files](files.md)).
- Forms posting to an action are sent as `multipart/form-data` unless they set `enctype`.
- A file input left empty counts as no file, so `s.Optional(s.File())` works.
- An island passes a `File` or `Blob` anywhere in its input, nested ones included: `await upload({ avatar: input.files[0] })`.
- On a top-level field, `s.File({ type: 'image/png' })` checks the file's bytes, not its name or declared type.
- A file it refuses fails like any field, under its name in `errors` with the schema's `error` option when set.
- A nested file is checked against the type it declares only.
- A post sends 1 MB at most unless the action raises its `bodyLimit`, see below, which a form taking files usually does.

### Cross-site posts

- A post another site sends, as its `Origin` or `Sec-Fetch-Site` header shows, is refused with 403.
- A post from the host of `site` in kay.config.ts is the site's own, so a proxy that does not pass the browser's `Host` on, and nginx leaves it out unless told `proxy_set_header Host $host`, refuses none.

### Protecting an action

- A third argument protects an action from scripts: `action(schema, handler, { rateLimit: { max: 5, window: '1m' }, honeypot: 'website' })`.
- None of these reaches the handler.

#### Rate limits

- `rateLimit` lets one client post `max` times every `window`, then answers 429 with `Retry-After` and `errors['']` saying when to retry.
- It counts every attempt, valid or not, unless it says `count: 'succeeded'`: then only the posts whose handler returned without `ctx.fail`, an error or a refusal count, so typos and a mail server failing lock no one out, a redirect from the handler counting as gone through.
- Posts arriving together all read the count before any adds to it, so a burst may pass `max` by a few.
- Several limits all apply, each counting every attempt it is meant to count whichever refuses it, the longest wait the one told: `rateLimit: [{ max: 30, window: '10m' }, { max: 5, window: '10m', count: 'succeeded' }]` slows a script hammering the form and lets five messages through, each limit counting under its place in the list.
- The client is the address the request came from, or the one the proxies in front passed on once `proxy` says how to read it (see [Behind a proxy](production.md#behind-a-proxy)).
- An IPv6 client counts as its /64 block, which one host or home network holds.
- Counts live in the process unless `store` names a shared one, for at most 100,000 windows in all, the oldest dropped past that.
- `rateLimit: { max: 5, window: '1m', store: sqliteRates('data/rates.sqlite') }`, `sqliteRates` from `kay/server`, counts every process of the machine opening that file together.
- `RateStore`, a `hit(key, windowMs)` method giving `{ count, resetAt }` and, for a limit counting what went through, a `peek(key)` giving the open window without counting or `undefined`, is the shape of an app's own.

#### Honeypot

- `honeypot` names a field a form posting to the action renders by itself as its first child, out of sight, out of the tab order, hidden from screen readers and marked for 1Password, LastPass and Bitwarden to skip, which people leave empty and bots fill in.
- A form post giving it any value, a file included, fails with 422 and `errors.website`.
- It is hidden by a `style` attribute, which a `csp` dropping `style-src 'unsafe-inline'` would leave visible.
- A page writing the field itself as well renders it twice, which still posts empty.
- A form inside an island renders it itself, as its markup is claimed node by node when it hydrates: `div(style="position:absolute;left:-9999px" aria-hidden="true" inert)` around `input(name="website" tabindex="-1" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore)`, and `kay check` takes it as one of the form's fields.
- `honeypot: { field: 'website', pretend: true }` answers a bot filling it in as if its post went through instead, a call with no result and a plain form post going back to its page with `ctx.succeeded(add)` holding `data: undefined`, so the bot learns nothing to adjust.

#### Minimum time

- `minTime: '3s'` refuses a form posted sooner than that after its page rendered, with 422 and `errors['']`.
- A form posting to the action renders a hidden `kay_since` field by itself, a stamp of when it rendered bound to the action and signed with a key derived from the session's secret, else from the preview `secret`, else a key of the process, which a restart changes and a production server warns of once.
- A plain form post whose stamp is missing, forged, another action's or older than `maxAge`, a day by default, fails the same way, and the page it answers keeps the stamp the form rendered with, so the visitor does not wait again from zero.
- A prerendered page holding such a form is still rendered once: the server signs a fresh stamp into it on every visit, as it splices in an inline server island, so the page goes out gzipped rather than in brotli and kept by no cache.
- `minTime: { after: '3s', maxAge: '1h', pretend: true }` answers a post sent too soon as `honeypot`'s `pretend` does.
- A form inside an island renders no stamp, so a call from kay's script without one goes through, a stamp it sends still checked.
- `site.submit` from a `Visit` sends its form's stamp, and `setSystemTime` from `bun:test` moves the clock past `minTime`.

#### Refusal messages

- The refusals of these limits, and the one for a post over `bodyLimit`, read in English unless `messages` gives the site's own, as a schema's `error` does for a field: `` messages: { honeypot: 'Laissez ce champ vide', minTime: reason => reason === 'early' ? 'Un instant, puis renvoyez-le' : 'Ce formulaire a expiré, renvoyez-le', rateLimit: wait => `Réessayez dans ${wait} s`, bodyLimit: bytes => `${bytes} octets au plus` } ``.
- `rateLimit` is given the seconds to wait.
- `minTime` is given `early` for a post sent too soon or `expired` for a stamp missing, forged or past `maxAge`, as a page from before a restart sends.
- `proofOfWork` is given `missing`, `expired` or `wrong` as below.
- `bodyLimit` is given the most bytes a post may send.
- Each is a string or a function; `serverError` is a string.

#### Proof of work

- `proofOfWork: true` makes each post cost the sender CPU, as ALTCHA does, for a site still getting spam past the others, with no third party, no cookie and no new `csp` source.
- The page carries a challenge for each action its forms post to, the hash of a random salt and a number up to the difficulty, signed as the `minTime` stamp is and bound to the action.
- Kay's script solves it in a worker, a same-origin file the browser build ships, from the moment one of those forms takes focus, then sends the solution with the post in an `x-kay-work` header.
- `proofOfWork: 300_000` sets the difficulty, 100,000 by default: the browser hashes half of it on average, some tens of milliseconds on a laptop, more on an old phone.
- `{ difficulty, maxAge: '1h', pretend: true, store }` sets how long a challenge stays good, a day by default.
- `pretend` answers a wrong number or a solution sent twice as `honeypot`'s `pretend` does.
- `store` keeps the solutions already used, each going through once, a `RateStore` as `rateLimit` takes, `sqliteRates(path)` sharing them between the processes of a machine, this process's memory by default.
- A post without a solution, or to a challenge past `maxAge`, another action's or signed before a restart, fails with 422 and `errors['']` carrying a fresh challenge in the same header: an island's call, a script's with no form on the page included, solves it and goes again by itself, the call waiting on it then.
- A form posted without JavaScript sends none and is refused, unless the action sets `minTime` too: a post without JavaScript is then checked by `minTime` alone, so the pair stops no script that waits it out.
- A form posted with `navigation: false` and no island has no script either, nor does one with `data-reload` or a `target`, which the swap leaves to the browser.
- A prerendered page gets a fresh challenge on every visit, as a stamp.
- `site.submit` and `site.call` solve one themselves; a test sending its own `x-kay-work` header, `''` for none, checks the refusal.

### Limits outside an action

- A guard, an API route or a library limits attempts the same way with `rateLimit(name, { max, window, store })` from `kay/server`: `await limit.hit(request)` counts one from the request's client and gives the seconds to wait once over the limit, else `undefined`.
- `await limit.hit(user.email)` counts under the app's own key instead, such as an account or a socket, whoever sends the request.
- Limits of one name count together; an action's counts under its URL.

```ts
// src/routes/account/_guard.ts
import { guard } from 'kay'
import { rateLimit } from 'kay/server'

const visits = rateLimit('account', { max: 60, window: '1m' })

export default guard(async ({ request, headers, deny }) => {
  const wait = await visits.hit(request)

  if (wait !== undefined) {
    headers.set('retry-after', String(wait))
    deny(429, `Too many requests; try again in ${wait} s`)
  }
})
```

- A library or route limiting attempts its own way reads the client as `rateLimit` does: `clientAddress(request, server)` and `rateKey(address)` from `kay/server` give the address, read through the `proxy` setting, and the key a limit counts it under, an IPv6 address's /64 block.

### Body limit

- A request to an action or an API route sends at most `bodyLimit` bytes, 1 MB unless kay.config.ts sets another: `bodyLimit: 4 * 1024 * 1024`.
- An action raises or lowers it for itself, `action(schema, handler, { bodyLimit: 20 * 1024 * 1024 })`, and an API module for its routes, `api({ bodyLimit })`.
- A bigger request is refused before anything reads it, from its `Content-Length`, or, sent in chunks without one, as soon as it passes the limit.
- A plain form post goes back to its page with `errors['']` saying the most it may send, an island's call throws `ActionError` with status 413 and that error, and an API route answers 413.
- Bun's own cap, 128 MB unless `new Elysia({ serve: { maxRequestBodySize } })` sets another, holds whatever `bodyLimit` says, and it alone limits the app's own routes.
