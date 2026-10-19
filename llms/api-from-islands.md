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

A handler returns the iterable as it is, from a plain arrow function: an `async` handler returning one that is also a thenable, such as kayjs-ai's `ask()` reply, awaits it, and the call gets its text alone.

A handler that throws an error carrying `Symbol.for('kay.refused')` as `{ status, retryAfter?, message }` answers that status with `Retry-After` and the message, which the action's `messages.rateLimit` replaces, instead of a 500: how kayjs-ai refuses a visitor over its `limit` or `budget`.

### Keep a value current on every open page

`live(initial)` in a module of the project is a value the server changes and every page reading it follows, with no API module, route or stream written:

```ts
// src/live.ts
import { live } from 'kay'

export const visitors = live(0)
export const room = live((id: string) => ({ id, users: 0 }))
```

```kay
---
import { room, visitors } from '../live'

const { id } = props<{ id: string }>()
---
p {visitors()} online, {room(id).users} in {id}
```

```ts
// an action, a job, a route or a server fence
visitors.set(n => n + 1)
room.set('lobby', { id: 'lobby', users: 3 })
```

- Read by calling it, in a template or an island, as a signal is; `room(id)` reads one key. A component reading one is an island, so a page reading none ships no JS and opens no connection.
- Written with `set` on the server only: a `.set` or `.delete` outside a server fence is a compile error, an assignment too, and in a browser it throws.
- Declare it as `export const name = live(...)` at the top of a module; the build names it from its path, so the server and the browser agree.

### Chat over a websocket

`socket(module, path, options)` opens a websocket route of a module, and `send` takes the route's `body`:

