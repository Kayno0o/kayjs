# Pages and routing

## Common tasks

### Add a page with a param

A file in `src/routes/` is a page, `[id]` in its name a param read as `ctx.params.id`, and the server fence runs per request:

```kay
--- server
import { findTodo } from '../../data'

const id = Number(ctx.params.id)
const todo = await findTodo(id) ?? ctx.notFound()
---
h1 {todo.title}
p.status {todo.done ? 'Done' : 'Open'}
```

### Read a query param

The `query` key of `page` is the schema `ctx.query` is read against, so `ctx.query.page` is a `number | undefined`:

```kay
--- server
import { s } from 'kay'

export const page = { query: s.Object({ q: s.String(), page: s.Optional(s.Integer()) }) }

const { q, page: current } = ctx.query
---
h1 Results for {q}
p Page {current ?? 1}
```

### Redirect, deny or 404 from a page

`ctx.redirect`, `ctx.notFound()` and `ctx.deny` stop rendering, and `localPath` keeps a `?next=` param on this site:

```kay
--- server
import { localPath, s } from 'kay'

export const page = { query: s.Object({ next: s.Optional(s.String()) }) }

if (ctx.params.id === 'latest') ctx.redirect(localPath(ctx.query.next, '/todos/42'))
if (ctx.params.id === 'secret') ctx.deny(403, 'Members only')
---
h1 Todo {ctx.params.id}
```

### The request context

`RequestContext` from `kay` is what a page, a layout, a guard (`GuardContext`), an endpoint (`EndpointContext`) and an action (`ActionContext`) all read, the same in each:

- `request`, `url`, `locale`, `params`, `cookies`, `locals` and `headers`, read as in a page.
- `redirect(location, status?)`, `notFound()` and `deny(status?, message?)`, which throw, written `return redirect(...)` in a guard, an endpoint or an action handler so TypeScript narrows what follows, and as a statement in a page fence; `redirect` answers 302 to a read and 303 to a post unless given a status.
- A page adds `query`, `status`, `failed` and `succeeded`, an action `status` and `fail`; an API route reads Elysia's own context, its guards this one.
- `params` is the route's, matched as a guard reads them, an action's those of the page it was posted from, and `locale` is the site's `lang` without `i18n` in all of them.

### Show an error page

`_error.kay` renders when a load or render throws, and `ctx.error` holds `status` and `message`:

```kay
--- server
const { status, message } = ctx.error
---
h1 Error {status}
p {message}
```

### Drop the layouts above a page

`_layout.kay` wraps the pages of its directory and below, rendering the page at its `slot`, and a page whose `page` has `layouts: false` is wrapped by none of them:

```kay
--- server
export const page = { layouts: false }
---
h1 No site header here
```

### Serve a JSON or text file

A `.ts` file in `src/routes/` with an extension before `.ts` serves that path with what its `GET` returns:

```ts
// src/routes/feeds/[slug].json.ts
import type { EndpointContext } from 'kay'
import { feedOf } from '../../data'

export const page = { prerender: [{ slug: 'news' }, { slug: 'releases' }] }

export function GET({ params }: EndpointContext<{ slug: string }>) {
  return Response.json(feedOf(params.slug))
}
```

### Redirect old paths

`redirects` in kay.config.ts sends old paths elsewhere, with a 308, a 307 when `permanent` is false, or the status `status` names, 301, 302, 307 or 308, for older clients and crawlers that expect a 301:

```ts
export default defineConfig({
  redirects: {
    '/blog/:slug': '/posts/:slug',
    '/docs/*': '/guide/*',
    '/sale': { to: 'https://shop.example.com/sale', permanent: false },
    '/old': { to: '/new', status: 301 },
  },
})
```

## Reference

### Pages and routing

Pages live in `src/routes/`:

