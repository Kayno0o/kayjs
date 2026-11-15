# Guards

## Common tasks

- Protect a section of the site, read a guard's value or leave a page public: the tasks of [Locals, sessions and guards](server.md#common-tasks).

## Reference

### Path and guard options

A `path` is one route, a `prefix` a subtree, and every `guards` option takes a guard, a list of guards run in order, or `{ load }` returning one, which runs on the first request so `kay.config.ts` imports nothing of the app's auth. A feature that lists or changes private data is closed with no `guards` and opened by `false`, whatever `guards.default` says; where nothing is guarded by default there is no `false`.

| Option | Reads as | Guard | Without a guard | `false` |
| --- | --- | --- | --- | --- |
| `serve.apiPrefix` | prefix of the API modules, the OpenAPI document and its reference | the API directory's `_guard.ts` | open | no guard option |
| `openapi.path`, `openapi.referencePath`, `mcp.path` | route | the API directory's `_guard.ts` | open | no guard option |
| `ops.health.path`, `ops.metrics.path` | route | none: `metrics` takes a token, `health` is open | open | no guard option |
| `ops.jobs.path`, `ops.jobs.guards` | route | guard, list or `{ load }` | closed, 403 | opens the page |
| `vitals({ prefix, guards })` | prefix | guard, list or `{ load }` | closed, 403 | opens the screen |
| `cms({ prefix, access })` | prefix | role, list, `{ password }`, function or `false` | closed, 403 | admits everyone |
| `assets.images.guards` | before `assets.images.resolve` | guard, list or `{ load }` | closed, 403 | resizes for everyone |
| `extension.routes`, `extension.api` `prefix` | prefix | the library's own guards | as the library says | no guard option |
| `page = { guards }`, `api({ guards })` | one page, endpoint or API module | guard, list or `{ load }`, run after the guards above it | under the guards above it | skips them |

### Guards

