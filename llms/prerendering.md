# Prerendering and static export

## Common tasks

### Prerender a page with params

`prerender` lists the params to render at build time, as an array or a function returning one:

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

### Keep a prerendered page fresh

`revalidate` renders it again in the background once it is older than that, and `invalidatePage` from `kay/cache` makes the next request wait for a fresh render; a page needs no call when what it read is invalidated, `invalidate(key)` or `collection.invalidate()` refreshing it (see [Invalidating](#invalidating)):

```kay
--- server
export const page = { prerender: true, revalidate: '1h' }
---
h1 Blog
```

```ts
import { invalidatePage } from 'kay/cache'

invalidatePage('/blog/hello')
invalidatePage(path => path.startsWith('/blog/'))
```

### Render one part of a prerendered page per request

`server` on a component call renders that component on every request inside the prerendered page:

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

### Export the site as static files

`kay build --static` writes the site to `dist`, or `--outdir`, for any static host:

```sh
kay build --static --outdir public
```

## Reference

### Prerendering

- A page whose `page` has `prerender: true` is rendered once by `kay build`, its loads included, and served from that file in production, revalidated by its ETag.
- Its guards still run on every request.
- A page without `prerender` is prerendered all the same when `kay build` can show it reads nothing from its request: no `ctx` read beyond `ctx.url.pathname` and `ctx.params` (written as those, or destructured as `const { url: { pathname }, params } = ctx`; `ctx.url` whole, `ctx.url.search`, `ctx.request`, `ctx.cookies`, `ctx.locals` or `ctx` passed on all read the request), no `query`, `Date`, `Math.random` (or `Math` taken whole), `process`, `Bun` or `fetch` in it, its layouts or the components and modules they import, no module state (a `let` or `var` at the top of a `.ts` file, or of a `.kay` server fence that an export of it reads, an empty array, object, `Map` or `Set` it fills, an exported `new` or an exported object or array literal another module can change), and no import but `.kay` files, relative modules, images, fonts and data files, `~icons/<set>/<name>` icons of an installed set, `kay/image` (`image`, `shareImage` and `shareCard`, which read nothing from a request), `kay/i18n` (but `formatRelativeTime` and `relativeTime`, which read the clock) and the exports of `kay` that read nothing from a request (`signal`, `memo`, `effect`, `selection`, `watch`, `s`, `withBase`, `sanitizeHtml` and the like, and `persisted` where every use says `storage: 'local'`), and `kay/content` (`collection` where every call names a folder as a string, `paginate`, `renderMarkdown` and the field helpers; a collection a page reads is refreshed by `collection.invalidate()`, and a visitor in preview mode is never served a kept copy), re-exports followed.
- An exported object or array literal is no module state when it is made of strings, numbers, booleans, `null`, bindings the module imports and nested objects and arrays of them (`as const`, `satisfies` and a type annotation allowed) and no file of the project but a test (`*.test.ts`, `*.spec.ts`) writes to it or reaches it in a way the build cannot follow: `export const CONTACT = { email: 'a@b.fr', address: { city: 'Brest' } }` read as `CONTACT.address.city` keeps its pages. A write (`CONTACT.email = x`, `LIST.push(x)`, `delete`, `++`, a destructuring target), the value passed to a function, aliased, returned, renamed in an `import` or `export`, or reached through a namespace import of the module holding it (or of one re-exporting it) used as a value, a computed key, `eval` or a dynamic `import()` leaves the export state, wherever in the project it is; a namespace import of any other module, as in a test's `import * as mail`, does not. A literal of flat values may also be spread, iterated, destructured, indexed by a computed key, or read by `join`, `includes`, `slice` and the like. One holding objects or arrays is read through `.prop` chains, `.length`, `Object.keys` and `JSON.stringify`, and its items by `for (const item of LIST)`, a template's `for item of LIST` and `map`, `forEach`, `some`, `every`, `findIndex` and `reduce` callbacks taking the item (and its index) as plain parameters, as long as the item is only read there (`item.label`, `item.tags.length`): `filter`, `find` and `sort`, an item passed on or written to, a `reduce` without a starting value leave it state. A `const` exported further down by `export { X }` is judged like one exported where it is declared; `export { X as Y }` and `export default X` leave it state, as no importer is followed through a rename or a default. A `const` named anywhere inside `export default { X }` or `export default [X]` leaves it state, as the default is never a read only use. One a `--- server` fence exports later is judged like an exported declaration, so only a write stops it. A literal with a call, a spread, a computed key, a method or a local variable in it, a `let` and `Object.freeze(...)` (never state) are judged as before.
- An exported container no such proof covers (a call in it, a `new Map()`) stops only the pages that take it: one importing it by name, a function or a value of the module built from it, an alias of it (`export { X as Y }`, `export default X`), or the whole module (`import * as`, `export *`, an `import` for effect). A page importing `CONTACT` from a module that also exports `CREW = [{ ratings: ratings([1, 2]) }]` stays prerendered. A `let`, a `var` and an empty container the module fills stop every page importing the module.
- Anything else, a package, `kay/server`, `queryParam`, a `collection` over a loader (its `load` may read a database or refresh on a `ttl` that no rebuild tells the page of), the editing functions of `kay/content` (`entries`, `saveEntry` and the like), a `persisted` kept in a cookie or the query, or any other export of `kay` that reads the request, leaves the page rendered per request. The build keeps such a page only when it renders twice to the same bytes, answers 200, holds no server island, stamp or site URL and sets no `revalidate`; it never fails the build.
- A kept page reading `ctx.url.pathname` is served at the path it was rendered at, spelled as `trailingSlash` says (`/books/` under `always`), and rendered per request at any other spelling, such as `/books/` under `ignore`. `base` is never in the pathname, which is the one the routes serve, and a locale's copy is rendered at its own prefixed path. A route with params is not kept without `prerender`, so `ctx.params` is empty in a kept page.
- `kay build` lists each route as `prerendered`, `kept` or `on request`, and under an `on request` one the file and line that stopped it, as `src/routes/clock.kay:2 reads \`Date\``; `--format json` gives `kept` and `stop` on each of `built.routes`.
- `export const page = { keep: true }` says the page is to be kept: when the build does not keep it, `kay build` reports `unkept-page` at that file and line, a warning that `lints` can set to `deny` to fail the build; it leaves the page rendered per request all the same, and `prerender: true`, which renders once without checking, is the other way to say so. A page that also says `prerender: false` is reported the same way, as the two contradict.
- A kept page is served as a `prerender: true` one is, per locale, with its guards run on every request; `transformPage` hooks and `offline` see it as one, and it takes no part in the sitemap, the search index or the head lints, which `prerender` opts into.
- What the build cannot see is caught at run time: the first visit to a kept page after a request that can write (an action, or a route answering anything but GET and HEAD) renders it live and compares it with the kept copy, once per write however many visits wait. A page that renders differently, such as one listing an array a function builds up or a database the action edits, is served per request from then on in that process, and the server warns once naming it; `page = { prerender: false }` says so up front and skips the check. A page unchanged by the write is still answered from the kept copy, and a `prerender: true` page is never checked. A timer or a job changing a value with no request goes unseen, so such a page needs `page = { prerender: false }`.
- It renders without a request, so reading `ctx.cookies`, `ctx.query` or `ctx.locals` in its server fence is reported by `kay check`, and in a layout fails the build, and `ctx.failed` and `ctx.succeeded` return `undefined`; `ctx.url` is `http://localhost` plus its path.
- A refused form post, and a request carrying the cookie a plain form post that went through leaves, as the browser coming back from one does, get it rendered for that request instead, with how the post went, as `Cache-Control: private, no-store` and no ETag; the next request gets the file again.
- Development renders it per request like any other.
- A route taking params lists the ones to render instead, as an array or a function returning one; any other path renders per request:

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

- Each value is a string with no empty, `.` or `..` segment, a catch-all's included with its slashes.
- `prerender: false` prerenders nothing.
- A list `paginate()` from `kay/content` split lists each of its pages, for a page whose one param is optional, `blog/[[page=integer]].kay` (see content).

#### Revalidating

- `revalidate: '1h'` beside `prerender` in `page` keeps a prerendered page fresh: once it is older than that, seconds or a string such as `'1h'`, the next request still gets it as it is, and starts rendering it again in the background, the way `kay build` does.
- Every request after that render lands gets the new page, with a new ETag and compressed copies.
- One render runs at a time per path.
- A render that fails or answers 5xx is logged and leaves the page as it was, the next attempt coming a minute later at most.
- The new page lives in memory, so a restart serves the built file again until it goes stale; an executable built a while ago revalidates on its first request.

#### Invalidating

Invalidating a cached value or a collection refreshes every prerendered page that read it, with no other call: the render records the `cached` keys and collections it reads, `invalidate('posts')` or `posts.invalidate()` marks those pages stale, and the next request for one waits for a fresh render. This covers a webhook, in one line, `news.invalidate()`. `invalidatePage` from `kay/cache` is for a page no data source explains, such as a hand-written file or a change in a component; the next request for it waits for a fresh render rather than getting it as it was, whether or not the page has a `revalidate` period:

```ts
import { invalidatePage } from 'kay/cache'

invalidatePage('/blog/hello')
invalidatePage(path => path.startsWith('/blog/'))
```

- Which call: `collection.invalidate()` or `invalidate(key)` when data changed, `invalidatePage` when only a page did, `revalidate` for a page that may drift with no event to tell of it.
- The path is the one the routes serve, without the base, a locale's page under its segment, `/fr/blog/hello`.
- Requests arriving while the render runs wait for the same one; a render that fails or answers 5xx is logged, leaves the page as it was, and no request waits on another before a minute has passed.
- Processes sharing a `sqliteCache` (see [Caching](rendering.md#caching)) mark the same pages, those a key read by `invalidate` or a collection names included within about half a second: a path given as it is reaches them all, a function the paths it matched in this process, which serves the same build.

#### Page hooks

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

- It runs in `kay build`, `--static` included, the `404.html` a static export writes too with `/404.html` as its `path`, once the image variants, share cards and favicons the page links are written and before the pages are compressed.
- It runs again on each page the server renders afresh, by its `revalidate` period, `invalidatePage` or for another site, so a page never loses what it added.
- A site without one pays nothing; `kay dev` renders pages per request and calls none.
- It gets `path`, the path the page serves without the base, a locale's under its segment, `locale`, the locale the page is in (the site's one language without `i18n`, the default locale for `404.html`), and `html`, holding any server island or form stamp the server fills per request, which it leaves in place.
- Several extensions' hooks run in their order, each given the HTML the one before returned.
- `kay build` hooks up to 8 pages at once, so a hook doing heavy work, such as compressing, takes the async form of it and the pages run in parallel; a synchronous one holds them to one at a time.
- `file(url)` gives the absolute path of the file serving a root-relative URL the page links, under the base and as an attribute holds it, `&amp;` included: a stylesheet, script or font of the build, an image variant, a public file or a favicon.
- It gives `undefined` for any other, such as another site's or one only the server answers, as the public environment.
- An image route URL in a server build gives the WebP variant the build wrote, where a browser taking AVIF gets the AVIF one.

#### Server islands

- `server` on a component call renders that component per request inside an otherwise prerendered page: a form carrying a fresh token, a greeting, a stock count.
- The mark is the whole setup.
- A page without params whose template reaches one, directly or through the components it imports, prerenders without a `prerender` key, unless its `page` sets `prerender: false`.
- Each request runs the page's loads again, its server fence included, and renders only the components on the way down to the island, so its props come from the fence as they would on a page rendered whole:

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

- `server` renders it on every GET and splices it into the prerendered page: it arrives with the page and needs no JavaScript.
- Only the island is rendered and compressed, the rest of the page being deflated once; the page then goes out as gzip, never brotli, with `Cache-Control: private, no-store` and no ETag.
- `server="defer"` serves the page as any prerendered page, brotli and ETag included, and the browser fetches the island a screen before it scrolls into view, or once the page is idle, then hydrates what it brought.
- Until then the page shows the component as the build rendered it, inert and with its forms' field names and actions taken out, so it keeps its place and size and a bot reading the page has nothing to post.
- Pick it for what sits low on the page.
- A page deferring an island ships kay's browser entry, and with no island and `navigation: false` the build fails.
- The island's URL is the page's with `?kay_island=N`: fetched by kay, it answers the island alone; visited, as from a link, it answers the page with every island in place, with `X-Robots-Tag: noindex`.
- A browser without JavaScript keeps the inert copy of a deferred island.
- `noscript` beside the mark, such as `ContactForm(server="defer" noscript="Show the contact form")`, adds a link with that text leading to the page with every island in place.
- It is off by default: leave it off when what the island does is reachable without it, as an email address beside a contact form.
- A form post rendering the page, refused or coming back with how it went, renders it whole, islands included.
- What a component on the way to an island provides reaches it; what a layout's or a sibling's render does besides does not run.
- A mark inside an island is reported by `kay check`, as an island renders whole in the browser too.
- `kay build --static` refuses a page holding one, and the offline worker leaves it out of the pages it keeps unless `offline.pages` lists it, warning that it would keep one visitor's render.

### Static export

`kay build --static` writes the site to `dist`, or `--outdir`, for any static host: Forgejo Pages, a CDN, plain nginx.

- Every page is rendered: one without params as it is, one with params for the values its `prerender` lists.
- A page a guard covers, one exporting an action, one holding a [server island](#server-islands), one with params and no list, one exporting `prerender = false`, one that redirects or answers another status than 200, one linking an image only the image route makes, and one whose render fails cannot be served without a server, nor can a module under `src/api/`, an [endpoint file](routing-endpoints-and-base.md#endpoint-files) a guard covers or one with params and no `prerender` list, and the build fails naming each of them.
- Each page is written as `about.html` and `about/index.html`, so a host finds it at `/about` and `/about/` alike, `/` as `index.html`.
- The browser build goes under `_kay/`, the public files at the root, with each endpoint file written to its path, `llms.txt`, the sitemap, `robots.txt`, feeds, favicons, `sw.js` (see [Offline](sitemap-search-fonts.md#offline)) and `404.html` from `_404.kay`.
- Every compressible file has its `.br` and `.gz` copy beside it, for a server sending them as they are (nginx's `gzip_static`), and asset names carry their hash, so the files of `_kay/` can be cached forever, except `search.json` and `THIRD-PARTY-LICENSES.txt`, which keep their name between builds and must revalidate. A server without brotli (the scaffold's `nginx:alpine`) drops the `.br` copies.
- `_headers` (read by Netlify and Cloudflare Pages) and `headers.nginx.conf` (`add_header` lines for an nginx `include`, without HSTS) hold the security headers a server would send every response, the app's `security` settings applied. A page's own `security` setting is not read. The scaffold's Dockerfile moves the include to `/etc/nginx/kay-headers.conf`, and its `nginx.conf` includes it at server level and in every `location` with an `add_header` of its own, as nginx drops the inherited ones there.
- Imported images link the variants the build writes, `/_kay/images/hero-640.webp`, `hero-640-16x9.webp` cut, `hero-96.webp` for a width under 320 a page asks for and `hero-card.jpg` for the share card, since no image route answers.
- An image from `images.dirs` is not exported, and one from `images.remote` is downloaded by the build, its variants written as `/_kay/images/remote-<hash of its URL>-640.webp`, the build failing if the host does not answer.
- A redirect without params becomes a page sending the browser on with `<meta http-equiv="refresh">`; every redirect also goes to `_redirects`, read by hosts such as Netlify and Cloudflare Pages.
- With `i18n.prefixDefault`, each unprefixed path sends the browser to the default locale's copy.
- Locales by domain need a server.
- The directory is cleared first, only when the last export wrote it: kay refuses one holding other files, and the project itself.
