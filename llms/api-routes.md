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
import { s } from 'kay'

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
- A response that fails its route's `response` schema is the route's bug, not the caller's: it answers 500 (`Internal Server Error` in production, the schema error in development), is logged and handed to `onError`, even when the module's own `onError` answers it. Refused input stays 422.
- Refused input or a thrown `status()` keeps Elysia's answer, unlogged.
- A route answering a plain object or array holding a bigint, as a database's bigint ids are, gives JSON with each written as its digits, `{"id":"9007199254740993"}`, where `JSON.stringify` would throw.
- `resource()` types such a field as a `string`.
- A route answers a plain object or array as JSON, and a string, a number, a `Date`, a `Response`, a `Blob`, bytes or a stream as Elysia does.
- A class instance without its own `toString`, or a `Map`, such as an ORM row returned as is, answers 500 and is logged with the route and its class, as a throw is, where Elysia would send `[object Object]`.
- A class instance without its own `toString`, or a `Map`, passed to `status()` answers 500 the same way.
- `api()` is a `new Elysia()` whose handlers read the app's locals, typed as `ctx.locals` is (see [Locals](server.md#locals)): `({ user })`, `ws.data.user`.
- A plain `new Elysia()` is mounted the same way.
- A handler, and the `onError` of its module or route, runs in the request's locale as the guards do, so `t()`, `wording()` and `locale()` read it: the locale of the page the call came from by its `Referer`, else the browser's `Accept-Language`, the site's one language without `i18n`. An `eventStream` source is read in it too; a stream of your own `Response` and a websocket's `open` and `message` are not.
- A `_guard.ts` in `src/api/` or below runs before every route of the modules in its directory and below, outermost first, a websocket upgrade included, as it does for pages and actions.
- A body, query or params the route's schema refuses, or a file of the wrong type, meets the guards first, as an action's input does (see [Guards](server.md#guards)): a caller they refuse gets their answer, never the validation error.
- A redirect or a denial from a guard answers the request, and the cookies and headers it sets go out with the route's response.
- A route serving, by its method or `all`, the path of a page, a public file, an endpoint, a redirect or a feed stops the server.
- `kay check` leaves that to the boot, which `kay build` runs, since listing the routes takes running the modules.
- `api({ guards: false })` runs none of the guards above the module, as a public webhook under a guarded directory needs.
- On a site with `requireGuards`, a module no guard covers answers 403 unless it sets `guards: false` (see [Guards](server.md#guards)).
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
- Its answers carry the grant, a body its schema refuses, one that does not parse, or one over its `bodyLimit` included, so the calling page reads why.
- The answers of a module listing origins carry `Vary: Origin`, added to any Vary the route sets.
- An origin is a scheme and a host, a port if any, `capacitor://localhost` for an app's web view included.
- The module's rule alone grants: `Access-Control-Allow-Origin`, `-Allow-Credentials` and `-Expose-Headers` a route sets itself, on `set.headers` or on a `Response` it returns, a `fetch()` result passed on included, are replaced by the rule's, or dropped for an origin it does not list. A route needing another rule goes in a module of its own.
- A module without `cors` answers no preflight and keeps refusing.
- `cors` in kay.config.ts takes the same options and is the rule of every module that sets none, one a library or an extension supplies included; a module setting its own keeps it, and `api({ cors: false })` keeps a module to its own site.

### Limits

- `api({ rateLimit: { max: 60, window: '1m' } })` lets one client send `max` requests to the module's routes every `window`, then answers 429 with `Retry-After` and `Too many requests; try again in N s`.
- A route sets its own in its `detail`, `.post('/send', send, { detail: { rateLimit: { max: 5, window: '1m' }, bodyLimit: '4kb' } })`: counted apart from the module's, which also applies, one limit for every value of a param, a wildcard and an optional segment, and for a route answering every method, `all`, whichever one.
- `rateLimit` takes a list, `key`, `store` and `window` as an action's does (see [Action protection](action-protection.md#rate-limits)).
- It counts after the module's guards, so a caller they refuse costs no allowance and `key: ctx => ctx.locals.user?.id` reads what they and `derive` set; `ctx` also holds `request`, `locale`, `cookies` and `client`.
- A refusal carries the module's `cors` grant, so the calling page reads it.
- `bodyLimit` in a route's `detail` is the most it may be sent, a size or bytes, in place of the module's and the app's; a bigger request answers 413 before it is read.
- A body limit that is no size of a whole number of bytes from 1, or a `max` that is no whole number from 1, stops the server.

### OpenAPI

- `openapi: true` in kay.config.ts serves an OpenAPI 3.1 document of every module's routes at `/api/openapi.json`, read from the schemas they declare.
- Path params are written in braces; `params`, `query` and `headers` are parameters; `body` is JSON, or multipart when it holds an `s.File()`; `response` is one schema or one per status.
- A route's `detail` gives its `summary`, `description`, `tags`, the module's path by default, and `deprecated`.
- `detail: { hide: true }` leaves a route out; websockets are left out.
- A route behind guards lists them in `x-kay-guards`, by where they sit in the API directory, `private/_guard.ts`.
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
- An action that sets `tool` is a `POST` operation at its URL under the tag `actions`, `x-kay-action` set, its guards in `x-kay-guards`, as the document and the MCP tools say the same. It is called as `action()` calls are, its input encoded as kay writes it, not as a plain JSON body.

### MCP

- `mcp: true` serves Streamable HTTP at `/mcp`, or at `mcp: { path: '/tools' }` under the same rules as the OpenAPI paths, its sign-in metadata then at `/.well-known/oauth-protected-resource/tools`: one JSON-RPC message per `POST`, answered with JSON, `initialize`, `ping`, `tools/list` and `tools/call` only, no resources or prompts. `GET` and `DELETE` answer 405, a notification 202.
- A message that is no JSON-RPC request answers 400, a body over `bodyLimit` 413, a request from another site (`Origin`, `Sec-Fetch-Site`) 403.
- A tool per action that sets `tool` and per API route whose `detail` sets `tool`, even with `openapi` off; a route that does not is in the OpenAPI document and no tool: absent from `tools/list`, and a `tools/call` naming it is refused as any unknown name is. Before 1.51 every route not hidden was a tool.
- A route's `detail.tool` is `true`, a description, or `{ name, description }`, as an action's. Its tool is named by `tool.name` else its `operationId` (a route setting only `tool.name` takes it as its `operationId`), made a safe name (`users.list` is `users_list`, a clash `_2`), described by `tool`'s description else its `summary` and `description`, its input one JSON Schema of the path params, query and JSON body, merged by name.
- Left out: `detail: { hide: true }` routes, `tool` or not (`hidden-tool` in `kay check`), websockets, a route whose body is files, text or bytes, an action holding a file, an action in a file whose pages have route params (a post from no page cannot name one), and `in: header` parameters. `tools/list` is served behind the API directory's `_guard.ts` as the document is, and with `requireGuards` it is refused (403) unless the guards cover every module; `initialize` and `ping` stay open, and a call runs the guards of its own route.
- A route answering every method, `.all()`, that sets `tool` is a tool per method; a `tool.name` takes the method as a suffix, `echo_get`.
- An action is a tool only when its third argument sets `tool`: `true`, a description, or `{ name, description }`; its name is the export in snake case, `addNote` is `add_note`, a clash `add_note_2`, and its input schema is the action's as JSON: `s.Integer()` and `s.Numeric()` read as a number, not also as the text a form sends (which a call still takes), and a top-level body or query field with a `default` is left out of `required`, as a call that omits it gets the default.
- A name is made of letters, digits and `_`, at most 64 characters.
- A call is dispatched through the whole app as a fetch to the route's or action's URL would be, so its guards, `rateLimit`, body limit, schema validation and `ctx.locals` are the web path's; `ctx.params` and `ctx.url` of an action are read as for a script's post from no page.
- It carries the caller's `Authorization`, `Cookie`, `Accept-Language` and `User-Agent`, and rate limits count the caller's address as `proxy` reads it, not the server's.
- `toolCall(request)` from `kay/server` answers `{ tool, client }` for a request the endpoint dispatched, `tool` being the tool's name and `client` the address of the agent's client, and `undefined` for any other. It reads a hook registered before `pages()` (`.onRequest`), a guard's `request` and a handler's alike, and a client sending the marker headers itself is no tool call: the marker is a per-process secret. A front guard lets a bearer key reach the tools alone: `if (key && url.pathname !== '/mcp' && !toolCall(request)) deny(403, 'The key opens tools only')`; `/mcp` is let through because `tools/list` runs the API directory's guards as a request to `/mcp`, with no tool call.
- An `onRequest` hook that throws, the app's own Elysia one, a param matcher, `rewrite` or an extension's, is answered like a handler that throws: logged, handed to `onError`, and a 500 with `Internal Server Error` in production, the message in development, instead of Elysia's 200 with the message as the body; a GET asking for HTML gets the routes directory's `_error.kay` (or kay's error page) in the default locale, any other request plain text. A `Response` the hook throws is answered as given, and an `onError` of your own, registered before `pages()`, answers first.
- `honeypot`, `minTime` and `proofOfWork` are skipped, as only a form a person filled in can pass them; a marker only the endpoint sets, a per-process secret no request can send, says so, and `rateLimit` still counts.
- A path param is one segment: it is percent-encoded and an empty one, `.` or `..` is refused, so no value reaches another route.
- A refused call is a result with `isError`: the schema's field errors, the `ctx.fail` data and status as `{ status, errors, data }` JSON, a route's own refusal text, a redirect naming where it leads. The agent corrects and calls again.
- A guard answering 401 makes the endpoint answer 401 with `WWW-Authenticate: Bearer resource_metadata="<site>/.well-known/oauth-protected-resource"`, how a client learns to sign in (kay serves that document, naming the app's authorization server, when kayjs-auth's OAuth server is on: see kayjs-auth's "OAuth server for MCP clients", where an MCP client signs in with no app code); any other refusal, 403 included, is a result. Only a guard's 401 does: a route answering 401 itself is a result too. A refused `tools/list` answers the same way (401 and the pointer, a redirect counting as a 401), as a JSON-RPC error. It keeps the guard's response headers, `Retry-After` of a 429 among them. A `tools/call` of a name no tool has is refused the same way, so names cannot be probed; a call to a tool runs its own guards.
- An action's result is JSON as its text, and `structuredContent` when an object; a route's JSON or text answer likewise, any other type read as its size.
- `/mcp` is claimed like a route: a page, endpoint or file serving it stops the boot, and `kay check` reports it.
- `deprecated-api-tool` warns, with `mcp` and only while `kay upgrade` moves an app from before 1.51, of an API route written with an inline handler on `api()` (imported under any name from `kay/server`, or as `ns.api()`), on a name declared or assigned one, or on a function of the same file returning one whose `detail` sets neither `tool` nor `hide`, as it was a tool before 1.51; `tool: false` says an agent never calls it and silences it; it carries a fix adding `tool: true` that `--fix` does not apply, as that offers every route. `hidden-tool` warns of one setting `hide` and `tool`. A handler or options held in a variable are not read, nor an instance built in another file.
- `unguarded-tool` warns, with `mcp`, of a tool action with a `honeypot`, `minTime` or `proofOfWork` that no guard covers: an agent calls it without the form those protections ask of a person. A `...spread` in the options counts as one of them, so it warns; options that are not an object literal, `action(schema, run, options)`, are not read, so the action is not taken for a tool.
- `site.mcp.tools()` and `site.mcp.call(name, args)` in `kay/test`, which send the cookies so far and take `headers` as `site.call` does.
