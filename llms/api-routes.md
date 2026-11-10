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

### Open a public webhook under a guarded directory

`api({ guards: false })` runs none of the `_guard.ts` files above the module:

```ts
import { api } from 'kay/server'
import { record } from '../data'

export default api({ guards: false })
  .post('/', ({ body }) => record(body))
```

### Guard a route with HTTP Basic

A device that only speaks Basic auth, a tracker say, posts to a directory whose `_guard.ts` is `basicAuth`:

```ts
// src/api/track/_guard.ts
import { basicAuth } from 'kay/server'

export default basicAuth({ user: process.env.TRACKER_USER, password: process.env.TRACKER_PASSWORD, realm: 'tracker' })
```

It answers 401 with `WWW-Authenticate: Basic realm="tracker", charset="UTF-8"` to a request without the right credentials: [Guards](server.md#basic-auth).

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

`mcp: true` in `kay.config.ts` serves an MCP endpoint at `/mcp`, a tool per action and per API route that sets `tool`:

```ts
// kay.config.ts
export default defineConfig({ mcp: true })
```

```kay
--- server
import { s, action } from 'kay'

export const addNote = action(
  s.Object({ title: s.String({ minLength: 3, maxLength: 80 }) }),
  async ({ title }) => ({ title }),
  { tool: 'Create a note' },
)
---
h1 Notes
```

A route opts in the same way, in its `detail`:

```ts
export default api()
  .get('/:id', ({ params }) => find(params.id), { detail: { tool: 'Read a note by its id' } })
```

Point an MCP client at `https://example.com/mcp`. `addNote` is the tool `add_note`; a route is named by its `operationId`, `get_notes_id` for `GET /api/notes/{id}`.

## Reference

### API modules

Each `.ts` module under `src/api/`, the `dirs.api` option of `kay.config.ts` naming another directory, exports an Elysia instance by default, which `pages()` mounts at `/api` plus its path there, with nothing to register: `src/api/chat.ts` serves its routes under `/api/chat`, `src/api/index.ts` under `/api`.

Files and directories starting with `_`, and `.test.ts` files, are left out.

`serve: { apiPath: '/v1' }` in `kay.config.ts` mounts every module, the OpenAPI document and the reference page under `/v1` instead of `/api` (an absolute path of plain segments, no trailing slash, outside `/_kay`; `mcp.path` and the `openapi` paths keep their own), and islands, the service worker's network list, the prefetch rules and the libraries follow it. `apiUrl(module, path, options)` from `kay` gives where a route is served (under `base` in the browser; on the server the module must be mounted, so a page using it renders per request, never prerendered) for code that needs a URL rather than a call (a handler passes its `request` instead of the module, `apiUrl(request, '/image')`, to name a route of the module it runs in, which a reference inside its own chain cannot); a script importing no module reads the `kay-api` meta every page carries once `serve.apiPath` moves it.

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

- A handler, guard or hook that throws is logged and handed to `onError`, answering 500 with `Internal Server Error` in production, its message in development; a module's own `onError` answering it comes first.
- A response that fails its route's `response` schema is the route's bug, not the caller's: it answers 500 (`Internal Server Error` in production), is logged and handed to `onError`, even when the module's own `onError` answers it. Refused input stays 422, as [`{ errors, status }`](api-from-islands.md#refused-input), and a thrown `status()` keeps Elysia's answer, unlogged.
- A route answering a plain object or array holding a bigint, as a database's bigint ids are, gives JSON with each written as its digits, `{"id":"9007199254740993"}`, where `JSON.stringify` would throw.
- `resource()` types such a field as a `string`.
- A string in a route's `body` with no `maxLength`, `enum`, `const` or date format is refused past 10,000 characters, as an action's is (see [actions](actions.md)); declare a `maxLength` on a field that takes more. A model registered by name, another library's validator and a `.ws()` route's messages are left as written.
- A route answering `null` gives the JSON `null` with `content-type: application/json`, which `response.json()` reads, and `undefined` an empty body.
- A route answers a plain object or array as JSON, and a string, `Date`, `Response`, `Blob`, bytes or stream as Elysia does.
- A class instance without its own `toString`, or a `Map`, such as an ORM row returned as is, answers 500 and is logged with the route and its class, as a throw is, where Elysia would send `[object Object]`.
- A class instance without its own `toString`, or a `Map`, passed to `status()` answers 500 the same way.
- On an `api()` chain, a `.ws()` route's refused `body` message is dropped, not answered (see [API from islands](live-values.md#chat-over-a-websocket)).
- A `.ws()` route takes 1 MB a message and 100 messages a second from one socket; a socket over either is closed, with 1009 for a message too big and 1008 for too many. `detail: { messages: { maxSize: '4mb', rateLimit: { max: 30, window: '10s' } } }` sets the route's own, counted per socket in memory. Bun is given the largest `maxSize` of the app's routes as its frame cap (`maxPayloadLength`) unless the app set one, so a bigger frame is dropped before it is buffered.
- One client holds at most 20 open sockets per `.ws()` route, counted by its address (the forwarded one behind a trusted `proxy`) in memory; one past it answers 429. `detail: { messages: { connections: 5 } }` changes it, `false` removes it.
- `api()` is a `new Elysia()` whose handlers read the app's locals, typed as `ctx.locals` ([Locals](server.md#locals)): `({ user })`, `ws.data.user`, `guard`, `once` ([Guards](guards.md)).
- A plain `new Elysia()` is mounted the same way.
- A handler, and the `onError` of its module or route, runs in the request's locale as the guards do, so `t()`, `wording()` and `locale()` read it: the locale of the page the call came from by its `Referer`, else the browser's `Accept-Language`, the site's one language without `i18n`. An `eventStream` source is read in it too; your own `Response` stream and a websocket's `open` and `message` are not.
- A `_guard.ts` in `src/api/` or below runs before every route of the modules in its directory and below, outermost first, a websocket upgrade included, as it does for pages and actions.
- A body, query or params the route's schema refuses, or a file of the wrong type, meets the guards first, as an action's input does ([Guards](guards.md)): a caller they refuse gets their answer, never the validation error.
- A guard's redirect or denial answers the request; the cookies and headers it sets go out with the route's response.
- A route serving, by its method or `all`, the path of a page, a public file, an endpoint, a redirect or a feed stops the server.
- `kay check` leaves that to the boot, which `kay build` runs, since listing the routes takes running the modules.
- Cookies get the `security.cookies` defaults ([Sessions](server.md#sessions)).
- `api({ guards: false })` runs none of the guards above the module, as a public webhook under a guarded directory needs.
- On a site that guards some route, a module no guard covers answers 403 unless it sets `guards: false` ([Guards](guards.md)).
- A library's API modules, laid over `src/api` under a prefix by its extension, serve as if they were the app's, behind its guards, an app module at the same path replacing one (see [Extensions](component-libraries.md#extensions)).
- A websocket upgrade, or a request other than GET, HEAD and OPTIONS, another site's page sends, as its `Origin` or `Sec-Fetch-Site` header shows, is refused with 403 once the guards let it through, since a browser lets any page open a websocket or post a form to any host with the user's cookies.
- A request carrying neither header, such as a webhook, goes through.
- `kay check` checks links and redirects against the modules' GET routes, `/api/chat/rooms` here.
- `kay build --compile` embeds the modules, and `kay build --static` refuses them: a file such as `src/routes/llms.txt.ts` exporting `GET` serves a path a static export writes (see [Endpoint files](routing-endpoints-and-base.md#endpoint-files)).

### CORS

- `api({ cors: { origins: ['https://app.example.com', 'https://*.example.org'] } })` lets the pages of those origins call the module's routes from the browser, `https://*.example.org` standing for any of its subdomains, and `origins: '*'` for any site.
- A preflight `OPTIONS` is answered before the guards run, with the module's methods, the headers asked for, or `headers: [...]` alone, and `Access-Control-Max-Age`, `maxAge`, an hour by default.
- An origin not listed gets no grant.
- Its requests, websocket upgrades included, go through the guards and are not refused, their answers naming the origin, with `expose: [...]` the response headers the page may read.
- `credentials: true` takes the user's cookies as well; without it a request from another site carrying cookies is refused.
- `credentials: true` with `origins: '*'` is a type error `kay check` reports.
- Its answers carry the grant, a body its schema refuses, one that does not parse, or one over its `maxSize` included, so the calling page reads why.
- The answers of a module listing origins carry `Vary: Origin`, added to any Vary the route sets.
- An origin is a scheme and a host, a port if any, `capacitor://localhost` for an app's web view included.
- The module's rule alone grants: `Access-Control-Allow-Origin`, `-Allow-Credentials` and `-Expose-Headers` a route sets itself, on `set.headers` or on a `Response` it returns, a `fetch()` result passed on included, are replaced by the rule's, or dropped for an origin it does not list. A route needing another rule goes in a module of its own.
- A module without `cors` answers no preflight and keeps refusing.
- `cors` in kay.config.ts takes the same options and is the rule of every API module that sets none, a library's or extension's included, and of no endpoint file, which sets `page.cors`; `api({ cors: false })` keeps a module to its own site.

### Limits

- `api({ rateLimit: { max: 60, window: '1m' } })` lets one client send `max` requests to the module's routes every `window`, then answers 429 with `Retry-After` and `Too many requests; try again in N s`.
- A route sets its own in its `detail`, `.post('/send', send, { detail: { rateLimit: { max: 5, window: '1m' }, maxSize: '4kb' } })`: counted apart from the module's, which also applies, one limit for every value of a param, a wildcard and an optional segment, and for a route answering every method, `all`, whichever one.
- `rateLimit` takes a list, `key`, `store` and `window` as an action's does (see [Rate limits](rate-limits.md)).
- It counts after the module's guards, so a caller they refuse costs no allowance and `key: ctx => ctx.locals.user?.id` reads what they and `derive` set; `ctx` also holds `request`, `locale`, `cookies` and `client`.
- A refusal carries the module's `cors` grant, so the calling page reads it.
- `maxSize` in a route's `detail` is the most it may be sent, a size or bytes, in place of the module's and the app's; a bigger request answers 413 before it is read.
- A body limit that is not a whole number of bytes from 1, or a `max` that is not a whole number from 1, stops the server.

### OpenAPI

- `openapi: true` in kay.config.ts serves an OpenAPI 3.1 document of every module's routes at `/api/openapi.json`, read from the schemas they declare.
- Path params are written in braces; `params`, `query` and `headers` are parameters; `body` is JSON, or multipart when it holds an `s.File()`; `response` is one schema or one per status.
- A route's `detail` gives its `summary`, `description`, `tags`, the module's path by default, and `deprecated`.
- `detail: { hide: true }` leaves a route out; websockets are left out.
- A route behind guards is marked `x-kay-guarded: true`, with no guard file named. A document no `_guard.ts` of the API directory protects leaves the guarded routes out, as it is open to anyone; behind a guard it lists all.
- Behind a guard, or after reading the session, an answer goes out `Cache-Control: private, no-cache` with `Vary: cookie`, a refusal included, unless the route sets its own `cache-control`.
- The document is served behind the guards every module runs, the API directory's own `_guard.ts`, a module setting `guards: false` aside, which get the context a module's guard gets, the app's session in `ctx.locals` included, so a private API keeps its spec private.
- `{ title, version }` set its `info`, the site's `seo.name` (the default locale's when it takes one text per locale, as the document is one for every locale) and `1.0.0` by default.
- `{ reference: true }` adds `/api/reference`, a plain HTML page listing each route with what it takes and answers, behind the same guards.
- `{ dev: true }` keeps both to `kay dev`.
- The executable serves them as the server does.
- Without a `_guard.ts` of the API directory itself, the document is public, guarded modules included.
- Schemas are read as TypeBox writes them: a model's name or another library's validator documents nothing.
- An optional param lists the path with and without it, and a wildcard is `{wildcard}`.
- `openapi: { path: '/spec.json', referencePath: '/docs/api' }` moves the document and the reference page; a path is absolute, of plain segments, without a trailing slash and outside `/_kay`, and the two differ.
- A module, page or file serving the document's path, or the reference page's with the page on, stops the server.
- Every operation has an `operationId`: the route's `detail.operationId` as written (`users.list` stays so), else its method and path, `get_notes_id`; a clash gets `_2`. A route answering every method, `.all()`, gets its id with the method as a suffix, `echo_get`, `echo_post`.
- An action that sets `tool` is a `POST` operation at its URL under the tag `actions`, `x-kay-action` set, marked `x-kay-guarded` when guards cover it, as the document and the MCP tools say the same. It is called as `action()` calls are, its input encoded as kay writes it, not as a plain JSON body.

### MCP

The endpoint's settings, tools and errors are in [MCP endpoint](mcp.md).
