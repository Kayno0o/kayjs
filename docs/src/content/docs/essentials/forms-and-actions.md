---
title: Forms and actions
order: 5
description: A page exports an action with a schema, a form posts to it with or without JavaScript, and field errors come back typed.
---

An action is a schema and a handler exported from a page's server fence. It becomes a POST endpoint with its input validated.

```kay
--- server
import { t } from 'kay'
import { addTodo } from '../data'

const newTodo = t.Object({
  title: t.String({ minLength: 1, maxLength: 200, error: 'Write a title' }),
})

export const add = action(newTodo, async ({ title }) => {
  return (await addTodo(title)).id
})
---
form(action={add})
  input(name="title" placeholder="New todo")
  button Add
```

`form(action={add})` posts without JavaScript, and `kay check` verifies every field `name` against the schema. With kay's script the form posts without a reload.

Text reaches the schema trimmed, so `minLength` counts what was typed, and an optional field left blank counts as left out. A field named like a password keeps its spaces, as does `t.String({ trim: false })`.

## Showing errors

A post the schema refuses renders the page again with the failure's status. The fields keep what was sent, and `add.error('title')` reads the message of a field.

```kay
form(action={add})
  input(name="title")
  if add.error('title') as message
    p.error {message}
  button Add
```

The refused field also gets `aria-invalid` and `aria-describedby` by itself.

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

Once a call goes through, the page's loads run again, so the list it shows is up to date. `add({ title }, { refresh: false })` leaves the page as it is.

## File uploads

Use `t.File()` in the schema and `input(type="file" name="avatar")` in the form, and the handler receives a `File`. A post carries 1 MB at most, so raise `bodyLimit` in the third argument of `action`.

## Rate limit, honeypot and minimum time

The third argument of `action` protects it from scripts. `rateLimit` answers 429 past `max` posts per `window`, `honeypot` names a hidden field that kay renders for you and bots fill in, and `minTime` refuses a form posted sooner than that after its page rendered, through a stamp kay signs into the form itself, a prerendered page included.

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
