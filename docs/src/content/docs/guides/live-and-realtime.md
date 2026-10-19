---
title: Live data and realtime
order: 6.5
description: Keep pages current with live values, read routes in islands, and push with server-sent events, websockets and rooms.
---

A page can follow the server as things change. Declare a `live()` value, read it in a template, and every open page shows the latest number.

```ts
// src/live.ts
import { live } from 'kay'

export const visitors = live(0)
```

```kay
---
import { visitors } from '../live'
---
p {visitors()} online
```

## Values the server changes

Write a live value on the server, from an action, a job, a route or a page's server fence. Every open page that reads it updates. You write no API module, route or stream.

```ts
visitors.set(n => n + 1)
```

You read a live value by calling it, as you read a signal. A browser only reads: writing one in a template or a script is a compile error, and `kay check` types the reads and the writes.

Declare each one as `export const name = live(...)` at the top of a module. The build names it from its path, so the server and the browser agree.

A component that reads a live value is an island. A page that reads none ships no JavaScript and opens no connection. A page that reads some opens one connection, however many it reads, and its HTML already holds the values, so nothing flashes while it loads.

### Values per key

Give `live()` a function to get one value per key, a string. Read one with `room(id)`, write it with `room.set(id, value)`, and put it back to what the function gives with `room.delete(id)`.

```ts
export const room = live((id: string) => ({ id, users: 0 }))

room.set('lobby', { id: 'lobby', users: 3 })
```

```kay
---
import { room } from '../live'

const { id } = props<{ id: string }>()
---
p {room(id).users} in {id}
```

A key you set stays until you delete it. Read a keyed value in the template, not only after the page rendered, as the server cannot know the key before.

### Limits

A live value is the same for everyone who can render the page. There is no value per user. The server sends it only to a request holding the signed proof of a page that read it, so a guard on the page covers it.

Whatever a page reads while it renders goes into its HTML. Read only what everyone who sees the page may see.

Values live in the memory of one process. Several processes do not share them, and there is no pub/sub adapter yet.

A page with a server fence, a layout and the special pages render once and are not islands, so reading a live value in their template is an error. Read it in a component they render. Their server fence may read and write it.

A page reading a live value is rendered for each request. `kay build` does not keep it, and a static export of it fails.