```kay
---
import { socket } from 'kay'
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

On an `api()` chain only, a message failing `body` is dropped, with no reply or `onError` (logged under `kay dev`); a valid one is decoded as an HTTP body is, extra keys stripped.

## Reference

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

### Live values

- `live(initial)` is a `Live<T>`: `value()` reads, `value.set(next | updater)` writes; `live(key => initial)` is `LiveByKey`: `value(key)`, `value.set(key, next)`, `value.delete(key)`. A key is a string, a key nothing was set for reads what the function gives, and `delete` puts it back.
- A value must cross to the browser as island props do (Dates, Maps and Sets included); a function, class instance or other unsendable value throws where it is set, naming the constant and its id. A `set` to the value it holds sends nothing.
- A page's HTML holds the values it read, so an island hydrates with them and follows from there. One connection per page, `POST /_kay/live` (under `base`), carries every live value the page's islands read, and none opens when they read none; a swap to another page keeps it, moving it to the keys the new page reads, and closes it when none is read. Changes of one tick are sent as one event.
- A hidden tab closes the live-values connection and stops renewing its proof, and a tab shown again opens one that starts with every watched value as it is then; a page loaded in a hidden tab connects when it is shown. The connections of `socket()` and `stream()` are the app's and stay open.
- The server sends a value only to a request holding the signed proof of a page that read that key of it, so whoever can render the page can follow exactly what it read and a guard on the page covers it; whatever a render reads, its server fence included, goes into the page. Per-user scoping is not in v1: a value is the same for everyone who can render it.
- A page with a server fence, a layout and a special page render once and are no islands: reading a live value in their template is an error, so read it in a component. The fence may read and write it.
- A page reading a live value is rendered per request: `kay build` skips keeping it, and `prerender` or a static export of it fails with `export-server-render`.
- Limits: values live in the memory of one process, so several processes do not share them (no pub/sub adapter yet); keyed entries stay until `delete`; a proof lasts an hour, signed with `KAY_SECRET` or a key made at start-up; an open page asks for its own page again every half hour, and at once when a proof is refused with a 403 (a restart without `KAY_SECRET`), taking the fresh proofs; that renders the page again, so a server fence with side effects runs again, and a page that no longer holds a live value (a visitor who may not see it) is asked again only every five minutes; so one who may no longer see the page stops following within the hour; a dropped or refused connection (429, 5xx) is retried with a growing delay, not while the tab is hidden; one client, by `clientAddress()`, holds at most 20 live connections and opens 120 a minute, which `live: { connections, perMinute }` in kay.config.ts changes, so behind a reverse proxy set `proxy` in kay.config.ts or every visitor shares one address and one cap; a live value an island imports is proven by every page rendering the island (a `--- client` island included), so one read behind a click or in the browser only is followed; a keyed value read only after the render is not, as its key is not known before, so read it in the template.

### Following cached values

- `cached(key, ttl, load, { live: true })` makes every page that read the key in its render follow it: once `invalidate` drops the key, or a key its `load` read (a collection, another `cached`), each open tab shows the page as its loads give it now, with no island, route or socket written. Read it in the page's or a layout's server fence; a read after the document went out (an `await` block's) or in an API route is not followed.
- The server pushes no value, only that the key changed: the tab runs `refresh()`, so the page is rendered again for that visitor, and a guard, a per-visitor branch, the locale and `base` apply as for any visit. A `persist` island is given the new props and keeps its state; any other island whose props changed hydrates afresh, as after an action.
- The page carries its `data-kay-live` script with `[kay:cache, key, readAt]` per followed key, covered by the same signed proof, and the entry script loads the `live-cache` chunk only then. `POST /_kay/live` first sends the time each key was last invalidated (0 when never), then one event per invalidation, as often as it happens; a tab refreshes when that time is at or after its page's read, both from the server's clock, so an invalidation between render and connect, or during a dropped connection, is not missed. A page reading no such key opens no connection and loads no code for it.
- A refresh waits a random 0 to 750 ms so tabs do not render together, waits while the tab is hidden and runs once it is shown, and one in flight absorbs the events meanwhile. A dropped connection reconnects with a growing delay, not while the tab is hidden; a 403 (a proof an hour old, a restart without `KAY_SECRET`, or any followed key whose proof is out of date) refreshes the page and every followed route for new ones. With `navigation: false` the page reloads instead, unless a `guardLeave` holds changes.
- Several processes sharing a `sqliteCache` follow each other's `invalidate` (heard within about half a second); with no shared store a process hears its own only. A key expiring by `ttl` refreshes in the background without telling tabs: only `invalidate` pushes.
- The connection is the one route live values use but a reader of its own, so a page with both holds two connections of the client's cap. A key is at most 256 characters and a page follows at most 100 keys (a `RangeError` where `cached` is called). A page reading such a key is rendered per request, like one reading a live value: `kay build` keeps no file of it and a static export fails with `export-server-render`.
- A `resource(module, path)` follows the same keys with nothing written: a GET route whose handler reads a `cached(..., { live: true })` key answers with the header `x-kay-live`, the signed proof of the keys it read, and the `resource()` asks the route again after an `invalidate` of one, keeping `value()` and without turning `status()` to `loading`. A route that read no such key sends no header and its resource opens nothing. Only the answer of a handler that returned (not a thrown error, a `status()` refusal or a guard's) carries a proof, so a visitor gets the keys their own request read; a route follows keys up to about 4,000 bytes together, each counting its URL-encoded length and 50 bytes more, as the proof travels in a header (a `RangeError` where `cached` is called); the answer of a `status(201, ...)` or a `Response` of the route's own carries it too; a status set by name (`'Bad Request'`) counts as its code; the quiet refetch skips the browser's cache and, if it fails, keeps `value()` and `status()`, so a route failing for good (a 404 after its row was deleted) still shows the old value. `call()`, `stream()` and the function form of `resource()` do not follow.
- A collection with `live: true` ([content](content.md)) is followed the same way by a page that reads it directly, with no `cached` around it: its key is `kay:content:<name>`, which `posts.invalidate()` and a CMS save drop.
- Presence (who else views a page) does not follow yet.

Rooms of connections, with their state, are in [Rooms](rooms.md).
