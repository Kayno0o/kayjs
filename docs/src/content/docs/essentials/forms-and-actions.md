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

`form(action={add})` posts without JavaScript. `field="title"` names the input `title`, and `kay check` verifies the name against the schema. It also writes what the schema asks of `title` as attributes the browser checks: here `required`, `minlength` and `maxlength`. With kay's script the form posts without a reload, checked against the schema first, so the browser shows the schema's `error` message.

A field's `error` is a text, or a function such as `error: () => t('titles.required')` that kay calls in the request's locale, both for the server's refusal and for the rules the page carries, so a visitor reads their own language with or without JavaScript. A function that throws or returns no string leaves the field its default wording. A `query` or `defineEnv` schema field reads its `error` the same way.

Text reaches the schema trimmed, and an optional field left blank counts as left out.

## An action with no input

An action that takes nothing, such as a sign-out, leaves the schema out and gives its handler alone. The handler gets the context.

```kay
export const signOut = action(async (ctx) => {
  await ctx.locals.session.destroy()
  ctx.redirect('/')
})
```

`form(action={signOut})` posts it, and an island calls `signOut()`. Options such as a rate limit go second, as they do with a schema.

## Actions shared by pages and components

An action that a page and a component both use lives in a file called `_actions.kay`, in a routes directory. It has a server fence and no template, and it is not a page. A page or a component imports its actions by path.

```kay
--- server
import { s } from 'kay'

export const deleteTissue = action(s.Object({ id: s.Integer() }), async ({ id }) => {
  await removeTissue(id)
})
---
```

```kay
---
import { deleteTissue } from '../routes/admin/_actions.kay'
---
button(onClick={() => deleteTissue({ id })}) Delete
```

It is served behind the `_guard.ts` files of its directory and above, like the actions of a `_layout.kay`, and it can read the params of every page below it. It is served for the pages in its folder and below, so it sits in or above a folder with a page.

## Showing errors

A post the schema refuses renders the page again, and the fields keep what was sent. An `error` line shows the message of a field, and a bare `error` the form-wide one.

```kay
form(action={add})
  error
  input(field="title")
  error title
  button Add
```

While the post is refused, `error title` renders `p.error` with the message, and the field is marked `aria-invalid` and described by it. Anywhere else, `add.error('title')` reads the message.

## Failing on purpose

A handler refuses a post with `ctx.fail(status, data)`, and the page reads `data` with `add.failed()?.data`.

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

A handler that throws is logged, and the form shows `Something went wrong on our side; try again later`, so it needs no `try`/`catch` of its own.

## Redirecting after success

`ctx.redirect()` in the handler sends the browser elsewhere. Write it as `return ctx.redirect()`, as in a guard. Without a redirect the post goes back to the page, where `add.succeeded()` holds what the handler returned for that one render. The handler's `ctx` also has `url`, `notFound()` and `deny()`, as a page's does.

```kay
export const signUp = action(schema, async (input, ctx) => {
  const user = await createUser(input)

  return ctx.redirect(`/welcome/${user.id}`)
})
```

## Route params

An action reads the params of the page it was posted from in `ctx.params`. In `src/routes/orgs/[org]/projects.kay`:

```kay
--- server
import { projects } from '../../../db'

export const remove = action(s.Object({ id: s.String({ maxLength: 36 }) }), async ({ id }, ctx) => {
  await projects.remove({ org: String(ctx.params.org), id })
})
---
```

The guards checked the visitor against `ctx.params`, not against the input, which the visitor chooses, so the handler scopes what it touches by them.

## Calling an action from an island

An island imports the action from the page and calls it from a submit handler, which stops kay's own post. A refused call throws an `ActionError`, and `add.error('title')` shows the message.

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

In a `catch`, `add.refused(error)` tells a refusal from `ctx.fail` apart from any other error and types `error.data`. `focusInvalid()` from `kay` moves focus to the first field marked `aria-invalid`.

While an island's `onSubmit` returns a promise, the form and its submit buttons are `aria-busy`.

