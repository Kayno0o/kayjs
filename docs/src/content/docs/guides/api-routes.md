---
title: API routes
order: 6
description: Add Elysia routes under src/api and call them typed from an island, with server-sent events and websockets.
---

Each `.ts` module in `src/api/` exports an Elysia instance by default, and kay mounts it at `/api` plus its path, with nothing to register. `src/api/notes.ts` serves `/api/notes`:

```ts
import { s } from 'kay'
import { api } from 'kay/server'
import { addNote, listNotes } from '../data'

export default api()
  .get(
    '/',
    ({ query }) => listNotes(query.prefix ?? ''),
    { query: s.Object({ prefix: s.Optional(s.String()) }) },
  )
  .post(
    '/',
    ({ body }) => addNote(body.text),
    { body: s.Object({ text: s.String() }) },
  )
```

`api()` is an Elysia instance whose handlers read the app's `locals`, so `({ user })` is typed. A `_guard.ts` in `src/api/` protects its routes like it protects pages. A route at the path of a page, a public file, an endpoint or a redirect stops the server at boot. A single file a static export should write, such as `llms.txt`, is an [endpoint file](/essentials/routing#endpoint-files) in `src/routes/` instead.

A handler that throws is logged with its stack and handed to `onError`, like a page's error, and answers 500 with `Internal Server Error` in production, its message in development. A module's own `onError` answering the error comes first, and a body its schema refuses or a `status()` thrown keeps the answer Elysia gives, unlogged.

A route answering a class instance without its own `toString`, or a `Map`, such as an ORM row returned as is, is answered and logged the same way, naming its class, rather than sent as `[object Object]`, and so is one passed to `status()`: answer a plain object or array, or a `Response`.

<Callout type="note">

A request other than GET that another site's page sends is refused with 403, and so is a websocket upgrade. A module other sites' pages call from the browser names their origins:

```ts
// src/api/catalog.ts
import { api } from 'kay/server'

export default api({
  cors: {
    origins: ['https://shop.example.com', 'https://*.partner.example'],
    credentials: true,
  },
})
  .get('/items', () => [{ id: 1, name: 'Pen' }])
```

kay answers the browser's preflight before the guards run, with the module's methods, and lets those pages' requests through, cookies included with `credentials: true`. `origins: '*'` opens it to any site, without cookies. `headers` limits the request headers allowed, `expose` names the response headers a page may read, and `maxAge` sets how long a browser keeps the preflight's answer, an hour by default.

</Callout>

## OpenAPI

`openapi: true` in kay.config.ts publishes an OpenAPI 3.1 document of every module's routes at `/api/openapi.json`, read from the schemas they already declare. Give a route a `detail: { summary, tags }` to describe it, or `detail: { hide: true }` to leave it out. `openapi: { reference: true }` adds a page listing the routes at `/api/reference`, and `openapi: { dev: true }` keeps both to `kay dev`. The document sits behind `src/api/_guard.ts` when there is one, and lists the guards each route runs.

## Calling it from an island

An island imports the module and reads its routes with `resource`, typed from the route. Only the mount reaches the browser, never the module's code.

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

Options given as a function are reactive: when `search` changes, the route is asked again. `refresh()` asks again by hand. A resource opens once the island is in the page, never on the server.

An event handler calls any route with `call`, from an island or a module several islands share. `method` is GET unless named, `params`, `query` and `body` are typed from the route, and so is the answer. A refusal throws an `ApiError` with its `status` and `message`.

```kay
---
import { call } from 'kay'
import notes from '../api/notes'

const title = signal('')
---
input(bind:value={title})
button(onClick={() => call(notes, '/', { method: 'post', body: { title } })}) Add
```

`signal` aborts a call. A body holding a `File` goes as a multipart form, and `progress: sent => ...` reports how much of it went, from 0 to 1.

## Server-sent events

Answer with `eventStream()` from a generator, an async iterable or an array, and read it with `stream()`:

```ts
import { api, eventStream } from 'kay/server'

export default api().post(
  '/answer',
  ({ body }) => eventStream(complete(body.prompt)),
  { body: s.Object({ prompt: s.String() }) },
)
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

## Websockets

A `.ws()` route is opened with `socket()`. `send` takes the route's `body`, `last()` reads the last message reactively and `status()` is `connecting`, `open` or `closed`. A dropped connection reconnects by itself.

```ts
export default api().ws('/:room', {
  body: s.Object({ text: s.String() }),
  response: s.Object({ from: s.String(), text: s.String() }),
  message(ws, { text }) {
    ws.send({ from: ws.data.user?.name ?? 'guest', text })
  },
})
```

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
button(onClick={() => messages.send({ text })}) Send
```

<ReadMore href="/llms/api-routes">Rooms for grouping connections, `dispatch`, sharing rooms between processes, bigint handling and guard details are in the full API routes reference.</ReadMore>
