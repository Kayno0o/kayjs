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

The module's `cors` is the only place that grants. If a route sets `Access-Control-Allow-Origin`, `Access-Control-Allow-Credentials` or `Access-Control-Expose-Headers` itself, or returns a `Response` that carries them, such as one from `fetch()`, kay replaces them with the module's, or drops them for an origin the module does not list. A route that needs another rule goes in a module of its own.

</Callout>

## OpenAPI

`openapi: true` in kay.config.ts publishes an OpenAPI 3.1 document of every module's routes at `/api/openapi.json`, read from the schemas they already declare. Give a route a `detail: { summary, tags }` to describe it, or `detail: { hide: true }` to leave it out. `openapi: { reference: true }` adds a page listing the routes at `/api/reference`, and `openapi: { dev: true }` keeps both to `kay dev`. The document sits behind `src/api/_guard.ts` when there is one, which reads the session as it does for any module, and lists the guards each route runs. Its title is `openapi.title`, else the site's `seo.name`, the default locale's when that takes one text per locale, as the document is one for every locale. Each operation has an `operationId`. The actions that set `tool` are listed too, as `POST` operations.

## Letting an agent call the app

`mcp: true` in kay.config.ts lets an AI agent use your app. Kay serves an MCP endpoint at `/mcp`, and an agent that is pointed at it can list and call your tools. You write no MCP server.

Every API route in the OpenAPI document becomes a tool. A route called `GET /api/notes/{id}` is the tool `get_notes_id`, described by its `detail.summary`. Its input is built from the schemas the route already declares. Set `detail: { operationId: 'read_note' }` to name it yourself, or `detail: { hide: true }` to keep it out.

An action is a tool only when you say so, with `tool` in its third argument. This way, setting `mcp` never hands an agent an action such as "delete account".

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

Here `addNote` is the tool `add_note`, and its description is the text you gave. `tool: true` uses the export name alone, and `tool: { name, description }` sets both.

A call goes through the whole app, just as a fetch from a browser would. Guards still guard, rate limits still count the caller, and `ctx.locals` holds what your session code puts there. The caller's `Authorization` header is passed on, so a guard that reads a bearer token sees it. When a guard answers 401, the endpoint answers 401 too, with a `WWW-Authenticate` header that points a client to your sign-in metadata.

A call that is refused is not an error of the protocol. The agent gets the reason as the tool's result, with the field errors of a schema, and can fix its input and call again.

An agent fills in no form, so `honeypot`, `minTime` and `proofOfWork` do not apply to its calls. `kay check` warns when a tool action has one of them and no guard, because anyone could then call it. Add a guard, or use a `rateLimit` instead.

Routes with a file in their body, and actions with a file in their schema, are not offered, as an agent sends JSON.

In a test, `site.mcp.tools()` lists the tools and `site.mcp.call('add_note', { title: 'Milk' })` calls one. See [Testing](/guides/testing).

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

`resource` also reads anything that is not a route of yours, such as a call over your own WebSocket or a `fetch` to another server. Give it a function: `resource(async signal => (await fetch(url(), { signal })).json())` has the same `value()`, `status()`, `error()` and `refresh()`. A signal the function reads before its first `await` makes it run again when it changes, `signal` aborts when a newer run takes over or the component is gone, and a slower answer never replaces a newer one. A function that throws an `ApiError` keeps its `status` in `error()`, any other error gives status 0. `stream` takes a function returning an async iterable the same way, and gives `last()`, `on()`, `status()` and `close()`; the iterable has to stop on its `signal`.

An event handler calls any route with `call`, from an island or a module several islands share. `method` is GET unless named, `params`, `query` and `body` are typed from the route, and so is the answer. A refusal throws an `ApiError` with its `status` and `message`, status 0 when no answer came. A file the route answers arrives as a `Blob`, and a route answering nothing as `''`.

```kay
---
import { call } from 'kay'
import notes from '../api/notes'

const title = signal('')
---
input(bind:value={title})
button(onClick={() => call(notes, '/', { method: 'post', body: { title: title() } })}) Add
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

A stream opened with `start: false` waits, `idle`, for a handler to call `start()` with the params, query and body of that run, typed by the route. Each start closes the run going and forgets its last value. The body may hold a `File` or be a `FormData`, sent as a form. `close()` aborts the request, and the route's source stops as it would if the browser went away:

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

## Websockets

A `.ws()` route is opened with `socket()`. `send` takes the route's `body`, `last()` reads the last message reactively and `status()` is `connecting`, `open` or `closed`. A dropped connection reconnects by itself, waiting while the tab is hidden or offline, though a visible tab still tries each minute in case the browser is wrong about being offline.

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
button(onClick={() => messages.send({ text: text() })}) Send
```

<ReadMore href="/llms/api-routes">Rooms for grouping connections, `dispatch`, sharing rooms between processes, bigint handling and guard details are in the full API routes reference.</ReadMore>
