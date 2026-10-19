# Endpoint files, redirects, rewrites and base path

The rest of [Pages and routing](routing.md).

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

- `GET(ctx)` takes an `EndpointContext`, the request context of "The request context": `request`, `url`, `locale`, `params`, `cookies`, `locals`, `headers`, `redirect`, `notFound` and `deny`, as a page's `ctx` has them; what it sets through `cookies` and `headers` goes out with its answer, `locale` is the site's `lang` as an endpoint has no locale prefix, and `redirect`, `notFound` and `deny` answer as plain text, `deny` with its message.
- It returns a string, a `Blob` or a `Response`, or a promise of one: a string is sent as the type its extension names, `text/plain` for `.txt`, in UTF-8, a Blob with its own type or else that one, and a Response as it is, its status and headers included.
- A handler that throws answers 500 and goes to `onError`.
- The `_guard.ts` files above an endpoint run before it, as they do for a page: a redirect or a denial answers, and the cookies and headers they set go out with its answer.
- A param is a plain `[name]` segment, the extension of the last one written after its brackets, `[slug].json`; a rest, an optional or a matcher param stops the server.
- Endpoints whose paths only differ by that extension share the path, `feeds/[slug].json.ts` beside `feeds/[name].xml.ts`.
- A page cannot share a path with an endpoint, `posts/[slug].kay` beside `posts/[slug].json.ts`, as the router reads both as `/posts/:slug`: move one, `posts/[slug]/feed.json.ts`.
- An endpoint serving a page's path in any locale, another endpoint's, a public file's, a redirect's, an API route's or a feed's stops the server, which `kay check` reports.
- Locale prefixes and layouts leave endpoints alone, and the sitemap lists none.
- A `.ts` file without an extension before `.ts`, `format.ts`, stays a helper, as do `.test.ts` and `.d.ts` files.
- `kay check` checks links to endpoints, `a(href="/feeds/news.json")`, and that each exports a `GET` returning one of those.
- `kay build --compile` embeds them, and `kay build --static` writes each to its path: one without params as it is, one with params for each set of values `export const page = { prerender: [...] }` lists, as a page does.

## Redirects

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

- An old path names params as `:name` segments and may end in `*`; its target uses them, the `*` carrying the rest of the path, and the request's query goes along unless the target has its own.
- A target naming a param the old path lacks, or an old path a page in any locale, a public file, an endpoint, an API route or a feed serves, stops the server; an HTML file's path without `.html` and a translated page's untranslated path give way to it.
- A production server counts the pages a GET found nothing at: per path, trailing slash and query left out, with the referrer's host and no visitor data, in `data/not-found.sqlite` next to the job store, created by the first one, at most 1000 paths (the least hit and oldest give way), scanners' paths (`.php`, `.env`, dotfiles, `wp-*`) ignored, none in `kay dev`. A path asked for twice gets a suggested target: the same page spelled otherwise (case, `.html`), in another locale, a page with the same slug elsewhere, or a near typo of one. `kay not-found` lists them and writes a redirect ([tools](check-and-tools.md)). kayjs-cms lists them too, at its `<prefix>/not-found` screen.
- `kay check` reports a target on the site that no page or public file serves; a `:param` stands for any segment there, and another site's URL is not checked.
- `redirects` is source, so a running server cannot grow it. A second set lives in the same `data/not-found.sqlite` (`kay_redirects`, at most 1000), read only for a GET or HEAD that answered 404 (a served page pays one status comparison): `kay not-found --redirect /old --runtime`, or kayjs-cms's missing pages screen, adds to it with no deploy. Its paths are written as in `redirects` (`:name`, a final `*`, no `base`, `/a` and `/a/` one path, a locale prefix part of the path as asked), answered with a 307, or the `status` given (a 308 from kayjs-cms's Permanent box), the query carried over, `base` added and a target given a slash under `trailingSlash: 'always'`. The config's entries and any page win over it. A 307 is not kept by browsers, so removing one reaches every visitor, where a 308 stays with those who followed it; non-ASCII text is percent-encoded and `/old/` or `/old?x=1` is stored as `/old`. Use `redirects` for a redirect that belongs in the repository, this set for one an editor adds on the running site.
  - It stays on the site: a target starts with one `/`, holds no backslash, space or control character, and a page cannot be sent to another host unless `runtimeRedirects: { hosts: ['example.org'] }` in kay.config.ts lists it. A loop, also through the config or other added redirects, a target no page serves (checked by the running server and by `kay check`) and a path `redirects` already holds are refused, and a stored row that breaks the rules is not followed.

## Rewrites

`rewrite` in kay.config.ts serves a request from another path, the browser keeping its URL, such as one host's pages from a section of the routes:

```ts
export default defineConfig({
  rewrite: url => url.hostname === 'shop.example.com'
    ? `/shop${url.pathname}${url.search}`
    : undefined,
})
```

- It returns a path starting with one `/`, query included, or `undefined` to serve the request as it came; anything else answers 500 and is logged.
- kay's own `/_kay/` routes, assets, actions, images and the health route, are never rewritten, so they work on every host.
- The rewritten request goes through the whole app again, the app's own routes, derives and guards included, and everything there sees the new path: `ctx.url`, `ctx.params`, links a page builds from them.
- It is not rewritten twice, and keeps its method, headers, cookies and body.
- Rate limits still count the client's own address.
- The request log shows the path it was rewritten to.
- Under `app.handle()` with no listening server, as in a test, only kay's pages serve a rewritten request.

## Base path

`base: '/docs'` in kay.config.ts mounts the site under a path of its host, as Pages does under `/<owner>/<repo>`.

- Links stay written without it, `a(href="/about")`: kay puts every root-relative `href`, `src`, `srcset`, `action`, `formaction`, `poster` and `data` a page renders under it, with inline `<style>` and stylesheet `url()`s, redirects (`Location`), canonical and `hreflang` links, the sitemap, `robots.txt`, feeds and the web manifest.
- A route starting like the base is no exception: under `base: '/blog'`, `a(href="/blog/hello")` goes to `/blog/blog/hello`.
- A server under `base` sits behind a proxy taking the path off requests: kay's routes stay at the root.
- An island rendering in the browser puts the same attributes under it as it sets them, leaving a path already under it as it is, so `a(href={localize('/about')})` gets it once.
- Under `base: '/blog'`, an island links to the route `/blog/hello` with `withBase('/blog/hello')`.
- A URL a script uses outside a template, such as `location.assign()` or `fetch()`, goes through `withBase('/about')` from `kay`, which leaves a path as it is on the server, where kay adds the base itself; island actions, their redirects and `localize()` do already.
