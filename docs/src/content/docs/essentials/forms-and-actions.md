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

`form(action={add})` posts without JavaScript. `field="title"` names the input `title`, and `kay check` verifies the name against the schema.

`field` also writes what the schema asks of `title` as attributes the browser checks. Here that is `required`, `minlength` and `maxlength`.

With kay's script the form posts without a reload. It is checked against the schema first, so the browser shows the schema's `error` message.

A field's `error` is a text, or a function such as `error: () => t('titles.required')`. kay calls the function in the request's locale, so a visitor reads their own language with or without JavaScript. A function that throws or returns no string leaves the field its default wording.

Text reaches the schema trimmed, and an optional field left blank counts as left out.

## A choice among a record's keys

A `select` often takes its options from a record that maps each value to a label. `s.UnionKeys(record)` is the schema for the value the visitor picks: only the record's keys pass, and the handler gets them typed as the union of the keys, with no cast.

```kay
--- server
import { s } from 'kay'
import { sendMessage } from '../mail'

const TOPICS = { billing: 'Billing', support: 'Support' }
const choices = Object.entries(TOPICS).map(([value, label]) => ({ value, label }))

export const contact = action(s.Object({ topic: s.UnionKeys(TOPICS) }), async ({ topic }) => {
  await sendMessage(topic)
})
---
form(action={contact})
  select(field="topic")
    for choice of choices
      option(value={choice.value}) {choice.label}
  button Send
```

Adding a key to the record adds the option and the accepted value together. A record with no key is refused when the server starts.

## An action with no input

An action that takes nothing, such as a sign-out, leaves the schema out and gives its handler alone. The handler gets the context.

```kay
--- server
export const signOut = action(async (ctx) => {
  await ctx.locals.session.destroy()
  ctx.redirect('/')
})
---
form(action={signOut})
  button Sign out
```

`form(action={signOut})` posts it, and an island calls `signOut()`. Options such as a rate limit go second, as they do with a schema.

## Actions shared by pages and components

An action that a page and a component both use lives in a file called `_actions.kay`, in a routes directory. It is a server fence and nothing else: no template, and no closing `---` line, because the fence runs to the end of the file. It is not a page. A page or a component imports it by path.

```kay
--- server
import { s } from 'kay'

export const deleteTissue = action(s.Object({ id: s.Integer() }), async ({ id }) => {
  await removeTissue(id)
})
```

```kay
---
import { deleteTissue } from '../routes/admin/_actions.kay'
---
button(onClick={() => deleteTissue({ id })}) Delete
```

Its actions are served behind the `_guard.ts` files of its directory and above, like those of a `_layout.kay`. They serve the pages in its folder and below, so the file sits in or above a folder with a page.

An action in it can read the params of every page below it.

## One schema for the server and the browser

A schema is built with `s`, which only the server has. An island cannot import one, but it can import the type read off it, which leaves the module out of its bundle. Write the schema once in a `.ts` module, with its type beside it.

```ts
// src/schemas.ts
import type { Static } from 'kay'
import { s } from 'kay'

export const choice = s.Union([s.Literal('smash'), s.Literal('pass')])
export type Choice = Static<typeof choice>
```

An action and an API route import `choice`. An island writes `import type { Choice } from '../schemas'`.

`InputOf<typeof contact>` from `kay` is the input of an action, for a mail or a module the handler calls to type its argument without writing the fields again.

<ReadMore href="/llms/schemas">Where a shared schema lives, and what an island may read of it.</ReadMore>

## Showing errors

A post the schema refuses renders the page again, and the fields keep what was sent. An `error` line shows the message of a field. A bare `error` shows the form-wide one.

```kay
form(action={add})
  error
  input(field="title")
  error title
  button Add
```

While the post is refused, `error title` renders `p.error` with the message. The field is marked `aria-invalid` and described by it.

Anywhere else, `add.error('title')` reads the message.

### Showing that a form is posting

A `pending` block inside the form shows only while that form posts. No script of your own is needed, and the page gets none from it.

```kay
form(action={add})
  input(field="title")
  button Add
  pending
    p Saving...
```

The block is hidden when the page renders, after the answer, after a refused post and with JavaScript off. It stays shown until the page a redirect leads to is in, and while a page from another origin, or a reload after a lost answer, is loading. A load that never replaces the page, such as a download, loses it after ten seconds. Its text goes to screen readers through a polite live region the runtime writes outside the form.

