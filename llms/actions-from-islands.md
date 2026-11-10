# Calling actions from islands

- [Actions](actions.md): declaring an action and posting a form to it.
- [Calling actions from islands](actions-from-islands.md): `pending()`, `track()`, optimistic changes and streaming answers.
- [Protecting actions](action-protection.md): cross-site posts, honeypot, minimum time and proof of work; [Rate limits](rate-limits.md) holds every rate limit.

## Common tasks

### Call an action from an island

An island imports the action from the page and calls it, catching `ActionError` to show the schema's messages:

```kay
---
import { ActionError, signal } from 'kay'
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

### Pass an action to a component

A page or layout with a `--- server` fence passes an action it declares or imports to a component prop: `Caller(run={greet})`, or inside an object, `Stream(actions={{ count }})`. A static component posts it with `form(action={run})`, an island calls it as if it had imported it, with streams, `ActionError`, `pending()` and `error()` as above.

A production build carries the code reviving an action only when the app's own sources call `action(` (or import it as another name) or use a kay library. A page handing an island an action created only in a package outside the app fails with an error naming this; call `action(` in one of the app's files, as `export const greet = action(...)` in a route, to keep it.

Type the prop with `Action` from `kay` (`ServerAction` counts too): `Action<never, unknown>` takes any action, `NoInputAction<unknown>` any declared without a schema, and `Action<{ name: string }, string>` keeps its input and output types (the output is the success one, so a handler that can `ctx.fail` fits: `Action<{ dossier: string }, AsyncGenerator<string>>`). The type is only for the types: an island typing the prop as a plain function, `(input: { name: string }) => Promise<string>`, is handed the action all the same, the code reviving it loading in the browser only for a page that passes an island one, and shipped only by an app that calls `action(` in its own sources or uses a kay library: an action declared by a package outside the app that is no kay library makes the page fail, as above. The action crosses as its URL, so it must be an export of a route module, declared in the page or imported. `move.with({ id })` and an action no route exports fail the render: pass the plain action, the fields as input.

```kay
---
import type { Action, NoInputAction } from 'kay'

const { signOut, run } = props<{ signOut: NoInputAction<unknown>, run: Action<never, unknown> }>()
---
form(action={signOut})
  button Sign out
form(action={run})
  input(name="name" aria-label="Name")
```

An island takes it the same way and calls it:

```kay
--- server
import { greet } from './greet.kay'
--- script
import Caller from '../components/caller.kay'
---
Caller(run={greet})
```

### Stream an answer to an island

An action whose handler is an `async function*`, or returns any async iterable, answers a call with each value as it comes; a model's reply is the main use, and kayjs-ai's `ask(messages)` returned from the handler is one:

```kay
--- server
import { s, action } from 'kay'
import { complete } from '../data'

export const reply = action(s.Object({ prompt: s.String({ maxLength: 2000 }) }), async function* ({ prompt }) {
  let text = ''

  for await (const piece of complete(prompt))
    yield text += piece
})
---
```

A handler returns the iterable as it is, from a plain arrow function: an `async` handler returning one that is also a thenable, such as kayjs-ai's `ask()` reply, awaits it, and the call gets its text alone.

A handler that throws an error carrying `Symbol.for('kay.refused')` as `{ status, retryAfter?, message, errors?, data? }` (`refuse()` throws one) answers that status with `Retry-After` and the message, which the action's `messages.rateLimit` replaces, instead of a 500: how kayjs-ai refuses a visitor over its `rateLimit` or `budget`.

An island reads it from the call's `ActionStream`:

```kay
---
import { signal } from 'kay'
import type { ActionStream } from 'kay'
import { count } from '../routes/index.kay'

const answer = signal<ActionStream<number> | undefined>(undefined)
---
button(onClick={async () => answer = await count({ to: 10 })}) Count
p {answer()?.last()}
```

### Show a change before the server answers

`optimistic` writes the signals at once and puts them back if the call fails:

```kay
---
import { signal } from 'kay'
import { move } from '../routes/board.kay'

const { id } = props<{ id: number }>()
const column = signal('todo')
---
button(onClick={() => move({ id, to: 'done' }, { optimistic: () => column = 'done' })}) Done
p {column()}
```

## Reference

### Calling from an island

- An island imports the action from the page and calls it, as in [Call an action from an island](#call-an-action-from-an-island): `const id = await add({ title })`.
- An `s.Optional` field takes `undefined` as the field left out, `exactOptionalPropertyTypes` or not: `resize({ file, width: max ?? undefined })`. A wrong field is reported at that field, not against the `FormData` form of the call.
- Once a call went through, the page shows what it changed, its loads run again as `refresh()` runs them, where the page swap runs: islands whose props did not change keep their state.
- `add({ title }, { refresh: false })` leaves the page as it is, so a frequent write from an island (a vote, an undo) needs no API route to avoid the refresh; `const save = add.track()` then `await save(input, { refresh: false })` also answers a refusal as a result.
- `await add.settled()` resolves once no call to `add` is in flight, whichever way they went (a stream counts until it ends; it never rejects), so an island that fired writes without awaiting them waits for them there; `save.settled()` does the same for the calls made through a `track()` handle.
- `add.pending()` reads, reactively, whether a call the page made is still in flight, and `add.progress()` how much of a call carrying files the browser sent, from 0 to 1: `button(disabled={add.pending()})`.
- `await move({ id, to }, { optimistic: () => tiers = moved })` shows the change at once: if the call fails, or the function throws, each signal the function wrote goes back to what it held, those another optimistic call made inside it wrote included, a `selection` among them with its `is(key)` flags, unless something wrote it since, while that call's `pending()` follows its own request, and the call throws as any does.
- Calls over one signal each put it back to what it held before them when they fail, whichever order they fail in: a failure found overwritten by a later call still in flight hands that call the earlier value, so it ends where it began if it fails too.
- A call takes `queue: 'parallel' | 'serial' | 'latest'`: `serial` posts a call once the earlier ones of the action settled (a stream counts settled once it started), `latest` aborts the earlier calls still in flight, which reject with an `AbortError` and put their `optimistic` change back, with no `onError`. `add.track({ queue })` gives the handle's own calls that default, ordered apart from the action's, and an abort is no failure of the handle.
- `timeout: '5s'` aborts a post unanswered that long (counted from the post, not from the wait in a queue): the call rejects with a `TimeoutError`, `pending()` clears, `track()` records it as a failure with status 0, and the page refreshes as after an abort once sent.
- `keepalive: true` sends the post with `fetch`'s `keepalive`, so a call made from `pagehide` or `beforeunload` outlives the page: `save(state, { keepalive: true })`. A browser caps a keepalive body at 64 KB, so a JSON body over it is sent as a plain post instead of failing, as is a call carrying files or a form. The cap is shared by every keepalive request of the page in flight, kay's own error reports included, so several large saves at once can still be refused; a page holding a proof-of-work challenge loads its solver first, which an unloading page may not finish.
- `retry: 2` or `retry: { times, delay, when }` posts again after a 503 or a post that failed before it was sent (`delay` defaults to `'500ms'` and doubles; `when(error)` takes an `ApiError` and decides alone for the rest). A timeout, a 504 and a network failure after the send need a `when`, as the handler may have run; a redirect and an abort are never tried again, and a TypeError thrown before the post is no failure of it. Every try sends one `Idempotency-Key` header (32 hex characters, an own `headers` entry wins), read from `ctx.request`, so a handler tells a repeat from a new call.
- `onStart({ input })`, `onSuccess({ data })`, `onError({ error })` (an `ApiError`) and `onSettled({ data, error })` observe a call; none runs `onError` for an abort or a redirect, `onSettled` runs for every ending (an abort's `error` is the abort), `onSuccess` of a stream runs as it starts, `latest` never aborts a stream already started, and a hook that throws or rejects is logged and never fails the call.
- `refresh` also takes a `resource()` or a list of them (anything with a `refresh()`): those are refreshed in place of the page's loads, with or without the page swap.
- `refresh: 'cart'` names a load of the page instead, the binding of a top-level `const cart = await ...` in the page's or a layout's server fence (a destructuring names each of its bindings; a `const total = cart.total * 2` names the load it reads): the page runs as a whole, but only the elements reading that load are sent and swapped, and what shows the others stays as it is. `refresh: ['cart', wishlist]` mixes names and `resource()`s, and `refresh()` from `kay` takes the same names: [rendering](rendering.md#refreshing-some-loads).
- A `form(action={add})` posting in place fires `kay:action-start` on the form (bubbling, `detail: { action, data }` with the fields) before the post, then `kay:action-success` (`detail: { action }`) or `kay:action-error` (`detail: { action, status, errors }`, status 0 and no errors for a failure with no answer) while the form is still on the page, typed on `listen`'s targets. An island shows a change with `listen(() => form, 'kay:action-start', ...)` and `optimistic(change)` from `kay`, which gives `{ undo, keep }`, and calls `undo()` on the error and `keep()` on success.
- Once it went through, the refresh brings what the server kept, which a `linked` signal then takes.
- `{ signal }` aborts a call: it rejects with the signal's reason, what `optimistic` showed goes back, and the action records no outcome.
- `{ headers }` sends extra request headers with the call, which the handler reads from `ctx.request`; the ones kay sets itself win.
- A call aborted once sent may still have run, so the page refreshes as after one that went through, unless `refresh: false`.
- The call is typed, `ctx.fail` results excluded, and throws `ActionError` from `kay` with `status`, `errors` and `data` when it fails, its `message` being the string given to `ctx.fail`, else the form-wide message, the schema's field messages joined, or `data.message`, so `error.message` is what to show; it extends `ApiError`, so one `instanceof ApiError` catches a refused action and a refused `call()`.
- `const save = add.track()` is a handle for one component, row or button: `save.pending()` reads, reactively, only the calls made through it, where `add.pending()` reads every call of the page; `save.status()` (`idle`, `loading`, `ready`, `failed`), `save.error()` (the last failure as an `ApiError`, a call that got no answer included, kept until a call succeeds) and `save.retry()` (repeats the call that failed, with the same arguments as they were, gives no result back, and ignores a redirect) read the same way ([Island sources](island-sources.md)). `add.track({ onSuccess: ({ data, input }) => ..., onError: ({ error, input }) => ... })` takes callbacks for every call of the handle, and the handle has them as methods too (`save.onError(({ error }) => toast.error(error.message))`, returning what stops it): `onSuccess` runs when a call succeeds (for a stream, once it is open), `onError` when it fails, a call that got no answer included, never for an abort or a redirect; `input` is what the call was given ([Island sources](island-sources.md#hooks)). `call.track(module, path, hooks)` takes the same two.
- `await save(input, options)` takes what `add` does and resolves with `{ ok: true, data }` or, for any non-2xx answer of the server, `{ ok: false, status, message, errors, data, error }` (`error` repeats the four), `message` the text to show, `errors` per field and `data` typed as `add.refused` types it, so no `try` or `ActionError` check is needed; a failure with no answer, a network error, an abort or a redirect, still throws, `pending()` clearing either way; an action with no input is called `save()`.
- The same `{ ok, status, message, errors, data }` (an `ErrorShape` when not ok) is what `call.track(module, path)` gives for an API route ([API from islands](api-from-islands.md)), so one result handler serves both.
- `add.refused(error)` tells a refusal of a call to `add` from any other error, a redirect's included, and types its `data` as the handler passes it to `ctx.fail`, with no cast: `if (add.refused(error)) shown = error.data?.message`.
- `data` is undefined for a call refused before the handler ran, by the schema or a limit.
- Its input, its result and that `data` cross as island props do, Dates, Maps, Sets and bigints included; a result holding a function or a class instance answers 500, logging where it sits.
- When the handler or a guard redirects, the browser goes there, swapping the page in as a link would, and the call never resolves: `pending()` stays true and `settled()` waits as the page goes away, so nothing awaiting either runs on that page.
- A leave guard keeping the visitor on the page settles the call instead, throwing `ActionRedirectError`, so `pending()` clears and `settled()` resolves; a call made on a page the visitor has left since throws it too, taking them nowhere.
- Outside a browser, as in a test, a redirect throws `ActionRedirectError` from `kay` with `location`.
- Under a `base`, a redirect to a path of the site goes under it however the action was posted or called, so `ctx.redirect('/dashboard')` lands on `/app/dashboard`, and `location` is the path under the base.

### Streaming actions

- A handler returning an async iterable answers a call from an island with server-sent events: `await reply({ prompt })` resolves once the first value is there with an `ActionStream<T>` from `kay`, typed from what it yields, whose `last()`, `status()`, `onData()` and `close()` read as `stream()`'s do (it is the same `Connection` type); it never reconnects by itself, but `retry()` on one that failed calls the action again with the same input and reads the new answer into the same stream (`pending()` while it is sent, `onOpen({ reconnected: true })` once it opens, `last()` forgotten), and a refused retry fails it again. `await answer.ended()` reads it to its end with no polling: it resolves with the last value once the stream ran to its end (undefined for none), and rejects with an `ActionError` of status 500 when it failed, as a throw before the first value does, or an `AbortError` when it was closed first, which a stream closing with its block or with a visit to another path is, so code awaiting it there catches that. It is a method rather than the stream being awaitable, as `await reply()` would then wait for the end and hand back the value instead of the stream. `Answer<Output>` from `kay` is what a call resolves with for a given output, an `ActionStream` for an iterable, for a library typing a callback that receives it.
- Guards, the schema, `rateLimit`, the cross-site check and the bot protections run before the handler, and what the iterable throws before its first value, a `ctx.redirect`, a `ctx.deny` or an error, answers as the handler's would, the call throwing `ActionError` or redirecting; the cookies it set by then go out with the stream.
- A throw past the first value is logged, `onError` included, and ends the stream `failed`.
- `pending()` stays true until the stream ends; once it ran to its end the page refreshes, unless `refresh: false`, and `succeeded()` reads its last value.
- `close()` stops the handler's iterable, its `finally` running, as does the visitor going away; a stream called from an island's setup, an element's event handler or a `listen` callback closes with the enclosing block or component (the nearest still alive for a row playing its leave phase, or for a block the call's own result removes, as `reply = await ask()` flipping the `if` its button sits in, as long as the block goes in the task the answer arrived in), so a `persist` island's stays open across pages, and an effect running again closes the one it called; a stream called under no owner (after an `await` in a handler, or from a timer, or from a handler of an element whose whole owner chain is already disposed) closes once the visitor goes to another path, not at once. An `effect()` or `onCleanup()` called in a `listen` callback attaches to the island's owner and builds up per event, as in an element's handler, so keep them out of it; the callback is called with no `this`, so a `function` callback reads the target as `event.currentTarget`.
- `rateLimit` with `count: 'succeeded'` counts a stream once its first value is there, and a drained post once its iterable ended.
- A `pretend` bot protection answering an island's `FormData` call resolves `undefined`, not an `ActionStream`, as the handler never ran.
- `on()` added right after the call resolves gets every value, `last()` only the latest: a reply yields the text so far rather than the piece added, so `last()` is all an island reads.
- A plain form post, a page swap's post and an MCP tool call read the iterable to its end and get its last value, as from a handler returning it: `reply.succeeded()?.data`.
