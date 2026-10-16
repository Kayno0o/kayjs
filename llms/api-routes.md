# API routes

## Common tasks

### Add a JSON endpoint

A `.ts` module under `src/api/` exporting an `api()` instance by default is mounted at `/api` plus its path, so `src/api/notes.ts` serves `/api/notes`:

```ts
import { s } from 'kay'
import { api } from 'kay/server'
import { listNotes, addNote } from '../data'

export default api()
  .get('/', () => listNotes())
  .post(
    '/',
    ({ body }) => addNote(body.title),
    { body: s.Object({ title: s.String() }) },
  )
```

### Read the signed-in user in a route

`api()` handlers read the app's locals, so a route destructures `user` as a page does:

```ts
import { api } from 'kay/server'

export default api()
  .get('/me', ({ user }) => ({ name: user?.name ?? 'guest' }))
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

### Open a public webhook under a guarded directory

`api({ guards: false })` runs none of the `_guard.ts` files above the module:

```ts
import { api } from 'kay/server'
import { record } from '../data'

export default api({ guards: false })
  .post('/', ({ body }) => record(body))
```

### Let another site's pages call a module

`cors` names the origins, `https://*.example.org` standing for any subdomain:

```ts
import { api } from 'kay/server'
import { listRooms } from '../data'

export default api({ cors: { origins: ['https://app.example.com', 'https://*.example.org'] } })
  .get('/rooms', () => listRooms())
```

### Document the API as OpenAPI

`openapi: true` in `kay.config.ts` serves the document at `/api/openapi.json`, and `reference: true` adds an HTML page at `/api/reference`:

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  openapi: { title: 'Notes API', version: '1.0.0', reference: true },
})
```

### Let an agent call the app

`mcp: true` in `kay.config.ts` serves an MCP endpoint at `/mcp`, a tool per API route of the OpenAPI document and per action that sets `tool`:

```ts
// kay.config.ts
export default defineConfig({ mcp: true })
```

```kay
--- server
import { s } from 'kay'

export const addNote = action(
  s.Object({ title: s.String({ minLength: 3, maxLength: 80 }) }),
  async ({ title }) => ({ title }),
  { tool: 'Create a note' },
)
---
h1 Notes
```

Point an MCP client at `https://example.com/mcp`. `addNote` is the tool `add_note`; a route is named by its `operationId`, `get_notes_id` for `GET /api/notes/{id}`.

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

### Group websocket connections in rooms

`rooms()` from `kay/server` joins connections in a room and `publish` sends to everyone in it:

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

## Reference

### API modules

Each `.ts` module under `src/api/`, the `api` option of `kay.config.ts` naming another directory, exports an Elysia instance by default, which `pages()` mounts at `/api` plus its path there, with nothing to register: `src/api/chat.ts` serves its routes under `/api/chat`, `src/api/index.ts` under `/api`.

Files and directories starting with `_`, and `.test.ts` files, are left out.

```ts
import { s } from 'kay'
import { api, eventStream } from 'kay/server'
import { complete, listRooms } from '../data'

export default api()
  .get('/rooms', () => listRooms())
  .ws('/:room', {
    body: s.Object({ text: s.String() }),
    response: s.Object({ from: s.String(), text: s.String() }),
    message(ws, { text }) {
      ws.send({ from: ws.data.user?.name ?? 'guest', text })
    },
  })
  .post(
    '/answer',
    ({ body }) => eventStream(complete(body.prompt)),
    { body: s.Object({ prompt: s.String() }) },
  )
```