| File | URL |
| --- | --- |
| `index.kay` | `/` |
| `about.kay` | `/about` |
| `todos/[id].kay` | `/todos/:id`, read as `ctx.params.id` |
| `docs/[...path].kay` | `/docs/*`, read as `ctx.params.path` |
| `blog/[[page]].kay` | `/blog` and `/blog/:page`, `ctx.params.page` a `string \| undefined` |
| `items/[id=integer].kay` | `/items/:id` where the matcher `integer` takes the segment, `ctx.params.id` the `number` it returns |
| `(marketing)/pricing.kay` | `/pricing`: a group, in parentheses, adds nothing to the URL, only its `_layout.kay` and `_guard.ts` |
| `_layout.kay` | Wraps every page in its directory and below, outermost first, rendering the page at its `slot`. |
| `_actions.kay` | A server fence of actions and no template, served behind the guards of its directory and above, which pages and components import by path; see [Actions](actions.md#declaring-an-action). |
| `_404.kay` | Rendered with status 404 for `ctx.notFound()` in its directory and below; the root one also answers URLs no page serves. |
| `_error.kay` | Rendered with status 500 when a load or render throws, and for 404s with no `_404.kay`. |
| `_guard.ts` | Runs before every page and every action in its directory and below; see [Guards](server.md#guards). |

- Where two pages match a URL, the first segment telling them apart decides: static wins over a param, a param over a catch-all, so `/docs/intro` goes to `docs/[...path].kay` before `[section]/[page].kay`, and `/_kay/` stays kay's own files.
- That holds over a listening server as through `app.handle()`, and the same goes for every route ending in `*`, a redirect's, an API module's or the app's own, against a page of params.
- An app that passes `.use()` a promise, as `.use(import('./admin'))`, gets that once Elysia loaded it, so a request in the moment after `listen()` may still reach the page of params.
- A page URL ending in a slash redirects with 308 to the one without, query kept: `/about/` to `/about`.
- `trailingSlash` in kay.config.ts, `'never'` by default, changes that: `'always'` redirects `/about` to `/about/` instead, `'ignore'` serves both.

#### Matchers

- A matcher checks a param, `[name=matcher]` or `[[name=matcher]]`: it returns the value `ctx.params` hands the page, typed as it returns it, or `undefined` to refuse the URL.
- kay ships `integer`, `uuid` and `slug` in `kay/params`: a safe whole number, as a number, a UUID, lowercased, and lowercase words joined by dashes.
- A project adds its own as `src/params/<name>.ts`, beside `src/routes/`, its default export the matcher, and one of that name wins over kay's.
- A matcher nobody provides stops the server.

```ts
// src/params/even.ts
export default (value: string) =>
  Number(value) % 2 === 0 ? Number(value) : undefined
```

- A URL a matcher refuses falls through to the page without one serving the same path, `items/[slug].kay` beside `items/[id=integer].kay`, and is a 404 when none does.
- Several pages with matchers on one path are tried in the order of their file paths, by UTF-16 code unit, so `(Site)/` before `(admin)/`.
- Two pages serving one path, neither with a matcher, stop the server, whatever they name their params: `todos/[id].kay` and `todos/[slug].kay`, `blog/index.kay` and `blog/[[page]].kay`, `about.kay` and `(site)/about.kay`.
- A `prerender` list leaves an optional param out to prerender the path without it, and an entry a matcher refuses fails the build.

#### Page settings

- A page's settings are the keys of one object its server fence exports, `export const page = { prerender: true, revalidate: '1h' }`.
- `kay` exports the type `PageSettings`, which `kay check` types the object by (`satisfies PageSettings`): the editor completes the keys and an unknown one is a type error.
- kay reads the object as written, a literal with no spread, computed key or method.
- A layout takes `layouts`, `query`, `security`, `reload`, `noindex`, `revalidate` and `search`, all but `layouts` and `query` applying to every page under it (for `noindex`, `revalidate` and `search` the innermost layout or page that sets one wins, so a page's `noindex: false` undoes its layout's), and `guards: false`, which opens its own actions alone, the pages under it keeping their guards.
- `query` on a special page is reported; a layout sets it like a page does (see `ctx.query`).
- A setting exported under its own name, `export const prerender = true` or `export async function prerender()`, is a compile error.
- `kay check --fix` moves it into `page`, a function as an arrow, unless the fence names a value `page` itself or reads the setting.

| Key | Value | Detailed in |
| --- | --- | --- |
| `prerender` | `true`, `false`, a list of params, a function returning one, a content collection or `paginate()` | [Prerendering](prerendering.md#prerendering) |
| `keep` | `true` to say the build is to keep the page prerendered on its own, `unkept-page` naming what stops it | [Prerendering](prerendering.md#prerendering) |
| `revalidate` | a `Duration`, how old a prerendered page gets before it is rendered again | [Prerendering](prerendering.md#prerendering) |
| `layouts` | `false` only, to drop the layouts above | this section |
| `query` | a schema `ctx.query` is read against | `ctx.query`, below |
| `sitemap` | what `prerender` takes, or `false` | [Head and SEO](head.md) |
| `lastmod` | a `Date`, a date string or a function of each listed URL's params returning one, for the sitemap's `<lastmod>` | [Sitemap](sitemap-search-fonts.md#sitemap-and-robotstxt) |
| `noindex` | `true` to keep the page from search engines and the sitemap | [Head and SEO](head.md) |
| `guards` | `false` only, to run none of the `_guard.ts` files above; on a layout, above its actions alone | [Server](server.md) |
| `security` | `{ csp, headers }` added to the site's security headers for the page's responses | [Production](proxy-and-security.md#security-headers) |
| `reload` | `true` to load the page fully from any link or form, past the page swap | [Islands](islands.md) |
| `search` | `false` to leave the page out of the site search, `{ weight }` to scale what its words count, or a function of the params of each page returning either (nothing means weight 1) | [Head](sitemap-search-fonts.md#site-search) |

- A page or a layout whose `page` has `layouts: false` among its keys is wrapped by none of the layouts above it.
- `export const page = { layouts: false }` gives a page none at all, a layout starts the chain afresh, so a section can drop the site's header.

#### The server fence

- Other files starting with `_` are not routes.
- Every top-level name the server fence declares reaches the template, typed.
- The fence runs per request and may use top-level `await` and the `ctx` object, except what an export such as an action reads: that runs once, when the module loads, so it may neither await nor read `ctx`, which `kay check` reports.

The fence's `ctx`:

- `ctx.params`, typed from the file name, `ctx.url`, `ctx.request`
- `ctx.query`, the search params, read against the schema the page sets as the `query` key of `page`: `export const page = { query: s.Object({ q: s.String(), page: s.Optional(s.Integer()) }) }` types `ctx.query.page` as a `number | undefined`.
  - Each is read as a form field is (a number from decimal text, a list from a repeated name, `true` from `on`), one left out takes its `default`, and a query the schema refuses renders `_error.kay` with status 400, once the guards let the request through.
  - A layout declares the params it reads the same way, in its own `page`, and the pages under it do not repeat the schema: `ctx.query` is read once against every `query` of the route's layouts and its page merged, so a layout and its page see the same typed values.
  - A layout's `ctx.query` is typed by the layouts above it and its own, a page's by every layout above it and its own.
  - A name two of them declare is accepted when their schemas are the same, and refused when they differ: `kay check` reports it on the later file for schemas written inline as `s.Object({ ... })`, and the render fails for any other. The merged schema takes its object keywords, such as `additionalProperties`, from the innermost file.
  - A page with `layouts: false` reads none of the dropped layouts' params. `query` on a special page is reported, "Only a page or a layout declares its query".
  - Without a schema each name reads as its text, a repeated one as a list, typed `unknown`; the raw text is `ctx.url.searchParams`.
  - An island reads and writes one param the same way with `queryParam` (see islands).
- `ctx.cookies`, a `Bun.CookieMap`: `ctx.cookies.get('theme')`; what `set` and `delete` change is sent back, redirects included
- `ctx.locals`, what the app's Elysia `derive`, `resolve` and `decorate` add, such as the signed-in user
- `ctx.status(404)` and `ctx.headers` set the response. A page rendered per request behind any guard, or whose loads or render read the session, `ctx.cookies`, a cookie `persisted` signal or how a form post went, goes out as `Cache-Control: private, no-cache` with `Vary: cookie`, so a CDN never hands one visitor's page to another, redirects included, unless `ctx.headers` sets a `cache-control` of its own; what an `await` block reads once the page started streaming comes too late to count
- `ctx.redirect('/login')`, `ctx.notFound()` and `ctx.deny(403, 'Members only')` stop rendering; `deny` renders `_error.kay` with that status and message
- They throw and return `never`: `return` it in a function, a guard, an endpoint or an action handler, which a call through a contextually typed `ctx` needs for TypeScript to narrow what follows, and write a plain statement at the top of a page or layout fence; `redirect` answers 302 to a read and 303 to a post unless given a status
- `ctx.redirect` goes to any full http(s) URL, but a path a browser reads as another host (`//other.example/`, `/\other.example`) is a server error. A `?next=` param goes through `localPath(value, fallback)` from `kay`, which gives `value` when it is a path of this site and `fallback` otherwise: `ctx.redirect(localPath(ctx.query.next, '/account'))`. The path comes back resolved; a backslash, a control character, a path that leaves the site once decoded at any depth (`/%2F/evil.example`, `/%252F/evil.example`) or a malformed escape gives `fallback`.
  - `https://evil.example`, `//evil.example`, `/\evil.example` and a value that is no string all fall back.
  - `fallback` is checked as a link.

#### Loads and timing

- Layout and page loads run in parallel; when several fail, the outermost one decides the response.
- In development each response carries a `Server-Timing` header with the time of the guards, the import of the page's modules, the loads as a whole and each of them, and the render, shown in the browser's network panel.
- `serverTiming: true` in kay.config.ts sends it in production too (see [Tracing and timing](production.md#tracing-and-timing)).

#### Special pages

- The nearest special page wins, wrapped by the layouts of its own directory.
- `_error.kay` reads `ctx.error`: `status`, `message` and, in development only, `stack`.
- Logged and displayed stacks point at `.kay` lines.
- In production the message is generic and the real error goes to `console.error`.
- Without an `_error.kay` the response is plain text, and development shows an error page with the stack instead, its frames opening in the editor under `kay dev`.

```kay
--- server
const { status, message } = ctx.error
---
h1 Error {status}
p {message}
```

```kay
--- server
import { findTodo } from '../../data'

const id = Number(ctx.params.id)
const todo = await findTodo(id) ?? ctx.notFound()
---
h1 {todo.title}
p.status {todo.done ? 'Done' : 'Open'}
```

#### Error reporting

- Each error kay logs while answering a request, from a load, a render, a guard, an action, an API route, an `onRequest` hook, a param matcher, `rewrite`, a streamed block without `catch` or a `try` block's, also goes to the `onError` option of `kay.config.ts` or `pages()`, the place to send it to an error tracker.
- The response does not wait for a promise it returns, and an error it throws is logged.
- An error met outside any request, in a `schedule`, `background` or queue job that ran out of attempts, or an `onStop` hook, goes to `onError` too, with `undefined` for the request, and kay waits 10 seconds at most for it, so a tracker that hangs holds neither a queue worker nor a shutdown.
- An island's error reaches it as a `BrowserError` (see [Error fallbacks](islands.md#error-fallbacks)).
- `request.url` keeps its query, which may hold an address or a token, so a tracker is sent its path:

```ts
import { defineConfig, requestId } from 'kay/server'

export default defineConfig({
  onError: (error, request) => tracker.capture(error, request && { path: new URL(request.url).pathname, id: requestId(request) }),
})
```
