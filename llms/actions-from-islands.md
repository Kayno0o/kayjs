# Calling actions from islands

How an island calls an action it imports from its page, reads its outcome and streams its answer; declaring actions and posting forms are in [Actions](actions.md).

## Common tasks

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
input(bind:value={title} aria-invalid={add.error('title') ? 'true' : undefined})
if add.error('title') as message
  p.error {message}
button(onClick={save} disabled={add.pending()}) Add
```

### Pass an action to a component

A page or layout with a `--- server` fence passes an action it declares or imports to a component prop: `Caller(run={greet})`, or inside an object, `Stream(actions={{ count }})`. A static component posts it with `form(action={run})`, an island calls it as if it had imported it, with streams, `ActionError`, `pending()` and `error()` as above.

Type the prop with `Action` from `kay` (`ServerAction` counts too): `Action<never, unknown>` takes any action, `NoInputAction<unknown>` any declared without a schema, and `Action<{ name: string }, string>` keeps its input and output types (the output is the success one, so a handler that can `ctx.fail` fits: `Action<{ dossier: string }, AsyncGenerator<string>>`). An island's prop must be typed so, which has its chunk carry the code reviving the action: without it the render fails, and `kay check` reports `island-action`. A promoted static component follows it, minus the check. The action crosses as its URL, so it must be an export of a route module, declared in the page or imported. `move.with({ id })` and an action no route exports fail the render: pass the plain action, the fields as input.

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

A handler returning an async iterable streams each value to the island calling it (see [Streaming actions](api-from-islands.md#streaming-actions)):

```kay
---
import type { ActionStream } from 'kay'
import { count } from '../routes/index.kay'

const answer = signal<ActionStream<number> | undefined>(undefined)
---
button(onClick={async () => answer.set(await count({ to: 10 }))}) Count
p {answer()?.last()}
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

## Reference

### Calling from an island

- An island imports the action from the page and calls it, as in [Call an action from an island](#call-an-action-from-an-island): `const id = await add({ title })`.
- Once a call went through, the page shows what it changed, its loads run again as `refresh()` runs them, where the page swap runs: islands whose props did not change keep their state.
- `add({ title }, { refresh: false })` leaves the page as it is, so a frequent write from an island (a vote, an undo) needs no API route to avoid the refresh; `const save = add.track()` then `await save(input, { refresh: false })` also answers a refusal as a result.
- `await add.settled()` resolves once no call to `add` is in flight, whichever way they went (a stream counts until it ends; it never rejects), so an island that fired writes without awaiting them waits for them there; `save.settled()` does the same for the calls made through a `track()` handle.
- `add.pending()` reads, reactively, whether a call the page made is still in flight, and `add.progress()` how much of a call carrying files the browser sent, from 0 to 1: `button(disabled={add.pending()})`.
- `await move({ id, to }, { optimistic: () => tiers.set(moved) })` shows the change at once: if the call fails, or the function throws, each signal the function wrote goes back to what it held, those another optimistic call made inside it wrote included, a `selection` among them with its `is(key)` flags, unless something wrote it since, while that call's `pending()` follows its own request, and the call throws as any does.
- Two such calls over one signal failing out of order may leave the first one's value, so an island lets one move finish before the next, as `add.pending()` tells.
- Once it went through, the refresh brings what the server kept, which a `linked` signal then takes.
- `{ signal }` aborts a call: it rejects with the signal's reason, what `optimistic` showed goes back, and the action records no outcome.
- A call aborted once sent may still have run, so the page refreshes as after one that went through, unless `refresh: false`.
- The call is typed, `ctx.fail` results excluded, and throws `ActionError` from `kay` with `status`, `errors` and `data` when it fails.
- `const save = add.track()` is a handle for one component, row or button: `save.pending()` reads, reactively, only the calls made through it, where `add.pending()` reads every call of the page.
- `await save(input, options)` takes what `add` does and resolves with `{ ok: true, data }` or, for any non-2xx answer of the server, `{ ok: false, status, errors, data }`, `errors` per field and `data` typed as `add.refused` types it, so no `try` or `ActionError` check is needed; a failure with no answer, a network error, an abort or a redirect, still throws, `pending()` clearing either way; an action with no input is called `save()`.
- `add.refused(error)` tells a refusal of a call to `add` from any other error, a redirect's included, and types its `data` as the handler passes it to `ctx.fail`, with no cast: `if (add.refused(error)) shown = error.data?.message`.
- `data` is undefined for a call refused before the handler ran, by the schema or a limit.
- Its input, its result and that `data` cross as island props do, Dates, Maps, Sets and bigints included; a result holding a function or a class instance answers 500, logging where it sits.
- When the handler or a guard redirects, the browser goes there, swapping the page in as a link would, and the call never resolves: `pending()` stays true and `settled()` waits as the page goes away, so nothing awaiting either runs on that page.
- A leave guard keeping the visitor on the page settles the call instead, throwing `ActionRedirect`, so `pending()` clears and `settled()` resolves; a call made on a page the visitor has left since throws it too, taking them nowhere.
- Outside a browser, as in a test, a redirect throws `ActionRedirect` from `kay` with `location`.
- Under a `base`, a redirect to a path of the site goes under it however the action was posted or called, so `ctx.redirect('/dashboard')` lands on `/app/dashboard`, and `location` is the path under the base.

