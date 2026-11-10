# Calling API routes from islands, event streams, live values and websockets

## Common tasks

### Read a route's answer in an island

`resource(module, path, options)` reads a GET route, reactively when its options are a function:

```kay
---
import { resource, signal } from 'kay'
import rooms from '../api/chat'

const search = signal('')
const list = resource(rooms, '/rooms', () => ({ query: { prefix: search() } }))
---
input(bind:value={search} aria-label="Search")
p {list.status()}
```

### Call a route from an event handler

`call(module, path, options)` calls any route over HTTP, and a refusal throws `ApiError`:

```kay
---
import { call, ApiError, signal } from 'kay'
import notes from '../api/notes'

const title = signal('')
---
input(bind:value={title} aria-label="Title")
button(onClick={async () => {
  try {
    await call(notes, '/', { method: 'post', body: { title: title() } })
  } catch (error) {
    if (error instanceof ApiError) console.error(error.status, error.message)
  }
}}) Add
```

### Stream server-sent events

`eventStream(source)` answers with one event per value an async iterable, a generator or an array gives:

```ts
import { s } from 'kay'
import { api, eventStream } from 'kay/server'
import { complete } from '../data'

export default api()
  .post(
    '/answer',
    ({ body }) => eventStream(complete(body.prompt)),
    { body: s.Object({ prompt: s.String() }) },
  )
```

A source blocked on a quiet feed is freed by a signal: pass a function, `eventStream(signal => watch(signal))`, and its `signal` aborts when the visitor leaves, to hand to what the source waits on. An action's handler reads the same from `ctx.request.signal`.

#### Resume after a drop

`eventStream(source, { id })` sends `id(value)` with each event. `stream()` keeps the id of the last event it took and sends it as `Last-Event-ID` when it reconnects, after a drop or a 502, 503 or 504 while the server restarts (any other refusal, a 401 or 404, ends the stream as failed), so the route continues after it:

```ts
import { api, eventStream, lastEventId } from 'kay/server'

const DIGITS = /^\d{1,15}$/

export default api().get('/feed', ({ request }) => {
  const sent = lastEventId(request)
  const after = sent !== undefined && DIGITS.test(sent) ? Number(sent) : 0

  return eventStream(signal => feedSince(after, signal), { id: item => item.seq })
})
```

- `lastEventId(request)` gives the header only when it is printable ASCII with no space at either end and at most 1 KB, else `undefined`. It is still the browser's text: parse it strictly, as above, and start from the beginning when it is missing or names nothing the route keeps.
- An id that is not printable ASCII, has a space at either end or exceeds 1 KB fails the stream, as the browser would not send it back.
- A route with no `id` sends none, and `stream()` reconnects as before. A new `start()` of a `start: false` stream forgets the id.
- Ids do not survive a page swap or a reload: a new mount starts with no id, so the route sends from the beginning.
- To catch up without ids, `feed.onOpen(({ reconnected }) => reconnected && refetch())` runs on every open after the first.

### Stream an action's answer

