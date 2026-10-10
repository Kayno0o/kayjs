# Pages and routing

## Pages and routing

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
| `_404.kay` | Rendered with status 404 for `ctx.notFound()` in its directory and below; the root one also answers URLs no page serves. |
| `_error.kay` | Rendered with status 500 when a load or render throws, and for 404s with no `_404.kay`. |
| `_guard.ts` | Runs before every page and every action in its directory and below; see [Guards](server.md#guards). |

A page URL ending in a slash redirects with 308 to the one without, query kept: `/about/` to `/about`. `trailingSlash` in kay.config.ts changes that: `'always'` redirects `/about` to `/about/` instead, `'ignore'` serves both.

A matcher checks a param, `[name=matcher]` or `[[name=matcher]]`: it returns the value `ctx.params` hands the page, typed as it returns it, or `undefined` to refuse the URL. kay ships `integer`, `uuid` and `slug` in `kay/params`: a safe whole number, as a number, a UUID, lowercased, and lowercase words joined by dashes; a project adds its own as `src/params/<name>.ts`, beside `src/routes/`, its default export the matcher, and one of that name wins over kay's. A matcher nobody provides stops the server.

```ts
// src/params/even.ts
export default (value: string) =>
  Number(value) % 2 === 0 ? Number(value) : undefined
```

A URL a matcher refuses falls through to the page without one serving the same path, `items/[slug].kay` beside `items/[id=integer].kay`, and is a 404 when none does; several pages with matchers on one path are tried in the order of their file paths. Two pages serving one path, neither with a matcher, stop the server, whatever they name their params: `todos/[id].kay` and `todos/[slug].kay`, `blog/index.kay` and `blog/[[page]].kay`, `about.kay` and `(site)/about.kay`. A `prerender` list leaves an optional param out to prerender the path without it, and an entry a matcher refuses fails the build.

A page's settings are the keys of one object its server fence exports, `export const page = { prerender: true, revalidate: '1h' }`. `kay` exports the type `PageSettings`, which `kay check` types the object by (`satisfies PageSettings`): the editor completes the keys and an unknown one is a type error. Kay reads the object as written, a literal with no spread, computed key or method. A layout takes `layouts` alone, and `query` on a layout or a special page is reported. The separate exports (`export const prerender = true` and the like) still work but are deprecated: the lint `deprecated-page-export` reports each, `kay check --fix` moves them into `page` unless the fence names a value `page` itself or reads the setting, and a later minor removes them.

| Key | Value | Detailed in |
| --- | --- | --- |
| `prerender` | `true`, `false`, a list of params, a function returning one, a content collection or `paginate()` | [Prerendering](#prerendering) |
| `revalidate` | a `Duration`, how old a prerendered page gets before it is rendered again | [Prerendering](#prerendering) |
| `layouts` | `false` only, to drop the layouts above | this section |
| `query` | a schema `ctx.query` is read against | `ctx.query`, below |
| `sitemap` | what `prerender` takes, or `false` | [Head and SEO](head.md) |
| `noindex` | `true` to keep the page from search engines and the sitemap | [Head and SEO](head.md) |

A page or a layout whose `page` has `layouts: false` among its keys is wrapped by none of the layouts above it: `export const page = { layouts: false }` gives a page none at all, a layout starts the chain afresh, so a section can drop the site's header. The old `export const layouts = false` still reads, deprecated.

Other files starting with `_` are not routes. Every top-level name the server fence declares reaches the template, typed. The fence runs per request and may use top-level `await` and the `ctx` object, except what an export such as an action reads: that runs once, when the module loads, so it may neither await nor read `ctx`, which `kay check` reports. The fence's `ctx`:

- `ctx.params`, typed from the file name, `ctx.url`, `ctx.request`
- `ctx.query`, the search params, read against the schema the page sets as the `query` key of `page`: `export const page = { query: s.Object({ q: s.String(), page: s.Optional(s.Integer()) }) }` types `ctx.query.page` as a `number | undefined`. Each is read as a form field is (a number from decimal text, a list from a repeated name, `true` from `on`), one left out takes its `default`, and a query the schema refuses renders `_error.kay` with status 400, once the guards let the request through. Layouts read the page's, and declare none of their own: `query` on a layout or a special page is reported, "Only a page declares its query". Without a schema each name reads as its text, a repeated one as a list, typed `unknown`; the raw text is `ctx.url.searchParams`. An island reads and writes one param the same way with `queryParam` (see islands).
- `ctx.cookies`, a `Bun.CookieMap`: `ctx.cookies.get('theme')`; what `set` and `delete` change is sent back, redirects included
- `ctx.locals`, what the app's Elysia `derive`, `resolve` and `decorate` add, such as the signed-in user
- `ctx.status(404)` and `ctx.headers` set the response
- `ctx.redirect('/login')`, `ctx.notFound()` and `ctx.deny(403, 'Members only')` stop rendering; `deny` renders `_error.kay` with that status and message
- `ctx.redirect` goes to any http(s) URL it is given, so a `?next=` param goes through `localPath(value, fallback)` from `kay`, which gives `value` when it is a path of this site and `fallback` otherwise: `ctx.redirect(localPath(ctx.query.next, '/account'))`. `https://evil.example`, `//evil.example`, `/\evil.example` and a value that is no string all fall back; `fallback` is checked as a link.

Layout and page loads run in parallel; when several fail, the outermost one decides the response. In development each response carries a `Server-Timing` header with the time of every load and of the render, shown in the browser's network panel; `serverTiming: true` in kay.config.ts sends it in production too (see [Tracing and timing](production.md#tracing-and-timing)).

The nearest special page wins, wrapped by the layouts of its own directory. `_error.kay` reads `ctx.error`: `status`, `message` and, in development only, `stack`. Logged and displayed stacks point at `.kay` lines. In production the message is generic and the real error goes to `console.error`; without an `_error.kay` the response is plain text, and development shows the stack instead.

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

Each error kay logs while answering a request, from a load, a render, a guard, an action, an API route, a streamed block without `catch` or a `try` block's, also goes to the `onError` option of `kay.config.ts` or `pages()`, the place to send it to an error tracker. The response does not wait for a promise it returns, and an error it throws is logged:

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  onError: (error, request) => tracker.capture(error, { url: request.url }),
})
```

## Endpoint files

A `.ts` file in `src/routes/` whose name carries an extension before `.ts` serves that path with what its `GET` returns, such as an `llms.txt` or a JSON feed, without an API module:

```ts
// src/routes/feeds/[slug].json.ts
import type { EndpointContext } from 'kay'
import { feedOf } from '../../data'

export const page = { prerender: [{ slug: 'news' }, { slug: 'releases' }] }

export function GET({ params }: EndpointContext<{ slug: string }>) {
  return Response.json(feedOf(params.slug))
}
```

| File | URL |
| --- | --- |
| `llms.txt.ts` | `/llms.txt` |
| `feeds/[slug].json.ts` | `/feeds/:slug.json`, read as `params.slug` |
| `exports/[year]/report.csv.ts` | `/exports/:year/report.csv` |

- `GET(ctx)` takes an `EndpointContext`: `request`, `url`, `params` and `locals`, as a page's `ctx` has them. It returns a string, a `Blob` or a `Response`, or a promise of one: a string is sent as the type its extension names, `text/plain` for `.txt`, in UTF-8, a Blob with its own type or else that one, and a Response as it is, its status and headers included. A handler that throws answers 500 and goes to `onError`.
- The `_guard.ts` files above an endpoint run before it, as they do for a page: a redirect or a denial answers, and the cookies and headers they set go out with its answer.
- A param is a plain `[name]` segment, the extension of the last one written after its brackets, `[slug].json`; a rest, an optional or a matcher param stops the server. Endpoints whose paths only differ by that extension share the path, `feeds/[slug].json.ts` beside `feeds/[name].xml.ts`, but a page cannot share one with an endpoint, `posts/[slug].kay` beside `posts/[slug].json.ts`, as the router reads both as `/posts/:slug`: move one, `posts/[slug]/feed.json.ts`.
- An endpoint serving a page's path, another endpoint's or a public file's stops the server, which `kay check` reports. Locale prefixes and layouts leave endpoints alone, and the sitemap lists none.
- A `.ts` file without an extension before `.ts`, `format.ts`, stays a helper, as do `.test.ts` and `.d.ts` files.
- `kay check` checks links to endpoints, `a(href="/feeds/news.json")`, and that each exports a `GET` returning one of those; `kay build --compile` embeds them, and `kay build --static` writes each to its path: one without params as it is, one with params for each set of values `export const page = { prerender: [...] }` lists, as a page does.

## Prerendering

A page whose `page` has `prerender: true` is rendered once by `kay build`, its loads included, and served from that file in production, revalidated by its ETag. Its guards still run on every request. It renders without a request, so reading `ctx.cookies`, `ctx.query` or `ctx.locals` in its server fence is reported by `kay check`, and in a layout fails the build, and `ctx.failed` and `ctx.succeeded` return `undefined`; `ctx.url` is `http://localhost` plus its path. A refused form post, and a request carrying the cookie a plain form post that went through leaves, as the browser coming back from one does, get it rendered for that request instead, with how the post went, as `Cache-Control: private, no-store` and no ETag; the next request gets the file again. Development renders it per request like any other.

A route taking params lists the ones to render instead, as an array or a function returning one; any other path renders per request:

```kay
--- server
import { findPost, listPosts } from '../../data'

export const page = {
  prerender: async () => (await listPosts()).map(post => ({ slug: post.slug })),
}

const post = await findPost(ctx.params.slug) ?? ctx.notFound()
---
h1 {post.title}
```

Each value is a string with no empty, `.` or `..` segment, a catch-all's included with its slashes. `prerender: false` prerenders nothing. A list `paginate()` from `kay/content` split lists each of its pages, for a page whose one param is optional, `blog/[[page=integer]].kay` (see content).

`revalidate: '1h'` beside `prerender` in `page` keeps a prerendered page fresh: once it is older than that, seconds or a string such as `'1h'`, the next request still gets it as it is, and starts rendering it again in the background, the way `kay build` does; every request after that render lands gets the new page, with a new ETag and compressed copies. One render runs at a time per path. A render that fails or answers 5xx is logged and leaves the page as it was, the next attempt coming a minute later at most. The new page lives in memory, so a restart serves the built file again until it goes stale; an executable built a while ago revalidates on its first request.

An action or an API route that changed what a prerendered page shows calls `invalidatePage` from `kay/server`, and the next request for it waits for a fresh render rather than getting it as it was, whether or not the page has a `revalidate` period:

```ts
import { invalidatePage } from 'kay/server'

invalidatePage('/blog/hello')
invalidatePage(path => path.startsWith('/blog/'))
```

- The path is the one the routes serve, without the base, a locale's page under its segment, `/fr/blog/hello`. Requests arriving while the render runs wait for the same one; a render that fails or answers 5xx is logged, leaves the page as it was, and no request waits on another before a minute has passed.
- Processes sharing a `sqliteCache` (see [Caching](rendering.md#caching)) mark the same pages within about half a second: a path given as it is reaches them all, a function the paths it matched in this process, which serves the same build.

### Page hooks

An extension listed in `extensions` in kay.config.ts can carry `transformPage`, which gets each prerendered page as it is about to be written and returns the HTML to write instead, as a footer giving the page's own weight needs:

```ts
import type { KayExtension } from 'kay/server'
import { promisify } from 'node:util'
import { brotliCompress } from 'node:zlib'

const LINK = /(?:href|src)="([^"]+)"/g
const brotli = promisify(brotliCompress)

export const pageWeight: KayExtension = {
  name: 'page-weight',
  async transformPage({ html, file }) {
    const files = await Promise.all([...html.matchAll(LINK)].map(async ([, url]) => file(url!)))
    const linked = await Promise.all(files.filter(found => found !== undefined).map(async found => (await brotli(await Bun.file(found).bytes())).length))
    const bytes = (await brotli(html)).length + linked.reduce((sum, size) => sum + size, 0)

    return html.replace('<!--weight-->', `${Math.round(bytes / 1024)} KB`)
  },
}
```

- It runs in `kay build`, `--static` included, the `404.html` a static export writes too with `/404.html` as its `path`, once the image variants, share cards and favicons the page links are written and before the pages are compressed, and again on each page the server renders afresh, by its `revalidate` period, `invalidatePage` or for another site, so a page never loses what it added. A site without one pays nothing; `kay dev` renders pages per request and calls none.
- It gets `path`, the path the page serves without the base, a locale's under its segment, and `html`, holding any server island or form stamp the server fills per request, which it leaves in place. Several extensions' hooks run in their order, each given the HTML the one before returned.
- `kay build` hooks up to 8 pages at once, so a hook doing heavy work, such as compressing, takes the async form of it and the pages run in parallel; a synchronous one holds them to one at a time.
- `file(url)` gives the absolute path of the file serving a root-relative URL the page links, under the base and as an attribute holds it, `&amp;` included: a stylesheet, script or font of the build, an image variant, a public file or a favicon. It gives `undefined` for any other, such as another site's or one only the server answers, as the public environment. An image route URL in a server build gives the WebP variant the build wrote, where a browser taking AVIF gets the AVIF one.

### Server islands

`server` on a component call renders that component per request inside an otherwise prerendered page: a form carrying a fresh token, a greeting, a stock count. The mark is the whole setup. A page without params whose template reaches one, directly or through the components it imports, prerenders without a `prerender` key, unless its `page` sets `prerender: false`. Each request runs the page's loads again, its server fence included, and renders only the components on the way down to the island, so its props come from the fence as they would on a page rendered whole:

```kay
--- server
import { issueToken } from '../contact'

export const contact = action(schema, send)
const token = issueToken()
---
Hero
Contact(action={contact} token={token})
```

```kay
// src/components/contact.kay
Section(title="Contact")
  p Write to us
  ContactForm(server="defer" action={action} token={token})
```

- `server` renders it on every GET and splices it into the prerendered page: it arrives with the page and needs no JavaScript. Only the island is rendered and compressed, the rest of the page being deflated once; the page then goes out as gzip, never brotli, with `Cache-Control: private, no-store` and no ETag.
- `server="defer"` serves the page as any prerendered page, brotli and ETag included, and the browser fetches the island a screen before it scrolls into view, or once the page is idle, then hydrates what it brought. Until then the page shows the component as the build rendered it, inert and with its forms' field names and actions taken out, so it keeps its place and size and a bot reading the page has nothing to post. Pick it for what sits low on the page. A page deferring an island ships kay's browser entry, and with no island and `navigation: false` the build fails.
- The island's URL is the page's with `?kay_island=N`: fetched by kay, it answers the island alone; visited, as from a link, it answers the page with every island in place, with `X-Robots-Tag: noindex`.
- A browser without JavaScript keeps the inert copy of a deferred island. `noscript` beside the mark, such as `ContactForm(server="defer" noscript="Show the contact form")`, adds a link with that text leading to the page with every island in place. It is off by default: leave it off when what the island does is reachable without it, as an email address beside a contact form.
- A form post rendering the page, refused or coming back with how it went, renders it whole, islands included.
- What a component on the way to an island provides reaches it; what a layout's or a sibling's render does besides does not run. A mark inside an island is reported by `kay check`, as an island renders whole in the browser too.
- `kay build --static` refuses a page holding one, and the offline worker leaves it out of the pages it keeps unless `offline.pages` lists it, warning that it would keep one visitor's render.

## Redirects

`redirects` in kay.config.ts sends old paths elsewhere, with a 308, or a 307 when `permanent` is false:

```ts
export default defineConfig({
  redirects: {
    '/blog/:slug': '/posts/:slug',
    '/docs/*': '/guide/*',
    '/sale': { to: 'https://shop.example.com/sale', permanent: false },
  },
})
```

- An old path names params as `:name` segments and may end in `*`; its target uses them, the `*` carrying the rest of the path, and the request's query goes along unless the target has its own. A target naming a param the old path lacks, or an old path a page serves, stops the server.
- `kay check` reports a target on the site that no page or public file serves; a `:param` stands for any segment there, and another site's URL is not checked.

## Rewrites

`rewrite` in kay.config.ts serves a request from another path, the browser keeping its URL, such as one host's pages from a section of the routes:

```ts
export default defineConfig({
  rewrite: url => url.hostname === 'shop.example.com'
    ? `/shop${url.pathname}${url.search}`
    : undefined,
})
```

- It returns a path starting with one `/`, query included, or `undefined` to serve the request as it came; anything else answers 500 and is logged. kay's own `/_kay/` routes, assets, actions, images and the health route, are never rewritten, so they work on every host.
- The rewritten request goes through the whole app again, the app's own routes, derives and guards included, and everything there sees the new path: `ctx.url`, `ctx.params`, links a page builds from them. It is not rewritten twice, and keeps its method, headers, cookies and body. Rate limits still count the client's own address. The request log shows the path it was rewritten to.
- Under `app.handle()` with no listening server, as in a test, only kay's pages serve a rewritten request.

## Base path

`base: '/docs'` in kay.config.ts mounts the site under a path of its host, as Pages does under `/<owner>/<repo>`. Links stay written without it, `a(href="/about")`: kay puts every root-relative `href`, `src`, `srcset`, `action`, `formaction`, `poster` and `data` a page renders under it, with inline `<style>` and stylesheet `url()`s, redirects (`Location`), canonical and `hreflang` links, the sitemap, `robots.txt`, feeds and the web manifest. A route starting like the base is no exception: under `base: '/blog'`, `a(href="/blog/hello")` goes to `/blog/blog/hello`. A server under `base` sits behind a proxy taking the path off requests: kay's routes stay at the root. An island rendering in the browser puts the same attributes under it as it sets them, leaving a path already under it as it is, so `a(href={localize('/about')})` gets it once; under `base: '/blog'`, an island links to the route `/blog/hello` with `withBase('/blog/hello')`. A URL a script uses outside a template, such as `location.assign()` or `fetch()`, goes through `withBase('/about')` from `kay`, which leaves a path as it is on the server, where kay adds the base itself; island actions, their redirects and `localize()` do already.

## Static export

`kay build --static` writes the site to `dist`, or `--outdir`, for any static host: Forgejo Pages, a CDN, plain nginx.

- Every page is rendered: one without params as it is, one with params for the values its `prerender` lists. A page a guard covers, one exporting an action, one holding a [server island](#server-islands), one with params and no list, one exporting `prerender = false`, one that redirects or answers another status than 200, one linking an image only the image route makes, and one whose render fails cannot be served without a server, nor can a module under `src/api/`, an [endpoint file](#endpoint-files) a guard covers or one with params and no `prerender` list, and the build fails naming each of them.
- Each page is written as `about.html` and `about/index.html`, so a host finds it at `/about` and `/about/` alike, `/` as `index.html`; the browser build goes under `_kay/`, the public files at the root, with each endpoint file written to its path, `llms.txt`, the sitemap, `robots.txt`, feeds, favicons, `sw.js` (see [Offline](head.md#offline)) and `404.html` from `_404.kay`. Every compressible file has its `.br` and `.gz` copy beside it, for a server sending them as they are (nginx's `gzip_static`), and asset names carry their hash, so `_kay/` can be cached forever.
- Imported images link the variants the build writes, `/_kay/images/hero-640.webp`, `hero-640-16x9.webp` cut and `hero-card.jpg` for the share card, since no image route answers; an image from `images.dirs` is not exported, and one from `images.remote` is downloaded by the build, its variants written as `/_kay/images/remote-<hash of its URL>-640.webp`, the build failing if the host does not answer.
- A redirect without params becomes a page sending the browser on with `<meta http-equiv="refresh">`; every redirect also goes to `_redirects`, read by hosts such as Netlify and Cloudflare Pages. With `i18n.prefixDefault`, each unprefixed path sends the browser to the default locale's copy. Locales by domain need a server.
- The directory is cleared first, only when the last export wrote it: kay refuses one holding other files, and the project itself.