In an island, the form shows it as well while a call of its action is in flight, however the handler or a button made it, and while its `onSubmit` waits for a promise. It follows every call of the action, so the forms of a list sharing one action all show it while one of them is saved. A handle from `add.track()` follows only its own calls and is no action a form can post to, so it is not written in `action`.

The block adds no element of its own to the layout: what it holds sits in the form as if written there. No style is involved, so a strict `style-src` leaves it working. Outside a form that posts to an action, `pending` is an error.

### A component that holds the field

A form field component writes the control its parent hands it as a slot. It cannot give that control an `id`, so it ties the control to its hint with `describeField` from `kay`. Call it in the component's script with the ids to add.

```kay
---
import { describeField, uid } from 'kay'

const { hint } = props<{ hint: string }>()
const hintId = uid()

describeField(hintId)
---
slot
small(id={hintId}) {hint}
```

The first `input`, `select` or `textarea` the component renders gets `hintId` in its `aria-describedby`, after the ids kay adds for a refused field.

Pass `{ required: true }` as a second argument and that field gets `aria-required="true"` too, since a star beside a label is not read by a screen reader. `{ required: 'all' }` marks every field the component renders, such as a group of checkboxes. A field that writes its own `aria-required` keeps it.

A component that checks the field its own way marks it with `markInvalid(element, by, invalid)` from `kay`. `by` is any value naming the check, such as the component. The field stays `aria-invalid` while any source holds it, so the schema refusing it and your check do not undo each other.

```ts
import { markInvalid } from 'kay'

markInvalid(input, 'length', input.value.length < 8)
```

<ReadMore href="/llms/navigation#forms-posting-in-place">What `describeField` skips, and `focusInvalid` after your own writes.</ReadMore>

## Failing on purpose

A handler refuses a post with `ctx.fail(status, data)`. The page reads `data` with `add.failed()?.data`.

```kay
--- server
import { addTodo, exists } from '../data'
import { schema } from '../schema'

export const add = action(schema, async ({ title }, ctx) => {
  if (await exists(title))
    return ctx.fail(409, { message: 'Already on the list' })

  await addTodo(title)
})
---
```

```kay
if add.failed()?.data as data
  p.error {data.message}
```

A handler that throws is logged, and the form shows `Something went wrong on our side; try again later`. The handler needs no `try`/`catch` of its own.

## Redirecting after success

`ctx.redirect()` in the handler sends the browser elsewhere. Write it as `return ctx.redirect()`, as in a guard. Under a `base` the path goes under it however the action was posted or called. A path to a page of your site is written as a visit to it is answered, in the locale of the page and with the `trailingSlash` spelling, so the browser takes one request to get there. A path to a file, an endpoint or another site stays as you wrote it.

Without a redirect the post goes back to the page. There `add.succeeded()` holds what the handler returned, for that one render.

The handler's `ctx` also has `url`, `notFound()` and `deny()`, as a page's does.

```kay
--- server
import { createUser } from '../data'
import { schema } from '../schema'

export const signUp = action(schema, async (input, ctx) => {
  const user = await createUser(input)

  return ctx.redirect(`/welcome/${user.id}`)
})
---
```

## Route params

An action reads the params of the page it was posted from in `ctx.params`. This is `src/routes/orgs/[org]/projects.kay`.

```kay
--- server
import { projects } from '../../../db'

export const remove = action(s.Object({ id: s.String({ maxLength: 36 }) }), async ({ id }, ctx) => {
  await projects.remove({ org: String(ctx.params.org), id })
})
---
```

The guards checked the visitor against `ctx.params`, not against the input, which the visitor chooses. Scope what the handler touches by `ctx.params`.

## Calling an action from an island

An island imports the action from the page and calls it from a submit handler, which stops kay's own post.

A refused call throws an `ActionError`, and `add.error('title')` shows the message.

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

A page with a `server` fence can also hand an action to a component as a prop, such as `Assistant(run={reply})` or `Header(signOut={signOut})`. A static component renders it with `form(action={signOut})`. An island calls it as if it had imported it, and the prop keeps the action's types.

Type the prop with `Action` from `kay`. `Action<never, unknown>` takes any action. `NoInputAction<unknown>` takes one declared without a schema, such as a sign-out that ends in a redirect. To keep the input and output types, write them: `Action<{ name: string }, string>`. A handler that can `ctx.fail` still fits: the prop names what it returns on success, `Action<{ name: string }, string>`, and a stream is typed `Action<{ dossier: string }, AsyncGenerator<string>>`.