Once a call goes through, the page's loads run again, so the list it shows is up to date. `add({ title }, { refresh: false })` leaves the page as it is.

## Fixed fields

A button that always posts the same values, such as a row's move-up arrow, needs no hidden inputs. `with` gives the action with its fields fixed, and the form carries them without JavaScript too.

```kay
---
import { move } from '../routes/index.kay'

const { id } = props<{ id: number }>()
---
form(action={move.with({ id, to: 2 })})
  button(aria-label="Move up") Up
```

The handler gets `id` and `to` as if the form had posted them, checked by the schema. The values travel in the form's action URL, so a visitor can change them as they could change hidden inputs: the handler still checks what it may do. They also show in server logs and in referrers, so keep secrets out of them.

## Reading one call's outcome

`add.pending()` is true while any call the page made to `add` is running, so a row of buttons calling one action would all spin together. `add.track()` gives a handle for one component: its `pending()` reads only the calls made through it, and a call resolves with how it went instead of throwing when the server refuses it.

```kay
---
import { remove } from '../routes/index.kay'

const { id } = props<{ id: string }>()
const removing = remove.track()
const problem = signal('')

async function onRemove() {
  const result = await removing({ id })

  if (!result.ok)
    problem.set(result.data?.message ?? 'Could not remove it')
}
---
button(disabled={removing.pending()} onClick={onRemove}) Remove
if problem() !== ''
  p.error {problem()}
```

Any answer other than success gives `{ ok: false, status, errors, data }`, with `errors` per field and `data` typed as the handler passes it to `ctx.fail`. A success gives `{ ok: true, data }`. A failure with no answer from the server, such as a lost connection, still throws. Here `data.message` is what the handler passed to `ctx.fail(409, { message })`.

## File uploads

Use `s.File()` in the schema and `input(type="file" name="avatar")` in the form, and the handler receives a `File`, which `files.put` stores. A post carries 1 MB at most, so raise `bodyLimit` in the third argument of `action`. See [File storage](/guides/file-storage).

## A post from another site

An action refuses a post that another site sends, as its `Origin` or `Sec-Fetch-Site` header shows, with a 403 in plain text that says what it saw:

```text
Cross-site action refused: Origin http://localhost:4701 is not this site (http://127.0.0.1:4701; set or fix site in kay.config.ts if a proxy changes the host)
```

The `Origin` must have the host of the request or of `site` in kay.config.ts, whatever the scheme. So open the site by the address it is served on, or, behind a proxy that does not pass the browser's `Host` on (nginx leaves it out unless told `proxy_set_header Host $host`), set `site` to the public address. A refusal for `Sec-Fetch-Site` says `Sec-Fetch-Site is cross-site and the request has no Origin, not same-origin or none`. An api route refuses the same way, saying `request` where this says `action`.

## Rate limit, honeypot, minimum time and proof-of-work

The third argument of `action` protects it from scripts. `rateLimit` answers 429 past `max` posts per `window`, `honeypot` names a hidden field that kay renders for you and bots fill in, and `minTime` refuses a form posted sooner than that after its page rendered. For spam that still gets through, `proofOfWork: true` makes each post cost the sender CPU, with no third-party script, and needs JavaScript in the browser. `minTime: { after: '3s', plain: true }` checks only forms posted without JavaScript, and `workChallenge` and `verifyWork` from `kay/server` put proof of work in a form field your own code checks.

```kay
export const contact = action(schema, send, {
  rateLimit: { max: 5, window: '1m' },
  honeypot: 'website',
  minTime: '3s',
  bodyLimit: 5 * 1024 * 1024,
})
```

`minTime` stamps are signed. An app with no `session()` gives the signing key as `secret` in `kay.config.ts`, or as `KAY_SECRET`, at least 32 random characters. Without one a production server signs with a key of its own process, which a restart changes and other replicas do not share, and says so once in its log.

<ReadMore href="/llms/actions">Optimistic calls, aborting a call, custom browser validation, proof of work, shared rate limit stores, messages and body limits are in the full actions reference.</ReadMore>
