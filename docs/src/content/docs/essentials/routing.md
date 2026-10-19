---
title: Routing
order: 3
description: Files in src/routes are pages, their path is their URL.
---

<FileTree tree="
src/routes/
  index.kay  /
  about.kay  /about
  blog/
    index.kay  /blog
    [[slug].kay](#dynamic-routes)  /blog/:slug
  [_layout.kay](#layouts)  wraps every page
" />

A file in `src/routes/` is a page, and its path is its URL. Links are plain `a` tags, and `kay check` reports a link to a page that does not exist.

```kay
a(href="/about") About
```

## Dynamic routes

A segment in brackets is a param. The page's server fence reads it from `ctx.params`.

```kay
--- server
import { findPost } from '../../posts'

const post = await findPost(ctx.params.slug) ?? ctx.notFound()
---
h1 {post.title}
```

| File | Matches |
| --- | --- |
| `[slug].kay` | `/blog/hello` |
| `[...path].kay` | `/docs/a/b/c`, any depth |
| `[[page]].kay` | `/blog` and `/blog/2` |
| `[id=integer].kay` | `/items/42` only, `ctx.params.id` a `number` |

When two pages match a URL, a fixed name wins over a param, and a param wins over a catch-all.

<Callout type="tip">

`ctx.params` is typed from the file name: `[id=integer]` gives a `number`, `[[page]]` a `string | undefined`.

</Callout>

## Layouts

A `_layout.kay` wraps every page in its folder and below. It renders the page at `slot`.

```kay
header
  a(href="/") Home
  a(href="/blog") Blog
main
  slot
```

Layouts nest, so `blog/_layout.kay` renders inside the root one. A folder in parentheses groups pages under a layout without changing their URL: `(marketing)/pricing.kay` is `/pricing`.

## Page settings

A page's settings are the keys of one object that its server fence exports.

```kay
--- server
export const page = { prerender: true, revalidate: '1h' }
---
```

`prerender`, `keep` and `revalidate` are covered under [Prerendering](#prerendering). `layouts: false` drops the layouts above the page. `query` is covered in [Data loading](/essentials/data-loading), and `sitemap` and `noindex` in [Head and SEO](/essentials/head-and-seo). `kay check` types the object, so an unknown key is an error.

## Loading data

A page reads its data in a `--- server` fence, with the request in `ctx`. See [Data loading](/essentials/data-loading).

## Endpoint files

A `.ts` file with an extension before `.ts` serves that path with what its `GET` returns. Use it for an `llms.txt`, a JSON feed or a CSV export.

```ts
// src/routes/feeds/[slug].json.ts
import type { EndpointContext } from 'kay'
import { feedOf } from '../../data'

export const page = { prerender: [{ slug: 'news' }] }

export function GET({ params }: EndpointContext<{ slug: string }>) {
  return Response.json(feedOf(params.slug))
}
```

`GET` receives the same `ctx` as a page, without the parts only a page has. It returns a string, a `Blob` or a `Response`. A string goes out as the type its extension names, such as `text/plain` for `llms.txt`. The guards above it run first, as they do for a page. `kay build --static` writes it to a file.

## Not found and errors

`_404.kay` renders for `ctx.notFound()` and for every URL no page serves. `_error.kay` renders when a page throws, and reads `ctx.error`.

```kay
--- server
const { status, message } = ctx.error
---
h1 Error {status}
p {message}
```

## Prerendering

A page that is the same for everyone can be rendered once at build time.

```kay
--- server
export const page = { prerender: true }
---
```

You often need no flag. `kay build` also keeps a page that reads nothing from its request or the clock, and serves it from memory. Importing an icon from `~icons/` of an installed icon set does not stop it, as the icon is plain markup that reads nothing. The same goes for `image`, `shareImage` and `shareCard` from `kay/image`, which only turn an image into its attributes or its URL.

A module of site constants, such as `export const CONTACT = { email: 'a@b.fr', phone: '01 02' }`, does not stop it either, as long as nothing in the project changes it. If any file assigns into it, pushes to it, or passes it to a function that might, the build cannot tell and renders the page per request, naming the line of the export.

A test file that writes to a constant does not count, as a test runs apart from the site. Neither does a file that uses the whole of an unrelated module, such as `import * as mail from './mail'`.

Lists of objects are fine too. A nav can loop over `export const NAV = [{ id: 'team', label: 'Team' }]` with `for link of NAV` or `NAV.map(link => link.id)`, and the list can hold imported icons, as long as the loop only reads each item.

Handing an item to a function, or calling `filter`, `find` or `sort` on the list makes the build unsure, and the page is rendered per request.

A constant exported further down with `export { CONTACT }` counts like one exported where it is declared. Exporting it under another name, or as the default, leaves the build unsure. A constant listed inside a default-exported object or array always leaves the build unsure. One a server fence exports further down is judged like one exported where it is declared, so only a write stops the page.

A constant the build cannot vouch for, such as a list with a function call in it, only matters to the pages that use it. A page that imports `CONTACT` from a module also exporting such a list is still prerendered.

`kay build` shows what it decided. Its route table says `prerendered`, `kept` or `on request` for each route. Under an `on request` page it names the file and line that stopped it, such as `src/routes/clock.kay:2 reads Date`.

To be told when a page stops being kept, say so in the page.

```kay
--- server
export const page = { keep: true }
---
```

When the page cannot be kept, `kay build` warns with the file and line. Set the `unkept-page` lint to `deny` in `kay.config.ts` to fail the build instead. A page that is not kept is rendered for each request. Guards run on every request either way, and development renders every page afresh.

A page that shows data another module changes between requests is caught as the app runs. The server then renders it for each request and warns once with its name. `prerender: false` says so up front. Only a request one of your routes answers can trigger this check, such as an action or an API write. Kay's own routes, such as analytics beats and error reports, and requests to paths that do not exist never do. A request to one of your routes does, even if a guard then refuses it.

A page with params lists the ones to build. Pass a content collection to build one page per entry.

```kay
--- server
import { posts } from '../../content.config'

export const page = { prerender: posts }
---
```

<Callout type="note">

Add `revalidate: '1h'` to `page` to rebuild a prerendered page in the background once it is older than that.

</Callout>

<ReadMore href="/llms/prerendering#prerendering">What makes a page keepable, how the run-time check works, and how kept pages treat locales and `trailingSlash`.</ReadMore>

### Changing a page before it is written

A page hook gets each prerendered page as it is about to be written, and returns the HTML to write instead. Put it in `transformPage` of an extension listed in `kay.config.ts`.

```ts
// kay.config.ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  extensions: [{
    name: 'build-stamp',
    transformPage: ({ html }) => html.replace('<!--built-->', new Date().toISOString()),
  }],
})
```

The hook is given `path`, `locale` and `html`. It also has `file(url)`, which resolves the file behind a root-relative URL the page links, such as a stylesheet or an image variant, to read its size.

It runs in `kay build`, `--static` included, and again each time the server renders a page afresh, so a page never loses what it added. `kay dev` calls none. Several hooks run in their order, each given the HTML the one before returned.

<ReadMore href="/llms/prerendering#page-hooks">A hook measuring page weight, when it runs and how pages run in parallel.</ReadMore>

### Server islands

`server` on a component call renders that component on each request, inside a page that is otherwise prerendered. Use it for a form with a fresh token, a greeting or a stock count. The rest of the page is prerendered, with no `prerender` flag needed.

```kay
--- server
import { issueToken } from '../contact'

const token = issueToken()
---
Hero
ContactForm(server token={token})
Reviews(server="defer")
```

`server` renders the island into the page before it is sent. `server="defer"` sends the page as prerendered, and the browser fetches the island as it nears the screen.

A deferred island shows nothing useful without JavaScript. Add `noscript` with the text of a link, and a visitor without JavaScript gets a link to the page with every island in place.

```kay
ContactForm(server="defer" noscript="Show the contact form")
```

Leave it off when the island's content is reachable without it. `noscript` goes only with `server="defer"`.

## Redirects

Old URLs go in `kay.config.ts`.

```ts
export default defineConfig({
  redirects: {
    '/blog/:slug': '/posts/:slug',
    '/old': { to: '/new', status: 301 },
  },
})
```

A redirect answers 308, or 307 with `permanent: false`. `status` names another: 301 or 302 for clients and crawlers that expect them.

### Find the old URLs visitors still use

After a site moves, old links keep answering 404. A production server counts the pages visitors asked for and found nothing at, in `data/not-found.sqlite`. It keeps the path, how often it was hit and the host of the page that linked to it, never anything about the visitor.

```sh
kay not-found
```

The list starts with the most hit. A path asked for twice also gets a suggestion: the same page in another case or locale, a page with the same slug elsewhere, or a near typo. To turn one into a redirect, run `kay not-found --redirect /old`, or add `--to /new` when there is no suggestion. kay adds the line to `redirects` in `kay.config.ts`.

In `kay dev`, the dev tool's Not found tab shows the same list from the file a production run left, with a field for the target and an Add redirect button on each path. It writes the same line to `kay.config.ts`. `kay dev` counts nothing itself, so the tab is empty until that file exists.

A redirect in `kay.config.ts` needs a deploy. To add one to the running site instead, run `kay not-found --redirect /old --runtime`. kay writes it to the same `data/not-found.sqlite`, and the server answers it from the next request with a 307, which browsers do not keep, so removing it undoes it for everyone. The config's redirects and your pages always win over it, and it is only looked up for a path that would have been a 404.

An added redirect can only go to a page of your site. kay refuses a target like `//evil.example` or `https://evil.example/`, a redirect back to its own path (also through other redirects), and a target no page serves. To allow another site, list its host in `runtimeRedirects` in `kay.config.ts`: `runtimeRedirects: { hosts: ['example.org'] }`. Use `redirects` for what belongs in the repository, and this for what an editor adds while the site runs.

Requests for `.php`, `.env` and similar files are ignored, as bots send them to every site. The list holds 1,000 paths; the least hit give way to new ones.

### Rewrite a request to another path

`rewrite` serves a request from another path, and the browser keeps its URL. Use it to serve one host's pages from a section of your routes.

```ts
export default defineConfig({
  rewrite: url => url.hostname === 'shop.example.com'
    ? `/shop${url.pathname}${url.search}`
    : undefined,
})
```

Return a path starting with one `/`, query included, or `undefined` to serve the request as it came. Anything else answers 500.

The rewritten request goes through the whole app again, guards included, and sees the new path in `ctx.url` and `ctx.params`. kay's own `/_kay/` routes are never rewritten, so they work on every host.

## Pages from a library

A library can serve pages of its own, such as the sign-in and sign-up of kayjs-auth. List it once in `extensions`.

```ts
import { authPages } from '@kaynooo/kayjs-auth'
import { defineConfig } from 'kay/server'

export default defineConfig({ extensions: [authPages()] })
```

Its pages serve under their prefix, such as `/auth/login`, inside your layouts and guards. To change one, put your own file at the same path, `src/routes/auth/login.kay`. It replaces that page alone.

<ReadMore href="/guides/component-libraries">Writing your own library or extension.</ReadMore>

<ReadMore href="/llms/component-libraries#extensions">Writing an extension, its layouts, messages, API modules and config, page hooks and editor.</ReadMore>

<ReadMore href="/llms/routing">Matchers, the page settings in full, server island options such as `noscript`, rewrites, base path and static export are in the full routing reference.</ReadMore>