An action whose handler is an `async function*` streams its answer to the island calling it: [Stream an answer to an island](actions-from-islands.md#stream-an-answer-to-an-island).

## Reference

- Live values, following cached values and presence are in [Live values, cached values and presence](live-values.md).

### Calling modules from an island

An island imports a module for its routes:

```kay
---
import { socket, stream, signal } from 'kay'
import chat from '../api/chat'

const { room } = props<{ room: string }>()
const messages = socket(chat, '/:room', { params: { room } })
const text = signal('')
---
p {messages.status()}
p {messages.last()?.text}
input(bind:value={text})
button(onClick={() => messages.send({ text: text() })}) Send
```

- `socket(module, path, options)` opens one of the module's websocket routes, the path written as the module writes it, `params` and `query` filling it in, all typed from the route.
- `send` takes the route's `body`, `last()` reads the last message reactively, typed from its `response`, `onData(({ value }) => ...)` gets each one and returns what stops it, and `status()` is `connecting`, `open`, `failed` or `closed`: a server closing with a code from 4000 to 4999 (`ws.close(4403, 'Not yours')`) fails it, `error()` an `ApiError` with the code minus 4000 as `status` (403; 4000 gives 0, 4001 to 4099 give a status below 100, so refuse with 4400 and up) and the reason as `message`, and it does not reconnect.
- Messages travel as Elysia sends them, as JSON.
- A route sending through `rooms()` takes `response: chats.response` to type `last()` and `onData()` as the rooms' `Message` ([Rooms](rooms.md)); without a `response` they are `unknown`, which `kay check` reports on a route with a `body` (`untyped-socket`).
- What is sent before the connection opens goes once it does, the last 50 messages kept while it is down; after `close()` nothing is.
- A connection that drops reconnects, waiting longer each time up to 30 seconds, less up to half of that at random so the clients a restart dropped come back apart, and not while the tab is hidden or offline, unless the server closed it with code 1000; a visible tab the browser calls offline still tries each minute, as `navigator.onLine` can be wrong, and the clients a network coming back wakes together reconnect up to half a second apart.
- `close()` closes it for good.
- `onOpen(listener)` is called each time the connection opens, a reconnect included, before what was queued goes; it is told `{ reconnected }`, true after the first open, so `onOpen(({ reconnected }) => reconnected && refetch())` catches up on what the drop lost. `stream()` has the same `onOpen`.
- A client joining rooms by message joins them there, `messages.onOpen(() => messages.send({ type: 'join', room }))`, so it is back in them after a drop.
- Hooks: a socket, a stream (a route or an iterable) and a streaming action's answer take `onOpen`, `onData`, `onError` and `onClose` as methods, and `socket(module, path, options)` and `stream(...)` take the same four as options (`stream(source, hooks)` for an iterable): `socket(chat, '/:room', { params, onData: ({ value }) => add(value), onError: ({ error }) => toast.error(error.message) })`. What each means is in [Island sources](island-sources.md#hooks). `onClose({ status: 'closed' })` also runs when the component ends and closes the source, even one that never started; the answer of a streaming action is open before a listener can attach, so its `onOpen` runs only after a `retry()`.
- `stream(module, path, options)` reads one of its routes answering with `eventStream()`, with `last()`, `onData(({ value }) => ...)` (which returns what stops it) and `status()` the same way. A stream and the stream a streaming action answers with are both a `Connection` from `kay`, and `stream()` gives a `Stream`, a `Connection` with `start()`.
- `await feed.ended()` resolves with the last value once the stream ran to its end (undefined for none) and rejects with the `ApiError` it failed with, or an `AbortError` when `close()` came first.
- Its `status()` is `done` once the stream ran to its end and `failed` when a guard or the route refused it or its source threw, `error()` then an `ApiError` with the refusal's `status`, `message` and `data`.
- Every source an island reads, `resource`, `stream`, `socket`, `track()` and `call.track` here, shares `status()`, `pending()`, `error()` and `retry()`, and the same hooks; [Island sources](island-sources.md) describes that shape once, with each source's statuses and hooks.
- `{ method: 'post', body }` reads a route taking a body, such as an AI answer.
- A GET stream that drops reconnects; any other ends as failed.
- `stream()` sends `Last-Event-ID` when it reconnects to a route whose `eventStream(source, { id })` gave ids, and has `onOpen(listener)` as `socket()` does ([resume after a drop](#resume-after-a-drop)); it takes the hooks of a socket as options too.
- `stream(module, path, { start: false })` stays `idle` until a handler calls `start(options)`, typed by the route; every stream has `start()`, which a stream that starts by itself ignores unless it is given options.
- Each start opens a run with those params, query and body, which may hold a `File` or be a `FormData`, closing the one going and forgetting its `last()`.
- `close()` aborts the request, which stops the route's source; a later `start()` opens it again.
- `resource(module, path, options)` from `kay` reads one of its GET routes answering a value, typed from the route's `response` as JSON leaves it, a Date as its ISO text.
- `onData({ value })` and `onError({ error })` are options of a resource and methods of it: `onData` runs each time the route answers, a quiet reload and `mutate()` included, not for `initial` or the value the server rendered, nor when a changed key joins a value another resource already holds, and `onError` each time a request fails, not for a quiet reload that keeps the value it has; a hook that throws is logged.
- `value()` is the last answer, kept while the route is asked again, `status()` is `loading`, `ready` or `failed`, `error()` is the `ApiError` a route refused with, status 0 when no answer came, `refresh()` asks again even when ready, `retry()` only after a failure, and `pending()` also reads a quiet reload that keeps `ready`.
- Options given as a function, `() => ({ query: { prefix: search() } })`, are read reactively: a signal they read changing asks the route again, and an answer a newer request overtook is dropped.
- The server renders the island with the route's answer: it asks the route in process as the visitor (their cookies and headers, so the route's guards run), and the island is `ready` in the HTML and hydrates `ready` without a request. A route that refuses, throws or takes over 5 seconds leaves the island `loading` for the browser to ask, with nothing of the refusal in the page. A page that reads a cookie or an `Authorization` header with a `resource()` is not shared by a cache. A route answering `cache-control: private`/`no-store` or a `set-cookie`, or an answer over 64 KB as JSON (`SEED_LIMIT`), is not seeded and stays `loading`. `seed: false` keeps the server from asking a route at all (`loading`, the browser asks), for one whose read has an effect of its own, such as admitting an editor to a room; every resource of that route or key on the page needs it, and it applies to routes only, read from the first options. A prerendered page and a server island render `loading` as before (give a server island's resources their own `key`); an `await` block reads the page's seeds. Finding the routes takes a discarded first render, so an `await` expression runs once per render (three at most) on a page with a `resource()`.
- `resource()` reading one route and arguments share one request and one value; `key: 'rooms'` names another, so routes with the same key share. `initial: value` is a value the app already has, shown `ready` on the server and in the browser with no request until `refresh()` (a `load` function runs once, quietly, to follow its signals). `revalidate: 'focus' | 'reconnect' | '30s'` (or an array) asks again quietly, the value and `ready` kept, and stops with the component.
- `list.mutate(value)` (or `mutate(current => next)`) sets the value for every resource sharing the key and asks the route again to settle it, dropping a request still in flight so an older answer never overwrites it; `mutate(value, { refresh: false })` keeps the value as set.
- `resource(load)` reads anything else the same way, such as a WebSocket call or a `fetch` to another server: `load(signal)` returns a value or a promise, the signals it reads before its first await are tracked so it runs again when one changes, `signal` aborts when a newer run supersedes it or the component is gone, and a throw is `error()` with status 0 unless it is an `ApiError`.
- `stream(source)` reads an async iterable, `source(signal)` returning it, with `last()`, `onData()`, `status()` and `close()`: `done` once it ends, `failed` when it throws, and it opens once the island is in the page, and `source` stops on its `signal`.
- `call(module, path, options)` from `kay` calls any of its routes over HTTP from an event handler, or any code running in the browser, a module several islands share included: `await call(notes, '/', { method: 'post', body: { title } })`.
- `method` is GET unless named, and named where the path answers no GET.
- `params`, `query` and `body` are typed from the route, and the answer as `resource()` reads it, a number or a boolean arriving as the text Elysia sends, `null` as `null` and nothing (`undefined`, a 204) as `''`, so `run !== null` is a check the type allows.
- A param is encoded as one path segment, each segment of a `*` too, and an empty param or a param or a `*` segment that is `.` or `..` is refused with a `TypeError` (thrown by `call()`, by `stream()` and `socket()` at the call or at `start()`, and failing the request of `resource()`), as it would reach the collection or the parent route. A `*` may be empty. Pass a `*` value decoded.
- A file or a `Blob` the route answers arrives as a `Blob`, or as text when its type is text, and a `Response` it builds is typed `unknown`, read as JSON, text or a `Blob` by its content type.
- A refusal throws `ApiError` from `kay` with `status`, `message`, `errors` and `data`: `data` is the answer, its text when its JSON does not parse, and `message` reads, in this order, `errors['']`, the field messages joined, `data.message`, the text the route answered, its status text, `HTTP 503` when it says nothing. `errors` is the message per field a refused route answers in `{ errors, status }`, else the message under `''`. Status 0 (no answer came or it was cut off) has the message `The server could not be reached` and the browser's own error as `cause`, so `error.message` is always safe to show. `answer` is the old name of `data` (and, on an `ActionError`, of `body`). `ErrorShape<Data>` from `kay` is these four fields, `{ status, message, errors, data }`, as every failure reads them: the `ApiError` itself, a `track()` result that is not ok, a `FormFailure` and a `LocalIssue` all satisfy it.
- `const save = call.track(notes, '/')` is a handle for one route, as an action's `track()` is for an action: `await save({ method: 'post', body })` resolves `{ ok: true, data }` or, for any refusal, `{ ok: false, status, message, errors, data, error }` (`error` repeats the four) with no `try`, and `save.pending()`, `save.status()` (`idle` before the first call), `save.error()`, `save.retry()` and `save.settled()` read only its own calls. `data` is the answer the route refused with and `errors` a message per field, read from the route's `{ errors }` answer (`errors.title`), else the refusal's message under `''`; a call with no answer (status 0) or aborted still throws. `call.track(notes, '/', { onSuccess, onError })` and `save.onSuccess(fn)` / `save.onError(fn)` take the callbacks of an action's `track()`, with `input` the options the call was given ([the action form](actions-from-islands.md)).
- An `ApiError`'s `message` is always the text to show, an `ActionError` included, so write `error = e instanceof ApiError ? e.message : 'Sync failed.'`.
- A frequent write that should not refresh the page can be an action called with `{ refresh: false }` rather than a route, see [Calling from an island](actions-from-islands.md#calling-from-an-island).
- `signal` aborts the call, which rejects with the signal's reason, while the answer is read too.
- A body holding a `File` or a `Blob`, or a `FormData`, goes as a multipart form, its other fields as text, a Date as its ISO text, an object as JSON and null left out, as in a `query`.
- `progress: sent => ...` gets how much of it went, from 0 to 1.
- `socket` and `stream` open once the island is in the page, never on the server, and a `resource` asks the browser once it has no server value; all close with the component that opened them.
- The browser build gives the island the module's mount and none of its code, so its other exports never reach the browser.
- An island importing any other file under `src/api/`, such as a `_schemas.ts`, fails the build: code an island shares with a module lives outside it.
- A refused upgrade looks like a dropped connection to the browser, so a socket a guard refuses keeps retrying, `connecting`, every 30 seconds at most.

### Refused input

- A route whose `body`, `query`, `params`, `headers` or `cookie` refuses a request answers 422 `{ errors, status }` as an action does: a message per field, the schema's own `error` else the `kay.invalid.*` text, in the request's locale, unlogged. A Standard Schema validator names the field by the first segment of its path and speaks with its own message; a file of the wrong type answers `kay.action.invalidFile`. The OpenAPI document lists that 422.
- A module's own `onError` that answers it comes first.

### Event streams

- `eventStream(source)` answers with server-sent events, one per value an async iterable, a generator or an array gives, crossing as island props do, Dates, Maps and Sets included.
- The source is read once the browser reads the response and stopped when it goes away.
- A source that throws ends the stream as failed, the error logged and handed to `onError`.
- A comment line every 5 seconds keeps a quiet stream open past Bun's `idleTimeout` and a proxy's.
