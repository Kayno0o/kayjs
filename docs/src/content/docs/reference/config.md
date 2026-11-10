---
title: Config
order: 2
description: The options of kay.config.ts most projects set.
---
`kay.config.ts` at the project root exports the config by default. `defineConfig` types it, and `kay dev`, `kay build`, `kay check` and the server all read it. A key kay does not know, at the top or in an option bag such as `security`, is a type error in `defineConfig` and stops every command with the nearest known name, so a mistyped `trailingslash` never leaves the default in place unnoticed.

A value of the wrong kind, such as `trailingSlash: 'sometimes'` or `lang: 5`, stops them too, once, naming the key, what it accepts and the nearest match. `auth()`, `cms()`, `mail()` and `ai()` check their options the same way.

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  site: 'https://example.com',
  seo: {
    name: 'Example',
    titleTemplate: '%s | Example',
    description: 'A small site.',
    image: '/social.png',
  },
  favicon: 'public/logo.png',
  fonts: [{ fontsource: '@fontsource-variable/inter' }],
  redirects: { '/blog/:slug': '/posts/:slug' },
  i18n: { locales: ['fr', 'en'], defaultLocale: 'fr' },
  security: { csp: { 'img-src': ["'self'", 'data:'] } },
  proxy: true,
  serve: { compress: false },
  lints: { 'positional-key': 'deny' },
})
```

Every option is optional. The tables give each option's default. The full reference has the rest.

## Site and SEO

| Option | Effect |
| --- | --- |
| `site` | The public origin, for canonical links, the sitemap and social URLs. `SITE_URL` when left out, and under `kay dev` `http://localhost:<port>` when that is unset too; a `site` written here wins over both. See [Head and SEO](/essentials/head-and-seo) |
| `seo` | What every page's head starts from: `name`, `titleTemplate`, `description`, `image`, `imageAlt`, `locale` (`og:locale`), `themeColor`, `twitter`, `jsonLd`. See [Head and SEO](/essentials/head-and-seo) |
| `sitemap` | `{ ttl }`, how long the sitemap is kept before it is built again, `'1h'` by default. |
| `robots` | Paths `/robots.txt` disallows or allows, `{ disallow: ['/admin'] }`, listed for every locale; `false` serves none. See [Head and SEO](/essentials/head-and-seo#sitemap-and-robotstxt) |
| `head` | Tags every page's head carries, written as a `head` block compiles them; the CSP lets their inline scripts through. See [Head and SEO](/essentials/head-and-seo) |
| `favicon` | A square image of 512 px or more, or a square SVG, served as the favicon and the manifest icons. `false` serves none |
| `manifest` | The web manifest: `shortName`, `themeColor`, `backgroundColor`, `display`, `orientation`, `startUrl`, `scope`, `shortcuts`, and a `maskable` image served as its maskable icons |
| `offline` | `true`, or what to keep: a service worker keeping the build's files and some pages for offline visitors. Off by default, as `false` is. Pages are kept under the path `trailingSlash` writes them at |
| `search` | `true` indexes the pages `kay build` renders, for `searchResults` to search in the browser. Off by default. See [Site search](/guides/search) |
| `lang` | The `lang` of the `html` element when `i18n` is not set, `en` by default |

## Grouped options

Options of one concern sit in one bag, so a key is found by what it does. Before 1.88 each was a key of its own at the top (`routesDir`, `compress`, `navigation`, and so on); the top-level keys are refused as unknown, naming the bag key that replaced each.

```ts
export default defineConfig({
  dirs: { routes: 'src/pages', public: 'static' },
  limits: { body: '2mb', byPath: { '/upload': '50mb' } },
  serve: { compress: false },
  observe: { onError: ({ error }) => report(error) },
  client: { navigation: false },
})
```

In `dirs`, where the project keeps its parts:

| Option | Effect |
| --- | --- |
| `dirs.routes` | The page directory, `src/routes` by default. See [Routing](/essentials/routing) |
| `dirs.api` | The directory of API modules, `src/api` by default. See [API routes](/guides/api-routes) |
| `dirs.public` | The directory of files served as they are at their path, `public` by default. See [Styling and assets](/essentials/styling-and-assets#public-files) |

In `limits`, what a request may carry:

| Option | Effect |
| --- | --- |
| `limits.body` | The most a request with a body to any route may send. An action or an API route may set its own. bytes or a size such as `'4mb'`, 1 MB by default. A bigger one answers 413. See [The request body limit](/guides/security#the-request-body-limit) |
| `limits.byPath` | The most a request to a route of your own may send, by path: `{ '/upload': '50mb' }` sets it for the route and what is under it. See [The request body limit](/guides/security#the-request-body-limit) |

In `serve`, how the server answers:

| Option | Effect |
| --- | --- |
| `serve.apiPath` | Where the API modules, the OpenAPI document and its reference page are served, `/api` by default: `serve: { apiPath: '/v1' }` serves `src/api/chat.ts` at `/v1/chat`. Absolute, plain segments, no trailing slash. See [API routes](/guides/api-routes) |
| `serve.compress` | Compresses responses rendered per request. On in production; `false` when a proxy or CDN does it |
| `serve.compressionDictionary` | A server build with a prerendered page uses its 404 page as a dictionary and sends a page to a browser holding it as the difference from it. On by default; `false` builds none, so no page names one. See [Pages that send only their difference](/guides/deployment#pages-that-send-only-their-difference) |
| `serve.shutdownTimeout` | How long a stopping server lets open requests finish, as seconds or `'30s'`. 10 seconds by default |
| `serve.timeout` | The longest a page, action, API route or endpoint may take, `'15s'`: past it the request answers 504 and `ctx.signal` aborts. None by default, `false` for none; a page, an `api()` module and an action set their own |

At the top level, hooks for the whole app:

| Option | Effect |
| --- | --- |
| `beforeRequest` | Runs before the guards of every request that reaches a route. Return `false` or throw `refuse()` to refuse it, or return a `Response` to answer it |
| `onResponse` | Told `{ request, url, status, duration }` after each answer |
| `onStart`, `onStop` | Run when the server listens and when it stops |
| `actions` | Defaults for every action: `protect`, `maxSize`, `messages`, and the hooks `beforeRun`, `onSuccess` and `onError`. An action's own settings replace them key by key, and `protect: false` takes none. See [Hooks](/guides/hooks) |

In `observe`, what you watch the server by:

| Option | Effect |
| --- | --- |
| `observe.log` | One line per request, and kay's own messages. On in production as text; `'json'` writes one JSON object each, a function receives each `LogEntry`, and `false` turns the request lines off |
| `observe.serverTiming` | A `Server-Timing` header on pages rendered per request. On in development, off otherwise unless set |
| `observe.requestIdHeader` | The header a request's id goes out on and a trusted proxy's comes in on, `x-request-id` by default. See [Deployment](/guides/deployment) |
| `observe.extract` | Reads a request's trace context from its headers, as `headers => propagation.extract(ROOT_CONTEXT, Object.fromEntries(headers))`. Kay reads `traceparent` itself by default; `false` ignores incoming traces |
| `observe.tracer` | An OpenTelemetry tracer, as `trace.getTracer('my-site')`, giving a span per page and API request. None by default |
| `observe.onError` | Receives `{ error, request }` for every error a load, render, guard, action, API route, job or island throws, for an error tracker; the request is `undefined` outside one |

In `client`, what pages ship to the browser and how it behaves there:

| Option | Effect |
| --- | --- |
| `client.navigation` | The in-place page swap, on by default. `false` loads every page fully. See [Islands](/essentials/islands) |
| `client.hydration` | How far ahead of the viewport islands start loading, as CSS root margins: `visible` for `hydrate="visible"` (`200px` by default) and `serverIslands` for a deferred server island (`100% 0px`). See [Islands](/essentials/islands#when-to-hydrate) |
| `client.prefetch` | When the browser fetches a page a link points at: `moderate` on hover (the default), `conservative` on press, `eager` as soon as it can (the links in view, a few at a time, on a page running kay's script), `false` never. A link with `data-no-prefetch` or `data-prefetch="false"`, a download, `rel="nofollow"` or a path under `/_kay/` or `/api/` is never fetched |
| `client.pageTimeout` | How long the browser waits for a page it swaps in place, `'10s'` by default; past it the browser loads the page itself. For a page streaming `await` blocks it is the longest the stream may send nothing (the server keeps it alive every 5 s) before the blocks still pending are left as they are. See [Islands](/essentials/islands#page-navigation) |
| `client.saveData` | `false` serves a visitor sending `Save-Data: on` the same page, image widths and island hydration as anyone. On by default. See [Eco-design](/guides/eco-design#images-and-fonts) |
| `client.inlineStyles` | `true` writes every page's styles into its head in production, `false` links them. Unset, a page inlines them when they compress under about 14 KB, or else only the rules its own components use. See [Styling and assets](/essentials/styling-and-assets#linked-or-inlined-styles) |
| `client.lateStyles` | `true` links the whole stylesheet after the paint on a page that inlines its own rules, so a class the build cannot read still gets its style, and the build warns of none. Off by default: a page ships only its own rules. See [Styling and assets](/essentials/styling-and-assets#a-class-kay-cannot-see) |
| `client.typography` | `false` leaves the spaces of a French page, the ones before `: ; ! ?` and inside `« »`, as they were typed. On by default for a page whose `lang` is `fr` or `fr-...`, islands included. See [Internationalization](/guides/i18n#french-typography) |
## Routing

| Option | Effect |
| --- | --- |
| `entry` | The server entry, `src/server.ts` by default. Every command reads it, and `--entry` on a command wins over it. With no file there, kay serves the pages itself |
| `publicCache` | How long the browser keeps a public file without asking again, as globs on the served path: `{ '/fonts/**': '365d' }`. `0` revalidates. Fonts it leaves out are kept 30 days, images a day, the rest revalidates. See [Styling and assets](/essentials/styling-and-assets#public-files) |
| `redirects` | Old paths sent to new ones with a 308, a 307 with `permanent: false`, or the 301, 302, 307 or 308 that `status` names. See [Routing](/essentials/routing) |
| `runtimeRedirects` | The hosts besides the site's own that a redirect added while the site runs may send to: `{ hosts: ['example.org'] }`. None by default. See [Routing](/essentials/routing#find-the-old-urls-visitors-still-use) |
| `rewrite` | A function returning the path to serve a request from, or `undefined` to serve it as it came. The browser keeps its URL. It runs before the alias of a path an extension moved (`api.former`), so it can rewrite such a path itself |
| `base` | Where the site is mounted when it is not at its host's root, such as `/docs`. Unset by default. See [Static export and base path](/guides/static-export#mount-the-site-under-a-path) |
| `trailingSlash` | `never` (the default) redirects `/about/` to `/about`, `always` the other way, `ignore` serves both. See [Trailing slashes](/guides/static-export#trailing-slashes) |
| `links` | `{ outside: 'same-tab' }` keeps a link to another site in the same tab. By default kay adds `target="_blank" rel="noopener"` to it. `schemes: ['webcal', 'geo']` lets a bound URL keep those schemes instead of going out as `unsafe:`, see [Security](/guides/security). See [Templates](/essentials/templates#links-to-other-sites) |
| `extensions` | What libraries add: their pages and API modules under a prefix, which an app file at the same path replaces, their message catalogs, config laid under the app's, page hooks, a tab for the dev tool, and a CMS's editor rendered in edit mode. See [Routing](/essentials/routing#pages-from-a-library) |

## Content and i18n

| Option | Effect |
| --- | --- |
| `contentConfig` | The module exporting the collections, `src/content.config.ts` by default. See [Content](/guides/content) |
| `markdown` | `highlight`, `transform`, `preprocess`, `containers`, `footnotes`, `headingLinks`, `readingSpeed` and `imageSizes` for every collection, which a collection's own option overrides. See [Content](/guides/content) |
| `preview` | Lets an editor see drafts on the live site, `false` for none. `secret` signs the preview links; left out, a key is made from the app's `secret`. `maxAge` is how long a visitor stays in preview mode, an hour by default |

| `store` | Where sessions, cached values, live values, jobs, schedule locks, rate limit counts, presence members, Web Vitals, notifications and files live for everything naming no store of its own: `sqliteData('data/app.sqlite')`, `pgData(db)` on Postgres (kayjs-auth keeps its users in the database a `sqliteData(path)` or `pgData(url)` names, as `AppStore.database`, the url, and kayjs-mail, kayjs-ai and kayjs-cms reuse the connection `pgData` works through as `AppStore.sql`, the pool it opened from a url or the one you handed in), or `{ sessions, cache, live, jobs, rates, rooms, vitals, notifications, files }` of your own, each with an optional `ping` that `health` runs and `close` that a stop calls. `files` is only what the app writes, `diskFiles()` by default, or `s3Files()`: see [File storage](/guides/file-storage). Kay's rate limits (actions, API routes, `rateLimit()`, proof of work and kay's own routes) and kayjs-auth's count in memory while their store fails, and for ten seconds after one takes over eight seconds to answer. See [Background jobs](/guides/background-jobs) |
| `i18n` | `locales`, `defaultLocale`, and optionally `prefixDefault` or per-locale `domains`, and `paths` translating a page's path per locale, and `messages`, the folder of the message files (`src/messages` by default). See [Internationalization](/guides/i18n) |

## Assets and build

| Option | Effect |
| --- | --- |
| `images` | `quality`, `widths`, `webp`, `avif`, the densest screen an image loads for (`maxDensity`, 2 by default), the shapes `aspect` may cut to (`aspects`), `placeholder: false` to leave out the color an image shows until it loads, how long a cut variant is kept on disk (`ttl`, 30 days), the share cards' look and logo (`card`), which extra directories (`dirs`) or hosts (`remote`, with `remoteMaxSize` and `remoteTimeout`) are resized, and the app's own lookup of private images (`resolve`, `guard`). See [Styling and assets](/essentials/styling-and-assets) |
| `fonts` | Self-hosted fonts, from files or a Fontsource package |
| `plugins` | Bun plugins the browser build runs, such as Tailwind's |
| `budget` | The most JavaScript (`js`), CSS (`css`) or whole page (`weight`) one page may load, compressed, as `'20kb'`, and the worst EcoIndex `grade` it may have. `kay build` warns with `over-budget` for a page over it. All are off until set. See [Set a budget](/guides/performance#set-a-budget) |
| `timeZone` | The IANA time zone dates are written in, `Europe/Paris`: `formatDate`, a message's date and the relative time tooltip, on the server and in islands, unless a call names its own. The server's and the visitor's zone by default, and the zone a `schedule` cron is read in unless it names a `tz`. See [Internationalization](/guides/i18n#sizes-durations-and-the-time-zone) |
| `minify` | Minifies the browser build. On for `kay build`, off for `kay dev` unless set to `true` |
| `librarySettings` | A module for a kay library's settings, such as `{ '@kaynooo/kayjs-ui': './src/ui-settings.ts' }`. See [kayjs-ui](/libraries/kayjs-ui) |
| `lints` | The level of each lint. See [Checks](/reference/checks) |

## Server

| Option | Effect |
| --- | --- |
| `security` | The CSP and security headers every response carries, or `false` for none; every cookie set with `ctx.cookies.set` is `HttpOnly`, `SameSite=Lax`, `Secure` over https and under the `base`, a call's own option winning, unless `cookies: false`; in production with `site` set, `hosts` (on by default, `false` turns it off, `*.example.com` answers one label under a domain) answers 421 to a `Host` that is not the site's. See [Security](/guides/security) |
| `proxy` | How many proxies sit in front (`true` for one, a number for more, `false` for none), or `{ header }` naming the header they set. `trusted` lists the public ranges they reach the server from. `key` names a header carrying a key shared with the proxy, and a request without it gets 403; `open` lists paths left out. See [Trust a proxy](/guides/security#trust-a-proxy) |
| `secret` | The app's one secret, at least 32 random characters: it seals `session()`, signs form stamps, links to private files and the flash cookie, and keys `preview`. `KAY_SECRET` when left out. A list, or commas in `KAY_SECRET`, rotates it: the first seals and signs and every one opens and verifies: sessions, kayjs-auth's data, stamps, private-file links, the flash cookie and preview links. See [The app secret](/guides/sessions-and-guards#the-app-secret) |
| `health` | The route a load balancer polls, `/_kay/health` by default. `{ path, check, timeout }` renames it and fails it with 503 when `check` returns false, throws or takes longer than `timeout` (5 seconds by default). `false` serves none |
| `checks` | Your own checks, which `kay check` runs with its own: each gets `{ root, routes, report }` and reports problems with `report()`. See [Your own checks](/reference/cli#your-own-checks) |
| `env` | The compose file or files and the example env file, `{ compose: 'compose.prod.yaml', example: '.env.example' }`, that `kay check` and `kay env` compare with the declared variables. `false` turns the comparison off, the default one included. |
| `requireGuards` | `true` makes every page, action, endpoint and API module answer 403 unless a guard covers it or it sets `guards: false`. `kay build --static` refuses to export such a page. A library's routes are left open. See [Sessions and guards](/guides/sessions-and-guards) |
| `cors` | The origins every API module accepts that sets no `cors` of its own, as `api({ cors })` takes them. `api({ cors: false })` opts a module out. An endpoint file sets its own in `page.cors`. See [Calls from other sites](/guides/api-routes#calls-from-other-sites) |
| `mcp` | `true` serves an MCP endpoint at `/mcp`, or at `{ path }`, for AI agents, at most 120 requests a client a minute unless `{ rateLimit }` says otherwise, and only to a client sending `{ key }` as a bearer token when it is set, with a tool per API route or action that sets `tool`. Off by default. See [API routes](/guides/api-routes#letting-an-agent-call-the-app-over-mcp) |
| `openapi` | `true` serves an OpenAPI document of the API modules at `/api/openapi.json`. `{ reference: true }` adds a page at `/api/reference`. `path` and `referencePath` move them, `title` and `version` fill the document's `info`, and `dev: true` serves both under `kay dev` alone. See [API routes](/guides/api-routes#openapi) |
| `live` | `{ connections, perMinute }`: how many live connections one client address holds at once (20) and opens a minute (120). See [Live values and realtime](/guides/live-and-realtime) |
| `metrics` | `true` serves `/metrics` in the Prometheus text format: requests by route and status, their durations, scheduled runs, cache reads and live connections. Answered only to a request straight from this machine or a private network, or carrying `KAY_METRICS_TOKEN` as a bearer token. `{ path }` moves it. Off by default |
| `jobs` | `{ guard, path }` serves a page of the queues' jobs at `/_kay/jobs` with retry and delete buttons. The guard is a guard or a list of them, run on every request, and without one the server does not start. Off by default |

<ReadMore href="/llms/project">Every option and its exact behaviour are in the full project reference, with the head, locales and production references for the topics above.</ReadMore>