```kay
---
import type { NoInputAction } from 'kay'

const { signOut } = props<{ signOut: NoInputAction<unknown> }>()
---
form(action={signOut})
  button Sign out
```

 The action must be exported by a page or endpoint, in this page or another one. An action fixed with `.with()` cannot be passed: pass the plain action and give the fields as its input.

An island that does not type the prop with an action type fails the render, in production too, and the error names the fix. A static component that kay turns into an island because it passes a function to one follows the same rule.

In a `catch`, `add.refused(error)` tells a refusal from `ctx.fail` apart from any other error, and types `error.data`.

`focusInvalid()` from `kay` moves focus to the first field marked `aria-invalid`.

While an island's `onSubmit` returns a promise, the form and its submit buttons are `aria-busy`, and a second submit is ignored until the promise settles.

If the server received a form kay posted without reloading the page but its answer was lost, kay loads the page again rather than posting the form a second time.

Once a call goes through, the page's loads run again, so its list is up to date. `add({ title }, { refresh: false })` leaves the page as it is.

So an action suits a frequent write from an island, a vote or an undo, as well as an API route does: pass `{ refresh: false }`, and keep the schema, guards and rate limit an action brings. `add.track()` below answers a refusal as a result, with no `try`.

### Showing a change before the server answers

`optimistic` writes your signals at once. If the call fails, they go back to what they held.

```kay
---
import { move } from '../routes/board.kay'

const { id } = props<{ id: number }>()
const column = signal('todo')
---
button(onClick={() => move({ id, to: 'done' }, { optimistic: () => column.set('done') })}) Done
p {column()}
```

The call still throws when it fails. While it runs, `pending()` follows its own request. Let one call finish before the next on the same signal, as `move.pending()` tells, or a failure may leave the earlier value.

### Aborting a call

Pass an `AbortSignal` as `signal`. The call rejects with the signal's reason, what `optimistic` showed goes back, and the action records no outcome.

```ts
const controller = new AbortController()

search({ query }, { signal: controller.signal })
controller.abort()
```

The server may still have run a call that was already sent, so the page refreshes as after any other, unless `refresh: false`.

### Streaming an answer

A handler can send its answer in parts, such as a model's reply as it is written. With [kayjs-ai](/libraries/kayjs-ai), return `ask(messages)` from the handler and it streams as it is. Otherwise make the handler an `async function*` and `yield` each value.

```kay
--- server
import { s } from 'kay'
import { complete } from '../data'

export const reply = action(s.Object({ prompt: s.String({ maxLength: 2000 }) }), async function* ({ prompt }) {
  let text = ''

  for await (const piece of complete(prompt))
    yield text += piece
})
---
```

If the handler throws an error carrying `Symbol.for('kay.refused')` as `{ status, retryAfter, message }`, the action answers that status with a `Retry-After` header and the message, in place of a 500. kayjs-ai refuses a visitor over its limit this way, and the action's `messages.rateLimit` can word it.

An island calling it gets a stream once the first value is there. `last()` reads the latest value, `status()` tells whether it is still open, and `close()` stops it.

```kay
---
import type { ActionStream } from 'kay'
import { reply } from '../routes/chat.kay'

const answer = signal<ActionStream<string> | undefined>(undefined)
---
button(onClick={async () => answer.set(await reply({ prompt: 'Hello' }))}) Ask
p {answer()?.last()}
```

Yield the whole text so far, not just the new piece. Then `last()` is all the island needs.

Guards, the schema and rate limits run before the first value, as for any call. A refusal throws an `ActionError`. `reply.pending()` stays true until the stream ends.

`close()` stops the handler's loop on the server. So does the visitor leaving. A stream started while the island sets up, from an event handler or from a `listen` callback closes with the enclosing block or component, so a `persist` island's stays open across pages. For a row playing its leave phase, that is the nearest one still alive.

A block the call's own result removes, such as a button that sends and leaves, hands its stream to the block around it. The block has to go as the call resolves, as in `reply = await ask()`: one removed later by something else closes the stream with it.

A stream started after an `await`, from a timer, or from a handler whose whole owner chain is already gone has no block to close with, so it closes once the visitor goes to another path, not at once.

An effect running again closes the stream it started. One started under no owner, after an `await` in a handler or from a timer, closes when the visitor goes to another path.

A bot caught by a `pretend` protection gets `undefined` back, not a stream, since the handler never ran.

A form posted without JavaScript waits for the end and gets the last value, through `ctx.succeeded(reply)`. In a test, `site.call(reply, input)` gives every value.

## Fixed fields

