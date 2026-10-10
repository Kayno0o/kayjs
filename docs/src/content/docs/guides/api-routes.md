---
title: API routes
order: 6
description: Add Elysia routes under src/api and call them typed from an island, with server-sent events and websockets.
---

Each `.ts` module in `src/api/` exports an Elysia instance by default, and kay mounts it at `/api` plus its path, with nothing to register. `src/api/notes.ts` serves `/api/notes`:

```ts
import { t } from 'kay'
import { api } from 'kay/server'
import { addNote, listNotes } from '../data'

export default api()
  .get(
    '/',
    ({ query }) => listNotes(query.prefix ?? ''),
    { query: t.Object({ prefix: t.Optional(t.String()) }) },
  )
  .post(
    '/',
    ({ body }) => addNote(body.text),
    { body: t.Object({ text: t.String() }) },
  )
```

`api()` is an Elysia instance whose handlers read the app's `locals`, so `({ user })` is typed. A `_guard.ts` in `src/api/` protects its routes like it protects pages.

<Callout type="note">

A request other than GET that another site's page sends is refused with 403, and so is a websocket upgrade. A module other sites' pages call from the browser names their origins:

```ts
// src/api/catalog.ts
import { api } from 'kay/server'

export default api({ cors: { origins: ['https://shop.example.com', 'https://*.partner.example'], credentials: true } })
  .get('/items', () => [{ id: 1, name: 'Pen' }])
```

kay answers the browser's preflight before the guards run, with the module's methods, and lets those pages' requests through, cookies included with `credentials: true`. `origins: '*'` opens it to any site, without cookies. `headers` limits the request headers allowed, `expose` names the response headers a page may read, and `maxAge` sets how long a browser keeps the preflight's answer, an hour by default.

</Callout>

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

## Server-sent events

Answer with `eventStream()` from a generator, an async iterable or an array, and read it with `stream()`:

```ts
import { api, eventStream } from 'kay/server'

export default api().post(
  '/answer',
  ({ body }) => eventStream(complete(body.prompt)),
  { body: t.Object({ prompt: t.String() }) },
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
  body: t.Object({ text: t.String() }),
  response: t.Object({ from: t.String(), text: t.String() }),
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