A client holds at most 20 live connections, a few tabs, and opens at most 120 a minute. The next one is refused until another closes. `live: { connections: 50, perMinute: 240 }` in kay.config.ts changes both. A client is its address, so behind a reverse proxy set `proxy` in kay.config.ts, or every visitor shares one address and one cap. See [Deployment](/guides/security#trust-a-proxy).

<ReadMore href="/llms/api-from-islands#live-values">Proof lifetimes and renewal, reconnect delays, how an island's imports are followed and the exact limits are in the full API routes reference.</ReadMore>

### Data from the cache

Data you load with `cached` can follow too. Add `live: true`, and every open page that read it shows it again after an `invalidate`.

```kay
--- server
import { cached } from 'kay/cache'
import { listOrders } from '../data'

const orders = await cached('orders', '1m', listOrders, { live: true })
---
OrderList(orders={orders})
```

```ts
import { invalidate } from 'kay/cache'

invalidate('orders')
```

You write no route, socket or island code. The server only tells each tab that `orders` changed. The tab then loads the page again, as `refresh()` does, so each visitor gets what they may see, and the page keeps its scroll, its focus and every island whose props did not change. Give an island `persist` to keep its state while its props change.

A tab you cannot see waits and loads the page when you come back. An `invalidate` made while the connection was down is not lost: the tab catches up when it reconnects. Processes sharing a `sqliteCache` follow each other's `invalidate`.

Read the value in the page's server fence or a layout's. A page that follows a value is rendered for each request, so a static export of it fails. A value that only expires by its `ttl` is not pushed: call `invalidate` when it changes.

A collection follows when you add `live: true` to it. See [Showing edits in open tabs](/guides/content#showing-edits-in-open-tabs). A page that reads the collection then shows an edit in every open tab, a CMS save included.

A `resource` follows too. If the route's handler reads a `cached` value with `live: true`, the island asks the route again after an `invalidate`, keeping the old value on screen until the new answer arrives. If that quiet request fails, the old value stays, so a route that now fails for good, such as a 404 after its row was deleted, keeps showing what it showed. You add nothing to the route or the island, and a route that reads no such value opens no connection.

<ReadMore href="/llms/api-from-islands#following-cached-values">The proof, the first event after a reconnect, refresh timing and the limits are in the full API routes reference.</ReadMore>

## Reading a route in an island

An island imports an API module and reads its GET routes with `resource`. The route's types carry over, and only the mount reaches the browser, never the module's code.

```kay
---
import { resource } from 'kay'
import notes from '../api/notes'

const search = signal('')
const list = resource(notes, '/', () => ({ query: { prefix: search() } }))
---
input(bind:value={search})
if list.status() === 'loading'
  p Loading
ul
  for note of list.value() ?? [] key={note.text}
    li {note.text}
```

Options given as a function are reactive. When `search` changes, the route is asked again. Call `refresh()` to ask again by hand.

A resource opens once the island is in the page, never on the server. There it renders as `loading`.

To send data, call a route from an event handler. See [API routes](/guides/api-routes#calling-a-route-from-an-event-handler).

### Reading anything else

Give `resource` a function to read something that is not one of your routes, such as a `fetch` to another server. It has the same `value()`, `status()`, `error()` and `refresh()`.

```kay
---
import { resource } from 'kay'

const { url } = props<{ url: string }>()
const data = resource(async signal => (await fetch(url, { signal })).json())
---
p {data.status()}
```

A signal the function reads before its first `await` runs it again when it changes. The `signal` it receives aborts when a newer run takes over or the component is gone, so a slower answer never replaces a newer one.

A function that throws an `ApiError` keeps its `status` in `error()`. Any other error gives status 0.

## Server-sent events

Answer with `eventStream()` from a generator, an async iterable or an array. The browser reads it with `stream()`.

```ts
import { api, eventStream } from 'kay/server'

export default api().post(
  '/answer',
  ({ body }) => eventStream(complete(body.prompt)),
  { body: s.Object({ prompt: s.String() }) },
)
```

A source that waits on a quiet feed never gets to stop by itself, so give `eventStream()` a function instead: it receives a `signal` that aborts when the visitor leaves, to pass to whatever the source waits on.

```ts
export default api().get('/news', () => eventStream(signal => watchNews(signal)))
```

```kay
---
import { stream } from 'kay'
import chat from '../api/chat'

const answer = stream(chat, '/answer', {
  method: 'post',
  body: { prompt: 'Hello' },
})
---
p {answer.last()}
```

`last()` is the latest event, `on()` gets each one, and `status()` tells whether the stream is open, done or failed.

### Starting a stream by hand

Pass `start: false` to wait. The stream stays `idle` until a handler calls `start()` with the params, query and body of that run. Each start closes the run going and forgets its last value.

```kay
---
import { stream } from 'kay'
import chat from '../api/chat'

const prompt = signal('')
const answer = stream(chat, '/answer', { method: 'post', start: false })
---
input(value={prompt()} onInput={event => prompt.set(event.currentTarget.value)})
button(onClick={() => answer.start({ body: { prompt: prompt() } })}) Ask
button(onClick={answer.close} disabled={answer.status() !== 'open'}) Stop
p {answer.last()}
```

`close()` aborts the request, and the route's source stops as it would if the browser went away.

### Streaming anything else

`stream` also takes a function returning an async iterable, and gives `last()`, `on()`, `status()` and `close()`. The iterable has to stop on the `signal` the function receives.

<ReadMore href="/llms/api-from-islands#event-streams">How a source is read and stopped, failure handling and keep-alive comments are in the full API routes reference.</ReadMore>

## Websockets

A `.ws()` route in an API module is a websocket. Its `body` types what a client sends, and `response` types what it receives.

```ts
export default api().ws('/:room', {
  body: s.Object({ text: s.String() }),
  response: s.Object({ from: s.String(), text: s.String() }),
  message(ws, { text }) {
    ws.send({ from: ws.data.user?.name ?? 'guest', text })
  },
})
```

An island opens it with `socket()`. `send` takes the route's `body`, and `last()` reads the last message reactively.

```kay
---
import { socket } from 'kay'
import chat from '../api/chat'

const { room } = props<{ room: string }>()
const messages = socket(chat, '/:room', { params: { room } })
const text = signal('')
---
p {messages.last()?.text}
input(bind:value={text})
button(onClick={() => messages.send({ text: text() })}) Send
```

`status()` is `connecting`, `open` or `closed`. `on(listener)` gets each message, and `close()` closes the socket for good.

A dropped connection reconnects by itself. It waits while the tab is hidden or offline, though a visible tab still tries each minute, in case the browser is wrong about being offline.

A socket a guard refuses keeps retrying, shown as `connecting`.

## Rooms

Rooms group a module's connections, such as a game's players or a document's editors. `rooms()` from `kay/server` keeps them.

```ts
import { s } from 'kay'
import { api, rooms } from 'kay/server'

const chats = rooms<{ text: string }, string>()

export default api()
  .ws('/:room', {
    body: s.Object({ text: s.String() }),
    open(ws) {
      chats.join(ws, ws.data.params.room, ws.data.user.name)
    },
    message(ws, { text }) {
      chats.publish(ws.data.params.room, { text })
    },
    close(ws) {
      chats.leave(ws)
    },
  })
```

`join(ws, room, member)` puts a connection in a room, and `member` is how it is listed. `leave(ws)` takes it out of every room, as `close` does. `members(room)` lists who is in a room.

`publish(room, message)` sends to everyone in the room. Pass `{ except: ws }` to skip the sender.

A room no one is in is gone. Rooms live in the memory of one process by default. To reach every process of the machine, give `rooms` `sqliteRooms(path)`. A message reaches the other processes as soon as the file changes. The `poll` option, `'250ms'` by default, is how often a process also looks, in case the folder cannot be watched.

```ts
import { rooms, sqliteRooms } from 'kay/server'

const chats = rooms<{ text: string }, string>({ store: sqliteRooms('data/rooms.sqlite') })
```

### Your own store

To share rooms through Redis or another server, pass `store` a `RoomStore`, from `kay/server`. It keeps who is in each room and carries messages between processes.

| Method | Does |
| --- | --- |
| `add(room, connection, member)` | Records a connection of this process, with its member as JSON |
| `remove(room, connection)` | Drops it |
| `members(room)` | The members of a room as JSON, in every process sharing the store |
| `publish(room, text, recipients)` | Hands a message to the listeners of every process, this one's included |
| `subscribe(listener)` | Calls the listener with each message published from then on, and returns what stops it |
| `close()` | Stops what the store runs in the background |

### Sending a snapshot

When many changes arrive together, `coalesce` sends the room one snapshot instead of one message each.

```ts
const sendBoard = games.coalesce(room => ({ type: 'board', cells: boardOf(room) }))
```

Call `sendBoard(room)` as often as you like. Within 50 milliseconds, the room gets one board, as it stands.

### Messages of several kinds

`dispatch(message, handlers)` from `kay` calls the handler named by the message's `type`. It is typed to that variant, and the compiler checks that the handlers cover every type.

```ts
dispatch(body, {
  say: ({ text }) => games.publish(room, { type: 'said', text }),
  play: ({ cell }) => play(room, cell),
})
```

It works on the server's `body` and on what an island's `socket` receives.

<ReadMore href="/llms/api-from-islands#rooms">Sharing rooms between processes with SQLite, `to` targets, rejoining after a drop and reconnect timing are in the full API routes reference.</ReadMore>
