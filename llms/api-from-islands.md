# Calling API routes from islands, event streams, live values and websockets

## Common tasks

### Read a route's answer in an island

`resource(module, path, options)` reads a GET route, reactively when its options are a function:

```kay
---
import { resource } from 'kay'
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
import { call, ApiError } from 'kay'
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

### Stream an action's answer

An action whose handler is an `async function*`, or returns any async iterable, answers a call with each value as it comes; a model's reply is the main use, and kayjs-ai's `ask(messages)` returned from the handler is one:

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

A handler returns the iterable as it is, from a plain arrow function: an `async` handler returning one that is also a thenable, such as kayjs-ai's `ask()` reply, awaits it, and the call gets its text alone (`async-reply` reports it; return the reply's `.stream()` after an `await`).

A handler that throws an error carrying `Symbol.for('kay.refused')` as `{ status, retryAfter?, message }` answers that status with `Retry-After` and the message, which the action's `messages.rateLimit` replaces, instead of a 500: how kayjs-ai refuses a visitor over its `limit` or `budget`.

## Reference

- Live values, following cached values and presence are in [Live values, cached values and presence](live-values.md).

### Calling modules from an island

An island imports a module for its routes:

```kay
---
import { socket, stream } from 'kay'
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
- `send` takes the route's `body`, `last()` reads the last message reactively, typed from its `response`, `on(listener)` gets each one and returns what stops it, and `status()` is `connecting`, `open` or `closed`.
- Messages travel as Elysia sends them, as JSON.
- A route sending through `rooms()` takes `response: chats.response` to type `last()` and `on()` as the rooms' `Message` ([Rooms](rooms.md)); without a `response` they are `unknown`, which `kay check` reports on a route with a `body` (`untyped-socket`).
- What is sent before the connection opens goes once it does, the last 100 messages kept while it is down; after `close()` nothing is.
- A connection that drops reconnects, waiting longer each time up to 30 seconds, less up to half of that at random so the clients a restart dropped come back apart, and not while the tab is hidden or offline, unless the server closed it with code 1000; a visible tab the browser calls offline still tries each minute, as `navigator.onLine` can be wrong, and the clients a network coming back wakes together reconnect up to half a second apart.
- `close()` closes it for good.
- `onOpen(listener)` is called each time the connection opens, a reconnect included, before what was queued goes.
- A client joining rooms by message joins them there, `messages.onOpen(() => messages.send({ type: 'join', room }))`, so it is back in them after a drop.
- `stream(module, path, options)` reads one of its routes answering with `eventStream()`, with `last()`, `on()` and `status()` the same way.
- Its `status()` is `done` once the stream ran to its end and `failed` when a guard or the route refused it or its source threw.
- `{ method: 'post', body }` reads a route taking a body, such as an AI answer.
- A GET stream that drops reconnects; any other ends as failed.
- `stream(module, path, { start: false })` stays `idle` until a handler calls `start(options)`, typed by the route.
- Each start opens a run with those params, query and body, which may hold a `File` or be a `FormData`, closing the one going and forgetting its `last()`.
- `close()` aborts the request, which stops the route's source; a later `start()` opens it again.
- `resource(module, path, options)` from `kay` reads one of its GET routes answering a value, typed from the route's `response` as JSON leaves it, a Date as its ISO text.
- `value()` is the last answer, kept while the route is asked again, `status()` is `loading`, `ready` or `failed`, `error()` gives the `status` and `message` a route refused with, status 0 when no answer came, and `refresh()` asks again.
- Options given as a function, `() => ({ query: { prefix: search() } })`, are read reactively: a signal they read changing asks the route again, and an answer a newer request overtook is dropped.
- `resource(load)` reads anything else the same way, such as a WebSocket call or a `fetch` to another server: `load(signal)` returns a value or a promise, the signals it reads before its first await are tracked so it runs again when one changes, `signal` aborts when a newer run supersedes it or the component is gone, and a throw is `error()` with status 0 unless it is an `ApiError`.
- `stream(source)` reads an async iterable, `source(signal)` returning it, with `last()`, `on()`, `status()` and `close()`: `done` once it ends, `failed` when it throws, and it opens once the island is in the page, and `source` stops on its `signal`.
- `call(module, path, options)` from `kay` calls any of its routes over HTTP from an event handler, or any code running in the browser, a module several islands share included: `await call(notes, '/', { method: 'post', body: { title } })`.
- `method` is GET unless named, and named where the path answers no GET.
- `params`, `query` and `body` are typed from the route, and the answer as `resource()` reads it, a number or a boolean arriving as the text Elysia sends and nothing as `''`.
- A param is encoded as one path segment, each segment of a `*` too, and an empty param or a param or a `*` segment that is `.` or `..` is refused with a `TypeError` (thrown by `call()`, by `stream()` and `socket()` at the call or at `start()`, and failing the request of `resource()`), as it would reach the collection or the parent route. A `*` may be empty. Pass a `*` value decoded.
- A file or a `Blob` the route answers arrives as a `Blob`, or as text when its type is text, and a `Response` it builds is typed `unknown`, read as JSON, text or a `Blob` by its content type.
- A refusal throws `ApiError` from `kay` with `status`, `message` and `answer`, its text when its JSON does not parse, `HTTP 503` when it says nothing; status 0 when no answer came or it was cut off.
- `refusalMessage(error, fallback)` from `kay` is the text to show for a caught error: an `ApiError`'s `message` when the route answered, else `fallback` (status 0, whose message is the browser's, or an error that is no `ApiError`), so no `instanceof ApiError` check is needed: `error.set(refusalMessage(e, 'Sync failed.'))`.
- A frequent write that should not refresh the page can be an action called with `{ refresh: false }` rather than a route, see [Calling from an island](actions-from-islands.md#calling-from-an-island).
- `signal` aborts the call, which rejects with the signal's reason, while the answer is read too.
- A body holding a `File` or a `Blob`, or a `FormData`, goes as a multipart form, its other fields as text, a Date as its ISO text, an object as JSON and null left out, as in a `query`.
- `progress: sent => ...` gets how much of it went, from 0 to 1.
- `socket`, `stream` and `resource` open once the island is in the page, never on the server, where `resource()` renders `loading`, and close with the component that opened them.
- The browser build gives the island the module's mount and none of its code, so its other exports never reach the browser.
- An island importing any other file under `src/api/`, such as a `_schemas.ts`, fails the build: code an island shares with a module lives outside it.
- A refused upgrade looks like a dropped connection to the browser, so a socket a guard refuses keeps retrying, `connecting`, every 30 seconds at most.

### Event streams

- `eventStream(source)` answers with server-sent events, one per value an async iterable, a generator or an array gives, crossing as island props do, Dates, Maps and Sets included.
- The source is read once the browser reads the response and stopped when it goes away.
- A source that throws ends the stream as failed, the error logged and handed to `onError`.
- A comment line every 5 seconds keeps a quiet stream open past Bun's `idleTimeout` and a proxy's.

### Streaming actions

- A handler returning an async iterable answers a call from an island with server-sent events: `await reply({ prompt })` resolves once the first value is there with an `ActionStream<T>` from `kay`, typed from what it yields, whose `last()`, `status()`, `on()` and `close()` read as `stream()`'s do; it never reconnects. `Answer<Output>` from `kay` is what a call resolves with for a given output, an `ActionStream` for an iterable, for a library typing a callback that receives it.
- Guards, the schema, `rateLimit`, the cross-site check and the bot protections run before the handler, and what the iterable throws before its first value, a `ctx.redirect`, a `ctx.deny` or an error, answers as the handler's would, the call throwing `ActionError` or redirecting; the cookies it set by then go out with the stream.
- A throw past the first value is logged, `onError` included, and ends the stream `failed`.
- `pending()` stays true until the stream ends; once it ran to its end the page refreshes, unless `refresh: false`, and `succeeded()` reads its last value.
- `close()` stops the handler's iterable, its `finally` running, as does the visitor going away; a stream called from an island's setup, an element's event handler or a `listen` callback closes with the enclosing block or component (the nearest still alive for a row playing its leave phase, or for a block the call's own result removes, as `reply = await ask()` flipping the `if` its button sits in, as long as the block goes in the task the answer arrived in), so a `persist` island's stays open across pages, and an effect running again closes the one it called; a stream called under no owner (after an `await` in a handler, or from a timer, or from a handler of an element whose whole owner chain is already disposed) closes once the visitor goes to another path, not at once. An `effect()` or `onCleanup()` called in a `listen` callback attaches to the island's owner and builds up per event, as in an element's handler, so keep them out of it; the callback is called with no `this`, so a `function` callback reads the target as `event.currentTarget`.
- `rateLimit` with `count: 'succeeded'` counts a stream once its first value is there, and a drained post once its iterable ended.
- A `pretend` bot protection answering an island's `FormData` call resolves `undefined`, not an `ActionStream`, as the handler never ran.
- `on()` added right after the call resolves gets every value, `last()` only the latest: a reply yields the text so far rather than the piece added, so `last()` is all an island reads.
- A plain form post, a page swap's post and an MCP tool call read the iterable to its end and get its last value, as from a handler returning it: `ctx.succeeded(reply)?.data`.