A button that always posts the same values, such as a row's move-up arrow, needs no hidden inputs. `with` gives the action with its fields fixed. The form carries them without JavaScript too.

```kay
---
import { move } from '../routes/index.kay'

const { id } = props<{ id: number }>()
---
form(action={move.with({ id, to: 2 })})
  button(aria-label="Move up") Up
```

The handler gets `id` and `to` as if the form had posted them, checked by the schema.

The values travel in the form's action URL. A visitor can change them as they could change hidden inputs, so the handler still checks what the visitor may do. They also show in server logs and referrers, so keep secrets out of them.

## Reading one call's outcome

`add.pending()` is true while any call to `add` is running, so a row of buttons calling one action would all spin together.

`add.track()` gives a handle for one component. Its `pending()` reads only the calls made through it. A call resolves with how it went, instead of throwing when the server refuses it.

To wait for writes you did not await, `await add.settled()` resolves once no call to `add` is running, and `removing.settled()` once none made through the handle is. It resolves whichever way the calls went, and never throws. A call whose action redirects stays running while the page goes away, unless a leave guard keeps the visitor on it.

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

Any answer other than success gives `{ ok: false, status, errors, data }`. `errors` is per field, and `data` is typed as the handler passes it to `ctx.fail`. Here `data.message` is what the handler passed to `ctx.fail(409, { message })`.

A success gives `{ ok: true, data }`. A failure with no answer from the server, such as a lost connection, still throws.

In a server fence, `ctx.failed(add)` and `ctx.succeeded(add)` read the same outcome as `add.failed()` and `add.succeeded()` in a template. Each gives `undefined` when there is none.

## File uploads

Use `s.File()` in the schema and `input(type="file" name="avatar")` in the form. The handler receives a `File`, which `files.put` stores.

`s.Files()` takes several files from one field.

A form that posts to an action is sent as `multipart/form-data` unless it sets its own `enctype`. An empty file input counts as no file, so `s.Optional(s.File())` works.

An island passes a `File` or `Blob` anywhere in its input: `await upload({ avatar: input.files[0] })`.

`s.File({ type: 'image/png' })` checks the file's bytes, not its name or the type the browser declared. That holds for a top-level field only. A nested file is checked against the type it declares.

A post carries 1 MB at most. Raise `bodyLimit` in the third argument of `action`. See [File storage](/guides/file-storage).

## A post from another site

An action refuses a post that another site sends, as its `Origin` or `Sec-Fetch-Site` header shows. The answer is a plain-text 403 that says what it saw.

```text
Cross-site action refused: Origin http://localhost:4701 is not this site (http://127.0.0.1:4701; set or fix site in kay.config.ts if a proxy changes the host)
```

The `Origin` must have the host of the request or of `site` in kay.config.ts, whatever the scheme. Open the site by the address it is served on.

Behind a proxy that does not pass the browser's `Host` on, set `site` to the public address. nginx leaves `Host` out unless told `proxy_set_header Host $host`.

An api route refuses the same way, saying `request` where this says `action`.

<ReadMore href="/llms/actions">The other refusal messages, for a `Sec-Fetch-Site` header with no `Origin`.</ReadMore>

## Rate limit, honeypot, minimum time and proof-of-work

The third argument of `action` protects it from scripts.

`rateLimit` answers 429 past `max` posts per `window`. `honeypot` names a hidden field that kay renders for you and bots fill in. `minTime` refuses a form posted sooner than that after its page rendered.

`minTime` checks a form posted without JavaScript, and an island's call carries no stamp. Write `minTime: { after: '3s', plain: true }` to check only the plain post. The page swap and an island's call then go through, which suits a form whose script already proves something, such as a proof of work.

For spam that still gets through, `proofOfWork: true` makes each post cost the sender CPU, with no third-party script. It needs JavaScript in the browser.

```kay
--- server
import { send } from '../mail'
import { schema } from '../schema'

export const contact = action(schema, send, {
  rateLimit: { max: 5, window: '1m' },
  honeypot: 'website',
  minTime: '3s',
  bodyLimit: '5mb',
})
---
```

`minTime` stamps are signed. An app with no `session()` gives the signing key as `secret` in `kay.config.ts`, or as `KAY_SECRET`, at least 32 random characters.

Without one, a production server signs with a key of its own process. A restart changes that key and other replicas do not share it, and the server says so once in its log.

<ReadMore href="/llms/action-protection">Your own proof of work check, shared rate limit stores, refusal messages and body limits.</ReadMore>
