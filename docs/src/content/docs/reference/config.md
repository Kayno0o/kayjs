---
title: Config
order: 2
description: The options of kay.config.ts most projects set.
---
`kay.config.ts` at the project root exports the config by default. `defineConfig` types it, and `kay dev`, `kay build`, `kay check` and the server all read it.

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
  compress: false,
  lints: { 'positional-key': 'deny' },
})
```

Every option is optional. The tables give each option's default. The full reference has the rest.

## Site and SEO

| Option | Effect |
| --- | --- |
| `site` | The public origin, for canonical links, the sitemap and social URLs. `SITE_URL`, else `ORIGIN`, when left out. See [Head and SEO](/essentials/head-and-seo) |
| `seo` | What every page's head starts from: `name`, `titleTemplate`, `description`, `image`, `themeColor`, `twitter`, `jsonLd`. See [Head and SEO](/essentials/head-and-seo) |
| `robots` | Paths `/robots.txt` disallows or allows, `{ disallow: ['/admin'] }`, listed for every locale; `false` serves none. See [Head and SEO](/essentials/head-and-seo#sitemap-and-robotstxt) |
| `head` | Tags every page's head carries, written as a `head` block compiles them; the CSP lets their inline scripts through. See [Head and SEO](/essentials/head-and-seo) |
| `favicon` | A square image of 512 px or more, or a square SVG, served as the favicon and the manifest icons. `false` serves none |
| `manifest` | The web manifest: `shortName`, `themeColor`, `backgroundColor`, `display`, `orientation`, `startUrl`, `scope`, `shortcuts`, and a `maskable` image served as its maskable icons |
| `offline` | `true`, or what to keep: a service worker keeping the build's files and some pages for offline visitors. Off by default, as `false` is. Pages are kept under the path `trailingSlash` writes them at |
| `search` | `true` indexes the pages `kay build` renders, for `searchResults` to search in the browser. Off by default. See [Site search](/guides/search) |
| `lang` | The `lang` of the `html` element when `i18n` is not set, `en` by default |

## Routing

| Option | Effect |
| --- | --- |
| `entry` | The server entry, `src/server.ts` by default. Every command reads it, and `--entry` on a command wins over it. With no file there, kay serves the pages itself |
| `routes` | The page directory, `src/routes` by default. See [Routing](/essentials/routing) |
| `api` | The directory of API modules, `src/api` by default. See [API routes](/guides/api-routes) |
| `publicCache` | How long the browser keeps a public file without asking again, as globs on the served path: `{ '/fonts/**': '365d' }`. Files it leaves out revalidate. See [Styling and assets](/essentials/styling-and-assets#public-files) |
| `publicDir` | The directory of files served as they are at their path, `public` by default. See [Styling and assets](/essentials/styling-and-assets#public-files) |
| `redirects` | Old paths sent to new ones with a 308, or a 307 with `permanent: false`. See [Routing](/essentials/routing) |
| `rewrite` | A function returning the path to serve a request from, or `undefined` to serve it as it came. The browser keeps its URL |
| `base` | Where the site is mounted when it is not at its host's root, such as `/docs`. Unset by default. See [Static export and base path](/guides/static-export#mount-the-site-under-a-path) |
| `trailingSlash` | `never` (the default) redirects `/about/` to `/about`, `always` the other way, `ignore` serves both. See [Trailing slashes](/guides/static-export#trailing-slashes) |
| `prefetch` | When the browser fetches a page a link points at: `moderate` on hover (the default), `conservative` on press, `eager` as soon as it can, `false` never. A link with `data-no-prefetch`, a download, `rel="nofollow"` or a path under `/_kay/` or `/api/` is never fetched |
| `extensions` | What libraries add: their pages and API modules under a prefix, which an app file at the same path replaces, their message catalogs, config laid under the app's, page hooks, a tab for the dev tool, and a CMS's editor rendered in edit mode. See [Routing](/essentials/routing#pages-from-a-library) |
| `navigation` | The in-place page swap, on by default. `false` loads every page fully. See [Islands](/essentials/islands) |

## Content and i18n

| Option | Effect |
| --- | --- |
| `content` | The module exporting the collections, `src/content.config.ts` by default. See [Content](/guides/content) |
| `preview` | Lets an editor see drafts on the live site. `secret` signs the preview links, at least 32 random characters. `maxAge` is how long a visitor stays in preview mode, an hour by default |
| `storage` | Where `files` keeps uploads: `diskFiles()` by default, or `s3Files()`. See [File storage](/guides/file-storage) |
| `i18n` | `locales`, `defaultLocale`, and optionally `prefixDefault` or per-locale `domains`, and `paths` translating a page's path per locale. See [Internationalization](/guides/i18n) |

## Assets and build

| Option | Effect |
| --- | --- |
| `images` | `quality`, `avif`, the share cards' look and logo (`card`), which extra directories (`dirs`) or hosts (`remote`) are resized, and the app's own lookup of private images (`resolve`, `guard`). See [Styling and assets](/essentials/styling-and-assets) |
| `fonts` | Self-hosted fonts, from files or a Fontsource package |
| `plugins` | Bun plugins the browser build runs, such as Tailwind's |
| `budget` | The most JavaScript (`js`) and CSS (`css`) one page may load, compressed, as `'20kb'`. `kay build` warns with `over-budget` for a page over it. Both are off until set. See [Set a budget](/guides/performance#set-a-budget) |
| `inlineStyles` | `true` writes every page's styles into its head in production, `false` links them. Unset, a page inlines them when they compress under about 14 KB, or else the rules its own components use, linking the full stylesheet for the rest. See [Styling and assets](/essentials/styling-and-assets#linked-or-inlined-styles) |
| `minify` | Minifies the browser build. On for `kay build`, off for `kay dev` unless set to `true` |
| `publicEnv` | The environment variables islands may read, as a schema. No other variable reaches the browser |
| `settings` | A module for a kay library's settings, such as `{ '@kaynooo/kayjs-ui': './src/ui-settings.ts' }`. See [kayjs-ui](/libraries/kayjs-ui) |
| `lints` | The level of each lint. See [Checks](/reference/checks) |

## Server

| Option | Effect |
| --- | --- |
| `security` | The CSP and security headers every response carries, or `false` for none. See [Security](/guides/security) |
| `proxy` | How many proxies sit in front (`true` for one, a number for more), or `{ header }` naming the header they set. `trusted` lists the public ranges they reach the server from. See [Trust a proxy](/guides/security#trust-a-proxy) |
| `compress` | Compresses responses rendered per request. On in production; `false` when a proxy or CDN does it |
| `secret` | What signs form stamps, links to private files and the flash cookie when the app has no `session()`. At least 32 random characters; `KAY_SECRET` when left out. A `session()` secret takes its place |
| `health` | The route a load balancer polls, `/_kay/health` by default. `{ path, check }` renames it and fails it with 503 when `check` returns false or throws. `false` serves none |
| `log` | One line per request, and kay's own messages. On in production as text; `'json'` writes one JSON object each, a function receives each `LogEntry`, and `false` turns the request lines off |
| `bodyLimit` | The most bytes an action or API request may send, 1 MB by default. A bigger one answers 413. See [The request body limit](/guides/security#the-request-body-limit) |
| `requireGuards` | `true` makes every page, action, endpoint and API module answer 403 unless a guard covers it or it sets `guards: false`. `kay build --static` refuses to export such a page. A library's routes are left open. See [Sessions and guards](/guides/sessions-and-guards) |
| `mcp` | `true` serves an MCP endpoint at `/mcp` for AI agents, with a tool per API route or action that sets `tool`. Off by default. See [API routes](/guides/api-routes#letting-an-agent-call-the-app-over-mcp) |
| `openapi` | `true` serves an OpenAPI document of the API modules at `/api/openapi.json`. `{ reference: true }` adds a page at `/api/reference`. See [API routes](/guides/api-routes#openapi) |
| `shutdownTimeout` | How long a stopping server lets open requests finish, as seconds or `'30s'`. 10 seconds by default |
| `onError` | Receives every error a load, render, guard, action or API route throws, for an error tracker |
| `serverTiming` | A `Server-Timing` header on pages rendered per request. On in development, off otherwise unless set |
| `tracer` | An OpenTelemetry tracer, as `trace.getTracer('my-site')`, giving a span per page and API request. None by default |

<ReadMore href="/llms/project">Every option and its exact behaviour are in the full project reference, with the head, locales and production references for the topics above.</ReadMore>