- A `_guard.ts` in a routes directory runs before every page and every action in that directory and below, outermost first.
- It lets the request through unless it redirects or denies.
- Its `ctx` is the request context every kind of route shares (see routing, "The request context"): `request`, `url`, `locale`, `params`, `cookies`, `locals`, `headers`, `redirect`, `notFound` and `deny`; cookies and headers it sets reach the response either way.
- Its `url` is spelled one way whatever the request sent: each segment decoded, then written as `new URL` writes it, leading slashes collapsed, so `/%61dmin/x` and `//admin/x` read as `/admin/x`, as `ctx.params` reads them, while `/@admin` stays `/@admin`; a segment with a malformed escape stays as sent, and so does the page's own URL.
- A page or an action has its trailing slash as `trailingSlash` writes it; an API route, an endpoint or an image keeps the one sent.
- `ctx.params` holds the params of the page asked for, each matcher's value in place of its text: `src/routes/orgs/[org]/_guard.ts` reads `params.org`.
- They are typed `Readonly<Record<string, unknown>>`, since a guard covers every route below it.
- For an action they are those of the page it was posted from, which the action reads in its own `ctx.params` (see actions).
- An action's guards read that page as `url`, as a visit to it reaches them, never the action's own: without `base`, in its locale's translated path, its trailing slash as `trailingSlash` writes it, or as sent under `ignore`, `/%61dmin/` read as `/admin`.
- A root guard testing `url.pathname.startsWith('/admin')` thus covers the actions of `/admin`, and of any file whose pages all sit under it; a file serving pages on either side, a layout or a catch-all, is posted from the one the caller names.
- A post naming no page of the action's file, such as from a script, has the file's shortest page without params as its `url`, else its first page with each param named, `/orgs/:org`, and is refused when the file reads params.
- For a module under `src/api/`, they are those of the route the request matched, as its handler reads them.
- Checks on one record still belong in the load and the action.
- A guard may return an object: `export default guard(async ({ params, deny }) => { const org = await loadOrg(params.org); return org ? { org } : deny(404) })`. Every guard below it, the layouts, the page and its actions read it as `ctx.guard.org`, so nothing loads the org again.
- The objects of the guards are merged outermost first, a guard below winning a key it shares, and each guard reads what the ones above returned in its own `ctx.guard`. Only a plain object counts: anything else a guard returns is ignored, and a page with `guards: false` has an empty `ctx.guard`.
- `kay check` types `ctx.guard` of a page, a layout and the actions of a page or a layout from the `_guard.ts` files above it, as what each default export returns; a field no guard returns is a type error. It is per request and never shared between visitors. A prerendered page has none (`ctx.guard` is a type error there), since its guards run when the page is served.
- A layout's actions are typed like a page's, a layout with a `guards: false` page under it is not. An endpoint file's `ctx: EndpointContext` and an API module's `api()` are typed the same way in `kay check`, which checks a shadow of the file typed from its params, the `_guard.ts` files above it and its `page.query` (a param or a field no guard returns is a type error, and the guard is `any` once the file lists `guards` of its own); an API route also types what its own `guards` return from the option, `api({ guards: [needsKey] })`. Writing the context out, `EndpointContext<{ slug: string }, { org: Org }>` or `api<{ org: Org }>()`, still works and is held to the file tree for an endpoint; the editor's TypeScript server, which reads the plain file, types a handler only from what is written. Its handler reads `({ guard, once })`, empty in the module's own `derive` and `resolve`, which run before its guards.
- `ctx.once(key, load)` runs `load` the first time the request asks for `key` and gives every later ask the same promise, so loads running at once (a layout and its page, a guard and an action) share one: `const org = await ctx.once(`org:${params.org}`, () => loadOrg(params.org))`. It lives as long as the request, a failure is shared too, and `cached` stays the memo for data shared between visitors. Use a guard's return for what everything below needs, `ctx.once` for a load several parallel loads may start.
- An action's guards run once its input is valid, when the app's `resolve` values are there.
- A cross-site post, a refusal of the action's protection (`rateLimit`, `honeypot`, `minTime`, `proofOfWork`), a body over `maxSize`, one that does not parse, and an action posted from no page of its file answer before any guard runs.
- Input the schema refuses, or a file of the wrong type, meets the guards first, so a caller they refuse gets their redirect or denial, never the field errors or the values sent back; a caller they let through gets the field errors, without reaching the handler.
- On that path only what the app derives is in `ctx.locals`, `resolve` running after the schema: a guard reading a user the app resolves refuses a signed-in caller there, so read the user from what the app derives, such as the session `session()` derives. A guard throwing there answers 500 and is reported, as on valid input, never with the field errors.
- A refused form post gets the redirect, or the denial as plain text.
- A denied page renders the nearest page of its status (`_403.kay`, else `_error.kay`) outside the guard's directory, inside the layouts outside it, so nothing the guard protects renders.
- A layout's `ctx.redirect` is no guard: actions never run layout loads.
- Neither is an Elysia `onBeforeHandle` testing the page's path: actions are served under `/_kay/action/`.
- One rule for every route: `guards: false` runs none of the guards above it, and a guard, a list or `{ load }` runs after them, outermost first. A route's own guards are the last of its chain.
- `export const page = { guards: false }` runs none of the guards above a page or its actions, a sign-in page under a root guard asking for a session; in a layout, none above its actions; in an endpoint, none above it. An API module does so with `api({ guards: false })`.
- `export const page = { guards: [needsKey] }` adds `needsKey` after the `_guard.ts` files above a page and its actions, an endpoint, or a layout's own actions (the pages under a layout keep the guards above them); an API module does so with `api({ guards: [needsKey] })`. The module is imported when the first request asks, and the list is read from it as written there.
- Each guard of the list reads what the ones before it returned in its own `ctx.guard`, and what they return is read by the page, its layouts and its actions as the files' is. `kay check` does not type it: a field only a route's own guard returns is a type error on `ctx.guard`, unless the handler names it, as `api({ guards: [orgGuard] })` does by reading it off the option.
- A route with guards of its own is covered: `unguarded-route` and `guards.default` leave it out, and `kay build --static` refuses to write it, as for one a `_guard.ts` covers.
- `false` is read from the source as written, as `layouts: false` is, so `kay check` and `kay dev` report a `guards` set to `(false)`, `!open`, `false || open`, a method, a getter, and a `layouts` or a spread held in a variable or an expression, rather than ignore it. A variable holding `false` is no guard: the route answers 500 when asked, naming the file. Guards the source does not show where kay reads them, in a `page` typed `: PageSettings` or an `api(options)` call holding a variable, stop the boot or answer 500 and a static export refuses them, never serve the route with none.
- `guards: { default }` left unset, on a site with at least one guard of its own, answers 403 for each page, endpoint or API module of the app that no guard covers (a library's routes, layouts and action modules excepted), and `kay check` reports each as an `unguarded-route` error; a site with no guard at all stays open, and `default: 'open'` keeps a site that mixes them open.
- `guards: { default: 'closed' }` in kay.config.ts (`requireGuards: true` until 1.108) fails closed everywhere, a layout's and an `_actions.kay`'s actions included: every page, action, endpoint and API module of the app that no guard covers and that does not set `guards: false` answers 403, the OpenAPI document too unless a guard covers every module not setting `guards: false`, and `kay build --static` refuses to write such a page or endpoint.
- A layout a library mounts asks no guard of its actions, which still run the guards above it, and the OpenAPI document is served when every module is open.
- `kay check` reports each one as `unguarded-route`.
- A library's routes keep the guards it gives them.
