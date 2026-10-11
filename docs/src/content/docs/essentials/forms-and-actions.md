---
title: Forms and actions
order: 5
description: A page exports an action with a schema, a form posts to it with or without JavaScript, and field errors come back typed.
---

An action is a schema and a handler exported from a page's server fence. It becomes a POST endpoint with its input validated.

```kay
--- server
import { s } from 'kay'
import { addTodo } from '../data'

const newTodo = s.Object({
  title: s.String({ minLength: 1, maxLength: 200, error: 'Write a title' }),
})

export const add = action(newTodo, async ({ title }) => {
  return (await addTodo(title)).id
})
---
form(action={add})
  input(field="title" placeholder="New todo")
  button Add
```

`form(action={add})` posts without JavaScript. `field="title"` names the input `title`, and `kay check` verifies the name against the schema. It also writes what the schema asks of `title` as attributes the browser checks without JavaScript: here `required`, `minlength` and `maxlength`. With kay's script the form posts without a reload, checked against the schema first, so the browser shows the schema's `error` message.

Text reaches the schema trimmed, so `minLength` counts what was typed, and an optional field left blank counts as left out. A field named like a password keeps its spaces, as does `s.String({ trim: false })`.

## Showing errors

A post the schema refuses renders the page again with the failure's status. The fields keep what was sent, and an `error` line shows the message of a field. A bare `error` shows the form-wide one.

```kay
form(action={add})
  error
  input(field="title")
  error title
  button Add
```

While the post is refused, `error title` renders `p.error` with the message, and the field gets `aria-invalid` and an `aria-describedby` naming that paragraph. `error.text-sm title` adds classes. Anywhere else, `add.error('title')` reads the message.

## Failing on purpose

A handler refuses a post with `ctx.fail(status, data)`. Its `data` is read with `add.failed()?.data`, and a string becomes the form-wide message, read with `add.error()`.

```kay
export const add = action(schema, async ({ title }, ctx) => {
  if (await exists(title))
    return ctx.fail(409, { message: 'Already on the list' })

  await addTodo(title)
})
```

```kay
if add.failed()?.data as data
  p.error {data.message}
```

A handler that throws, a mail server down say, is logged and answered the same way, with status 500 and `Something went wrong on our side; try again later` under the form, so it needs no `try`/`catch` of its own. `messages: { serverError: '...' }` in the third argument of `action` words it for the site.

## Redirecting after success

`ctx.redirect()` in the handler sends the browser elsewhere. Without it the post goes back to the page, where `add.succeeded()` holds what the handler returned for that one render.

```kay
export const signUp = action(schema, async (input, ctx) => {
  const user = await createUser(input)

  ctx.redirect(`/welcome/${user.id}`)
})
```

## Route params

An action reads the params of the page it was posted from in `ctx.params`, as the guards above it read them. In `src/routes/orgs/[org]/projects.kay`:

```kay
--- server
import { action } from 'kay'
import { projects } from '../../../db'

export const remove = action(s.Object({ id: s.String() }), async ({ id }, ctx) => {
  await projects.remove({ org: String(ctx.params.org), id })
})
---
```

A post from no page of the action's route is refused with 400, before any guard runs when guards cover the page, else once the handler reads `ctx.params`: an action that never reads them can be called from any page. The guards checked the visitor against `ctx.params`, not against the input, which the visitor chooses, so the handler scopes what it touches by them.

## Calling an action from an island

An island imports the action from the page and calls it from a submit handler, which stops kay's own post. A refused call throws an `ActionError`, and `add.error('title')` shows the message reactively.

```kay
---
import { add } from '../routes/index.kay'

const title = signal('')

async function submit(event: SubmitEvent) {
  event.preventDefault()
  await add({ title: title() })
}
---
form(action={add} onSubmit={submit})
  input(name="title" bind:value={title})
  if add.error('title') as message
    p.error {message}
  button(disabled={add.pending()}) Add
```

When the handler refused the call with `ctx.fail(status, data)`, `add.refused(error)` in a `catch` tells that refusal apart from any other error and types `error.data` as the handler passed it, with no cast. `focusInvalid()` from `kay` then moves focus to the first field marked `aria-invalid`, once the island rendered what the refusal changed, and resolves to whether one took it. A field inside `hidden="until-found"` or a closed `details`, as on a tab not shown, is revealed first as find-in-page does, with a `beforematch` event a tab list shows its panel on, and so is the field a refused post focuses. A disabled or inert field reveals nothing, and a `beforematch` listener hiding its element again stops the reveal there.

Once a call goes through, the page's loads run again, so the list it shows is up to date. `add({ title }, { refresh: false })` leaves the page as it is, and `add({ title }, { signal })` aborts with the signal, rejecting with its reason. The server may have run a call aborted once it was sent, so the page refreshes then too.

## File uploads

Use `s.File()` in the schema and `input(type="file" name="avatar")` in the form, and the handler receives a `File`, which `files.put` stores. A post carries 1 MB at most, so raise `bodyLimit` in the third argument of `action`. An island calling the action reads `add.progress()` while the file uploads. See [File storage](/guides/file-storage).

## Rate limit, honeypot, minimum time and proof-of-work

The third argument of `action` protects it from scripts. `rateLimit` answers 429 past `max` posts per `window`, `honeypot` names a hidden field that kay renders for you and bots fill in, and `minTime` refuses a form posted sooner than that after its page rendered, through a stamp kay signs into the form itself, a prerendered page included.

For spam that still gets through, `proofOfWork: true` makes each post cost CPU, as ALTCHA does, with no third-party script and no new CSP source: kay's script solves a signed challenge in a worker while the visitor fills the form in, and a post without the solution fails with 422. A form posted without JavaScript is refused, unless the action sets `minTime` too, which then checks such a post alone. A form with `data-reload` or a `target`, which the browser posts itself, sends no solution either. The difficulty is settable, `proofOfWork: 300_000`, 100,000 by default.

```kay
export const contact = action(schema, send, {
  rateLimit: { max: 5, window: '1m' },
  honeypot: 'website',
  minTime: '3s',
  bodyLimit: 5 * 1024 * 1024,
})
```

`messages` in the same argument words each of these refusals in the site's language.

<ReadMore href="/llms/actions">Optimistic calls, custom browser validation, shared rate limit stores, messages and body limits are in the full actions reference.</ReadMore>