- A handler, guard or hook that throws is logged and handed to `onError`, answering 500 with `Internal Server Error` in production, its message in development.
- A module's own `onError` answering it comes first.
- Refused input or a thrown `status()` keeps Elysia's answer, unlogged.
- A route answering a plain object or array holding a bigint, as a database's bigint ids are, gives JSON with each written as its digits, `{"id":"9007199254740993"}`, where `JSON.stringify` would throw.
- `resource()` types such a field as a `string`.
- A route answers a plain object or array as JSON, and a string, a number, a `Date`, a `Response`, a `Blob`, bytes or a stream as Elysia does.
- A class instance without its own `toString`, or a `Map`, such as an ORM row returned as is, answers 500 and is logged with the route and its class, as a throw is, where Elysia would send `[object Object]`.
- A class instance without its own `toString`, or a `Map`, passed to `status()` answers 500 the same way.
- `api()` is a `new Elysia()` whose handlers read the app's locals, typed as `ctx.locals` is (see [Locals](server.md#locals)): `({ user })`, `ws.data.user`.
- A plain `new Elysia()` is mounted the same way.
- A `_guard.ts` in `src/api/` or below runs before every route of the modules in its directory and below, outermost first, a websocket upgrade included, as it does for pages and actions.
- A body, query or params the route's schema refuses, or a file of the wrong type, meets the guards first, as an action's input does (see [Guards](server.md#guards)): a caller they refuse gets their answer, never the validation error.
- A redirect or a denial from a guard answers the request, and the cookies and headers it sets go out with the route's response.
- A route serving, by its method or `all`, the path of a page, a public file, an endpoint, a redirect or a feed stops the server.
- `kay check` leaves that to the boot, which `kay build` runs, since listing the routes takes running the modules.
- `api({ guards: false })` runs none of the guards above the module, as a public webhook under a guarded directory needs.
- On a site with `requireGuards`, a module no guard covers answers 403 unless it sets `guards: false` (see [Guards](server.md#guards)).
- A library's API modules, laid over `src/api` under a prefix by its extension, serve as if they were the app's, behind its guards, an app module at the same path replacing one (see [Extensions](components.md#extensions)).
- A websocket upgrade, or a request other than GET, HEAD and OPTIONS, another site's page sends, as its `Origin` or `Sec-Fetch-Site` header shows, is refused with 403 once the guards let it through, since a browser lets any page open a websocket or post a form to any host with the user's cookies.
- A request carrying neither header, such as a webhook, goes through.
- `kay check` checks links and redirects against the modules' GET routes, `/api/chat/rooms` here.
- `kay build --compile` embeds the modules, and `kay build --static` refuses them: a file such as `src/routes/llms.txt.ts` exporting `GET` serves a path a static export writes (see [Endpoint files](routing.md#endpoint-files)).

### CORS

- `api({ cors: { origins: ['https://app.example.com', 'https://*.example.org'] } })` lets the pages of those origins call the module's routes from the browser, `https://*.example.org` standing for any of its subdomains, and `origins: '*'` for any site.
- A preflight `OPTIONS` is answered before the guards run, with the module's methods, the headers asked for, or `headers: [...]` alone, and `Access-Control-Max-Age`, `maxAge`, an hour by default.
- An origin not listed gets no grant.
- Its requests, websocket upgrades included, go through the guards and are not refused, their answers naming the origin, with `expose: [...]` the response headers the page may read.
- `credentials: true` takes the user's cookies as well; without it a request from another site carrying cookies is refused.
- `credentials: true` with `origins: '*'` is a type error `kay check` reports.
- Its answers carry the grant, a body its schema refuses, one that does not parse, or one over its `bodyLimit` included, so the calling page reads why.
- The answers of a module listing origins carry `Vary: Origin`, added to any Vary the route sets.
- An origin is a scheme and a host, a port if any, `capacitor://localhost` for an app's web view included.
- The module's rule alone grants: `Access-Control-Allow-Origin`, `-Allow-Credentials` and `-Expose-Headers` a route sets itself, on `set.headers` or on a `Response` it returns, a `fetch()` result passed on included, are replaced by the rule's, or dropped for an origin it does not list. A route needing another rule goes in a module of its own.
- A module without `cors` answers no preflight and keeps refusing.

### Event streams

- `eventStream(source)` answers with server-sent events, one per value an async iterable, a generator or an array gives, crossing as island props do, Dates, Maps and Sets included.
- The source is read once the browser reads the response and stopped when it goes away.
- A source that throws ends the stream as failed, the error logged and handed to `onError`.
- A comment line every 5 seconds keeps a quiet stream open past Bun's `idleTimeout` and a proxy's.

### OpenAPI

- `openapi: true` in kay.config.ts serves an OpenAPI 3.1 document of every module's routes at `/api/openapi.json`, read from the schemas they declare.
- Path params are written in braces; `params`, `query` and `headers` are parameters; `body` is JSON, or multipart when it holds an `s.File()`; `response` is one schema or one per status.
- A route's `detail` gives its `summary`, `description`, `tags`, the module's path by default, and `deprecated`.
- `detail: { hide: true }` leaves a route out; websockets are left out.
- A route behind guards lists them in `x-kay-guards`, by where they sit in the API directory, `private/_guard.ts`.
- The document is served behind the guards every module runs, the API directory's own `_guard.ts`, a module setting `guards: false` aside, which get the context a module's guard gets, the app's session in `ctx.locals` included, so a private API keeps its spec private.
- `{ title, version }` set its `info`, the site's `seo.name` (the default locale's when it takes one text per locale, as the document is one for every locale) and `1.0.0` by default.
- `{ reference: true }` adds `/api/reference`, a plain HTML page listing each route with what it takes and answers, behind the same guards.
- `{ dev: true }` keeps both to `kay dev`.
- The executable serves them as the server does.
- Without a `_guard.ts` of the API directory itself, the document is public, guarded modules included.
- Schemas are read as TypeBox writes them: a model's name or another library's validator documents nothing.
- An optional param lists the path with and without it, and a wildcard is `{wildcard}`.
- A module serving `/api/openapi.json`, or `/api/reference` with the page on, stops the server.
- Every operation has an `operationId`: the route's `detail.operationId`, else its method and path, `get_notes_id`; a clash gets `_2`.
- An action that sets `tool` is a `POST` operation at its URL under the tag `actions`, `x-kay-action` set, its guards in `x-kay-guards`, as the document and the MCP tools say the same. It is called as `action()` calls are, its input encoded as kay writes it, not as a plain JSON body.

### MCP

- `mcp: true` serves Streamable HTTP at `/mcp`: one JSON-RPC message per `POST`, answered with JSON, `initialize`, `ping`, `tools/list` and `tools/call` only, no resources or prompts. `GET` and `DELETE` answer 405, a notification 202.
- A message that is no JSON-RPC request answers 400, a body over `bodyLimit` 413, a request from another site (`Origin`, `Sec-Fetch-Site`) 403.
- A tool per operation of the OpenAPI document, even with `openapi` off, named by its `operationId`, described by its `summary` and `description`, its input one JSON Schema of the path params, query and JSON body, merged by name.
- Left out: `detail: { hide: true }` routes, websockets, a route whose body is files, text or bytes, and an action holding a file.
- A route answering every method, `.all()`, is a tool per method.
- An action is a tool only when its third argument sets `tool`: `true`, a description, or `{ name, description }`; its name is the export in snake case, `addNote` is `add_note`, a clash `add_note_2`, and its input schema is the action's.
- A name is made of letters, digits and `_`, at most 64 characters.
- A call is dispatched through the whole app as a fetch to the route's or action's URL would be, so its guards, `rateLimit`, body limit, schema validation and `ctx.locals` are the web path's; `ctx.params` and `ctx.url` of an action are read as for a script's post from no page.
- It carries the caller's `Authorization`, `Cookie`, `Accept-Language` and `User-Agent`, and rate limits count the caller's address as `proxy` reads it, not the server's.
- `honeypot`, `minTime` and `proofOfWork` are skipped, as only a form a person filled in can pass them; a marker only the endpoint sets, a per-process secret no request can send, says so, and `rateLimit` still counts.
- A path param is one segment: it is percent-encoded and an empty one, `.` or `..` is refused, so no value reaches another route.
- A refused call is a result with `isError`: the schema's field errors, the `ctx.fail` data and status as `{ status, errors, data }` JSON, a route's own refusal text, a redirect naming where it leads. The agent corrects and calls again.
- A guard answering 401 makes the endpoint answer 401 with `WWW-Authenticate: Bearer resource_metadata="<site>/.well-known/oauth-protected-resource"`, how a client learns to sign in; any other refusal, 403 included, is a result.
- An action's result is JSON as its text, and `structuredContent` when an object; a route's JSON or text answer likewise, any other type read as its size.
- `/mcp` is claimed like a route: a page, endpoint or file serving it stops the boot, and `kay check` reports it.
- `unguarded-tool` warns, with `mcp`, of a tool action with a `honeypot`, `minTime` or `proofOfWork` that no guard covers: an agent calls it without the form those protections ask of a person.
- `site.mcp.tools()` and `site.mcp.call(name, args)` in `kay/test`.

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
- A file or a `Blob` the route answers arrives as a `Blob`, or as text when its type is text, and a `Response` it builds is typed `unknown`, read as JSON, text or a `Blob` by its content type.
- A refusal throws `ApiError` from `kay` with `status`, `message` and `answer`, its text when its JSON does not parse, `HTTP 503` when it says nothing; status 0 when no answer came or it was cut off.
- `signal` aborts the call, which rejects with the signal's reason, while the answer is read too.
- A body holding a `File` or a `Blob`, or a `FormData`, goes as a multipart form, its other fields as text, a Date as its ISO text, an object as JSON and null left out, as in a `query`.
- `progress: sent => ...` gets how much of it went, from 0 to 1.
- `socket`, `stream` and `resource` open once the island is in the page, never on the server, where `resource()` renders `loading`, and close with the component that opened them.
- The browser build gives the island the module's mount and none of its code, so its other exports never reach the browser.
- An island importing any other file under `src/api/`, such as a `_schemas.ts`, fails the build: code an island shares with a module lives outside it.
- A refused upgrade looks like a dropped connection to the browser, so a socket a guard refuses keeps retrying, `connecting`, every 30 seconds at most.

### Rooms

Rooms group a module's websocket connections, such as a game's players or a document's editors:

```ts
import { dispatch, s } from 'kay'
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
    body: s.Union([
      s.Object({ type: s.Literal('say'), text: s.String() }),
      s.Object({ type: s.Literal('play'), cell: s.Integer() }),
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

- `rooms<Message, Member>(options)` from `kay/server` keeps rooms of connections, `Message` what is sent to them and `Member` what each is listed as.
- `join(ws, room, member)` puts a connection in a room, joining again replacing its member.
- `leave(ws, room)` takes it out, and `leave(ws)` out of every room, as `close` does.
- `members(room)` lists the members, and `roomsOf(ws)` the rooms a connection is in.
- A room no one is in is gone.
- `publish(room, message, { except, to })` sends a message to everyone in the room, but the connection `except` names, such as the sender, or only to the connections joined as the member `to` names, such as a game's host, compared as JSON.
- It goes out as Elysia sends one, a string as it is and anything else as JSON, not checked against the route's `response`.
- `coalesce(read, { wait })` gives a function sending a room one snapshot `read(room)` makes when it goes, however many times it is called within `wait` milliseconds, 50 by default: a burst of moves sends the board once, as it stands.
- `dispatch(message, handlers)` from `kay` calls the handler a message's `type` names with the message, typed to that variant, and gives what it returns.
- The handlers cover every type, as the compiler checks, and a type none names, such as one a newer server sends, throws.
- `dispatch` works on the server's `body` and on what an island's `socket` receives, `messages.on(message => dispatch(message, { ... }))`.
- Rooms live in the process's memory by default.
- `rooms({ store: sqliteRooms('data/rooms.sqlite') })` shares them between every process of the machine opening the file, as `sqliteJobs` does: `members` lists those connected to any of them, and a message published in one reaches the others within `poll` milliseconds, 25 by default.
- A process listens from its first `join` on, never handed what was published before.
- A process that stops without its connections leaving, such as one that crashed, has its members dropped once it has not been heard from for 10 seconds; one only stalled that long writes them back on its next heartbeat. A process with no connection joined neither beats nor polls, so an idle one costs the file nothing.
- `close()` on the store stops its timers and lets go of the file.
- Rooms do not reach other machines.
