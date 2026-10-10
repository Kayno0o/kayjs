# API routes

Each `.ts` module under `src/api/`, the `api` option of `kay.config.ts` naming another directory, exports an Elysia instance by default, which `pages()` mounts at `/api` plus its path there, with nothing to register: `src/api/chat.ts` serves its routes under `/api/chat`, `src/api/index.ts` under `/api`. Files and directories starting with `_`, and `.test.ts` files, are left out.

```ts
import { t } from 'kay'
import { api, eventStream } from 'kay/server'
import { complete, listRooms } from '../data'

export default api()
  .get('/rooms', () => listRooms())
  .ws('/:room', {
    body: t.Object({ text: t.String() }),
    response: t.Object({ from: t.String(), text: t.String() }),
    message(ws, { text }) {
      ws.send({ from: ws.data.user?.name ?? 'guest', text })
    },
  })
  .post(
    '/answer',
    ({ body }) => eventStream(complete(body.prompt)),
    { body: t.Object({ prompt: t.String() }) },
  )
```

- A route answering a plain object or array holding a bigint, as a database's bigint ids are, gives JSON with each written as its digits, `{"id":"9007199254740993"}`, where `JSON.stringify` would throw; `resource()` types such a field as a `string`.
- `api()` is a `new Elysia()` whose handlers read the app's locals, typed as `ctx.locals` is (see [Locals](server.md#locals)): `({ user })`, `ws.data.user`. A plain `new Elysia()` is mounted the same way.
- A `_guard.ts` in `src/api/` or below runs before every route of the modules in its directory and below, outermost first, a websocket upgrade included, as it does for pages and actions: a redirect or a denial answers the request, and the cookies and headers it sets go out with the route's response.
- A library's API modules, laid over `src/api` under a prefix by its extension, serve as if they were the app's, behind its guards, an app module at the same path replacing one (see [Extensions](components.md#extensions)).
- A websocket upgrade, or a request other than GET, HEAD and OPTIONS, another site's page sends, as its `Origin` or `Sec-Fetch-Site` header shows, is refused with 403 once the guards let it through, since a browser lets any page open a websocket or post a form to any host with the user's cookies. A request carrying neither header, such as a webhook, goes through.
- `api({ cors: { origins: ['https://app.example.com', 'https://*.example.org'] } })` lets the pages of those origins call the module's routes from the browser, `https://*.example.org` standing for any of its subdomains, and `origins: '*'` for any site. A preflight `OPTIONS` is answered before the guards run, with the module's methods, the headers asked for, or `headers: [...]` alone, and `Access-Control-Max-Age`, `maxAge`, an hour by default; an origin not listed gets no grant. Its requests, websocket upgrades included, go through the guards and are not refused, their answers naming the origin, with `expose: [...]` the response headers the page may read. `credentials: true` takes the user's cookies as well; without it a request from another site carrying cookies is refused, and with `origins: '*'` it is a type error `kay check` reports. Its answers carry the grant, a body its schema refuses, one that does not parse, or one over its `bodyLimit` included, so the calling page reads why, and those of a module listing origins carry `Vary: Origin`, added to any Vary the route sets. An origin is a scheme and a host, a port if any, `capacitor://localhost` for an app's web view included. A module without `cors` answers no preflight and keeps refusing.
- `eventStream(source)` answers with server-sent events, one per value an async iterable, a generator or an array gives, crossing as island props do, Dates, Maps and Sets included. The source is read once the browser reads the response and stopped when it goes away; a source that throws ends the stream as failed, the error logged and handed to `onError`. A comment line every 5 seconds keeps a quiet stream open past Bun's `idleTimeout` and a proxy's.
- `kay check` checks links and redirects against the modules' GET routes, `/api/chat/rooms` here; `kay build --compile` embeds the modules, and `kay build --static` refuses them.
- `openapi: true` in kay.config.ts serves an OpenAPI 3.1 document of every module's routes at `/api/openapi.json`, read from the schemas they declare: path params in braces, `params`, `query` and `headers` as parameters, `body` as JSON, or multipart when it holds a `t.File()`, and `response`, one schema or one per status. A route's `detail` gives its `summary`, `description`, `tags`, the module's path by default, and `deprecated`, and `detail: { hide: true }` leaves it out; websockets are left out. A route behind guards lists them in `x-kay-guards`, by where they sit in the API directory, `private/_guard.ts`. The document is served behind the guards every module runs, the API directory's own `_guard.ts`, so a private API keeps its spec private. `{ title, version }` set its `info`, the site's `seo.name` and `1.0.0` by default; `{ reference: true }` adds `/api/reference`, a plain HTML page listing each route with what it takes and answers, behind the same guards; `{ dev: true }` keeps both to `kay dev`. The executable serves them as the server does. Without a `_guard.ts` of the API directory itself, the document is public, guarded modules included. Schemas are read as TypeBox writes them: a model's name or another library's validator documents nothing. An optional param lists the path with and without it, and a wildcard is `{wildcard}`. A module serving `/api/openapi.json`, or `/api/reference` with the page on, stops the server.

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
button(onClick={() => messages.send({ text })}) Send
```

- `socket(module, path, options)` opens one of the module's websocket routes, the path written as the module writes it, `params` and `query` filling it in, all typed from the route. `send` takes the route's `body`, `last()` reads the last message reactively, typed from its `response`, `on(listener)` gets each one and returns what stops it, and `status()` is `connecting`, `open` or `closed`. Messages travel as Elysia sends them, as JSON. What is sent before the connection opens goes once it does. A connection that drops reconnects, waiting longer each time up to 30 seconds, unless the server closed it with code 1000; `close()` closes it for good. `onOpen(listener)` is called each time the connection opens, a reconnect included, before what was queued goes: a client joining rooms by message joins them there, `messages.onOpen(() => messages.send({ type: 'join', room }))`, so it is back in them after a drop.
- `stream(module, path, options)` reads one of its routes answering with `eventStream()`, with `last()`, `on()` and `status()` the same way, `status()` being `done` once the stream ran to its end and `failed` when a guard or the route refused it or its source threw. `{ method: 'post', body }` reads a route taking a body, such as an AI answer. A GET stream that drops reconnects; any other ends as failed.
- `resource(module, path, options)` reads one of its GET routes answering a value, typed from the route's `response` as JSON leaves it, a Date as its ISO text. `value()` is the last answer, kept while the route is asked again, `status()` is `loading`, `ready` or `failed`, `error()` gives the `status` and `message` a route refused with, status 0 when no answer came, and `refresh()` asks again. Options given as a function, `() => ({ query: { prefix: search() } })`, are read reactively: a signal they read changing asks the route again, and an answer a newer request overtook is dropped.
- All three open once the island is in the page, never on the server, where `resource()` renders `loading`, and close with the component that opened them. The browser build gives the island the module's mount and none of its code, so its other exports never reach the browser, and an island importing any other file under `src/api/`, such as a `_schemas.ts`, fails the build: code an island shares with a module lives outside it.
- A refused upgrade looks like a dropped connection to the browser, so a socket a guard refuses keeps retrying, `connecting`, every 30 seconds at most.

Rooms group a module's websocket connections, such as a game's players or a document's editors:

```ts
import { t } from 'elysia'
import { dispatch } from 'kay'
import { api, rooms } from 'kay/server'

type Sent =
  | { type: 'said', from: string, text: string }
  | { type: 'board', cells: string[] }

const games = rooms<Sent, string>()
const sendBoard = games.coalesce(room => ({
  type: 'board',
  cells: boardOf(room),
}))

export default api()
  .ws('/:room', {
    body: t.Union([
      t.Object({ type: t.Literal('say'), text: t.String() }),
      t.Object({ type: t.Literal('play'), cell: t.Integer() }),
    ]),
    open(ws) {
      games.join(ws, ws.data.params.room, ws.data.user.name)
    },
    message(ws, body) {
      const room = ws.data.params.room

      dispatch(body, {
        say: ({ text }) => games.publish(
          room,
          { type: 'said', from: ws.data.user.name, text },
          { except: ws },
        ),
        play: ({ cell }) => {
          play(room, cell)
          sendBoard(room)
        },
      })
    },
    close(ws) {
      games.leave(ws)
    },
  })
```

- `rooms<Message, Member>(options)` from `kay/server` keeps rooms of connections, `Message` what is sent to them and `Member` what each is listed as. `join(ws, room, member)` puts a connection in a room, joining again replacing its member; `leave(ws, room)` takes it out, and `leave(ws)` out of every room, as `close` does; `members(room)` lists the members, and `roomsOf(ws)` the rooms a connection is in. A room no one is in is gone.
- `publish(room, message, { except, to })` sends a message to everyone in the room, but the connection `except` names, such as the sender, or only to the connections joined as the member `to` names, such as a game's host, compared as JSON. It goes out as Elysia sends one, a string as it is and anything else as JSON, not checked against the route's `response`.
- `coalesce(read, { wait })` gives a function sending a room one snapshot `read(room)` makes when it goes, however many times it is called within `wait` milliseconds, 50 by default: a burst of moves sends the board once, as it stands.
- `dispatch(message, handlers)` from `kay` calls the handler a message's `type` names with the message, typed to that variant, and gives what it returns; the handlers cover every type, as the compiler checks, and a type none names, such as one a newer server sends, throws. It works on the server's `body` and on what an island's `socket` receives, `messages.on(message => dispatch(message, { ... }))`.
- Rooms live in the process's memory by default. `rooms({ store: sqliteRooms('data/rooms.sqlite') })` shares them between every process of the machine opening the file, as `sqliteJobs` does: `members` lists those connected to any of them, and a message published in one reaches the others within `poll` milliseconds, 25 by default. A process listens from its first `join` on, never handed what was published before. A process that stops without its connections leaving, such as one that crashed, has its members dropped once it has not been heard from for 10 seconds; one only stalled that long writes them back on its next heartbeat. `close()` on the store stops its timers and lets go of the file. Rooms do not reach other machines.
