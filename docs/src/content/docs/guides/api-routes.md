---
title: API routes
order: 6
description: Add typed Elysia routes under src/api, call them from islands, open them to other sites, and document or expose them to agents.
---

Each `.ts` module in `src/api/` exports an Elysia instance by default. Kay mounts it at `/api` plus its path, with nothing to register. `src/api/notes.ts` serves `/api/notes`.

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

`api()` is an Elysia instance whose handlers read the app's `locals`, so `({ user })` is typed. A `_guard.ts` in `src/api/` protects its routes the way it protects pages. A handler runs in the locale of the page that called it, by its `Referer` or the browser's `Accept-Language`, so `t()` and `wording()` answer in it. A websocket's `open` and `message` callbacks run outside it.

A route at the path of a page, a public file, an endpoint or a redirect stops the server at boot. A single file a static export should write, such as `llms.txt`, is an [endpoint file](/essentials/routing#endpoint-files) in `src/routes/` instead.

## Errors

A handler that throws is logged with its stack and handed to `onError`, like a page's error. The answer is 500 with `Internal Server Error` in production and the message in development.
A hook that throws before a route is chosen is answered the same way. That covers an Elysia `onRequest` of your own, a param matcher, `rewrite` and a hook from an extension.

A browser asking for a page gets your `_error.kay`, or kay's own error page, and any other request gets plain text. A `Response` the hook throws is sent as given, and an `onError` of your own that answers comes first.

A module's own `onError` that answers the error comes first. A body its schema refuses, or a thrown `status()`, keeps the answer Elysia gives, unlogged.

A response that does not match the route's `response` schema is a bug in the route, so it answers 500 like a throw: logged, handed to `onError`, with `Internal Server Error` in production and the schema error in development. Input the schema refuses stays 422.

Answer a plain object, an array or a `Response`. A class instance without its own `toString`, or a `Map`, such as an ORM row returned as is, is logged with its class name and answered as an error, not sent as `[object Object]`. The same goes for one passed to `status()`.

## Calling a route from an event handler

`call` runs any route of a module from an event handler, or from a module several islands share. It is typed from the route.

```kay
---
import { call } from 'kay'
import notes from '../api/notes'

const title = signal('')
---
input(bind:value={title})
button(onClick={() => call(notes, '/', { method: 'post', body: { title: title() } })}) Add
```

`method` is GET unless named. `params`, `query` and `body` are typed from the route, and so is the answer. A route answering nothing gives `''`, and a file arrives as a `Blob`. A param is encoded as one path segment, and an empty param, or `.` or `..` as a param or as a segment of a `*`, is refused with a `TypeError`, as it would reach the collection or the parent route. A `*` may be empty. Pass a `*` value decoded.

A refusal throws an `ApiError` with its `status` and `message`. Its status is 0 when no answer came.

To show a refusal, `refusalMessage(error, 'Try again')` from `kay` gives the route's message, or the fallback when no answer came or the error is something else. It saves the `instanceof ApiError` check.

For a write from an island that should not reload the page, an [action](/essentials/forms-and-actions#calling-an-action-from-an-island) called with `{ refresh: false }` does the same, and brings a schema and a rate limit of its own.

Pass `signal` to abort a call. A body holding a `File` goes as a multipart form, and `progress: sent => ...` reports how much of it went, from 0 to 1.

To keep a page current from a route, see [Live data and realtime](/guides/live-and-realtime).

## Calls from other sites

A request other than GET that another site's page sends is refused with 403, and so is a websocket upgrade. To let those pages call a module from the browser, name their origins in the module.

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

Kay answers the browser's preflight before the guards run, with the module's methods. It lets those pages' requests through, with cookies when `credentials` is `true`. `origins: '*'` opens the module to any site, without cookies.

Three more keys tune it. `headers` limits the request headers allowed. `expose` names the response headers a page may read. `maxAge` sets how long a browser keeps the preflight answer, an hour by default.

The module's `cors` is the only place that grants. If a route sets `Access-Control-Allow-Origin`, `Access-Control-Allow-Credentials` or `Access-Control-Expose-Headers` itself, kay replaces them with the module's. It drops them for an origin the module does not list. A route that needs another rule goes in a module of its own.

`cors` in kay.config.ts is the default of every module that sets none, one a library or an extension supplies included, so an app opening its whole API says it once. A module with its own `cors` keeps it, and `api({ cors: false })` keeps a module to its own site.

```ts
// kay.config.ts
export default defineConfig({
  cors: { origins: ['https://shop.example.com'] },
})
```

<ReadMore href="/llms/api-routes#cors">The exact rules for origins, preflight answers and a `Response` that carries its own headers are in the full API routes reference.</ReadMore>

## Limits

A module limits how often one client calls it. Past the limit a request answers 429 with `Retry-After`.

```ts
export default api({ rateLimit: { max: 60, window: '1m' } })
  .post('/send', send, { detail: { rateLimit: { max: 5, window: '1m' }, maxSize: '4kb' } })
```

A route sets its own limit and its own `maxSize` in its `detail`. The module's limit applies to it as well.

`key` counts a person instead of an address, as it does for an action. The limit counts after the guards, so a caller they refuse costs no allowance. Stores and the other options are in [Rate limits](/guides/security#rate-limits).

<ReadMore href="/llms/api-routes#limits">Lists of limits, shared stores, params and the order they count in.</ReadMore>

## OpenAPI

Set `openapi: true` in kay.config.ts to publish an OpenAPI 3.1 document of every module's routes at `/api/openapi.json`. It is read from the schemas the routes already declare.

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  openapi: { title: 'Notes API', reference: true },
})
```

Give a route `detail: { summary, tags }` to describe it, or `detail: { hide: true }` to leave it out. `reference: true` adds a page listing the routes at `/api/reference`. `dev: true` keeps both to `kay dev`. `path` and `referencePath` move them, such as `openapi: { path: '/spec.json' }`.

The document sits behind `src/api/_guard.ts` when there is one, and lists the guards each route runs. Its title is `openapi.title`, else the site's `seo.name`.

Each operation has an `operationId`. It is the one you set in `detail.operationId`, else one built from the method and path, such as `get_notes_id`. A route that answers every method with `.all()` has one operation per method, and the method ends its id, as `echo_get`.

Actions that set `tool` are listed too, as `POST` operations.

<ReadMore href="/llms/api-routes#openapi">How params, bodies and responses are described, and what the document leaves out, are in the full API routes reference.</ReadMore>

## Letting an agent call the app over MCP

Set `mcp: true` in kay.config.ts to let an AI agent use your app. Kay serves an MCP endpoint at `/mcp`, or at the path of `mcp: { path: '/tools' }`, and an agent pointed at it can list and call your tools. You write no MCP server.

### Routes as tools

An API route is a tool only when you say so, with `tool` in its `detail`. The route stays in the OpenAPI document either way, so an internal route, such as a check for your proxy, never reaches an agent by accident.

```ts
export default api()
  .get('/:id', ({ params }) => find(params.id), {
    detail: { tool: 'Read a note by its id' },
  })
```

Here `GET /api/notes/{id}` is the tool `get_notes_id`. Its input is built from the schemas the route already declares. A number is described as a number, and a body or query field with a `default` is not required, as a call that leaves it out gets the default.

Just like an action, `tool: true` keeps the route's own summary as the description, and `tool: { name, description }` sets both. Without a name, the tool takes the route's `detail.operationId`, or its method and path. Anything but letters, digits and `_` in the name becomes `_`.

A route that answers every method with `.all()` becomes one tool per method. A route with `hide: true` is never a tool, and `kay check` warns when it sets `tool` too.

After an upgrade, `kay check` warns of each route that sets neither `tool` nor `hide`, as it was a tool before. Set `tool: false` on the ones no agent should call.

### Actions as tools

An action is a tool only when you say so, with `tool` in its third argument. Setting `mcp` never hands an agent an action such as "delete account".

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

An action in a file whose pages have route params, such as `/notes/[id]`, is not a tool. A call names no page to read the params from. Routes with a file in their body, and actions with a file in their schema, are not offered either, as an agent sends JSON.

### Guards and limits

A call goes through the whole app, as a fetch from a browser would. Guards still guard, rate limits still count the caller, and `ctx.locals` holds what your session code puts there. The caller's `Authorization` header is passed on, so a guard reading a bearer token sees it.

The list of tools sits behind `src/api/_guard.ts`, as the OpenAPI document does. An anonymous caller gets a 401 when that guard refuses them. Calling a name that is not a tool is refused the same way, so names cannot be probed.

Set `requireGuards` to refuse the list unless the guards cover every API module.

A call that is refused is not a protocol error. The agent gets the reason as the tool's result, with the field errors of a schema, and can fix its input and call again.

An agent fills in no form, so `honeypot`, `minTime` and `proofOfWork` do not apply to its calls. `kay check` warns when a tool action has one of them and no guard, because anyone could then call it. Add a guard, or use a `rateLimit`.

### Telling a tool call apart

A tool call reaches your app as a request, with the caller's `Authorization` header. A front guard that only lets a local agent's key through can tell the two apart with `toolCall` from `kay/server`.

```ts
import { guard } from 'kay'
import { toolCall } from 'kay/server'

export default guard(({ request, url, deny }) => {
  const key = request.headers.get('authorization') === `Bearer ${process.env.AGENT_KEY}`

  if (key && url.pathname !== '/mcp' && !toolCall(request))
    deny(403, 'This key opens tools only')
})
```

`toolCall(request)` gives `{ tool, client }` for a call that `/mcp` passed on, and nothing for any other request. A client cannot fake it, so the key still opens nothing else. The check lets `/mcp` through, as the list of tools is guarded as a request to it. In an Elysia hook registered before `pages()`, read `toolCall(request)` the same way inside `.onRequest(({ request }) => ...)`.

### Signing in

When a guard answers 401, the endpoint answers 401 too, with a header telling the agent where to learn how to sign in. A route that answers 401 on its own is only a result for the agent.

With [kayjs-auth](/libraries/kayjs-auth#letting-an-ai-agent-sign-in), that is your own app. The agent opens a consent page in the browser, the user approves it, and the agent gets a token. You write nothing for it.

In a test, `site.mcp.tools()` lists the tools and `site.mcp.call('add_note', { title: 'Milk' })` calls one. See [Testing](/guides/testing).

<ReadMore href="/llms/api-routes#mcp">The protocol details, what a tool leaves out, error shapes and every refusal are in the full API routes reference.</ReadMore>
