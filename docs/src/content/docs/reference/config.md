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
  proxy: { hops: 1 },
  compress: true,
  lints: { 'positional-key': 'deny' },
})
```

Every option is optional. The ones below are the common ones, the rest are in the full reference.

## Site and SEO

| Option | Effect |
| --- | --- |
| `site` | The public origin, for canonical links, the sitemap and social URLs. `SITE_URL` when left out. See [Head and SEO](/essentials/head-and-seo) |
| `seo` | What every page's head starts from: `name`, `titleTemplate`, `description`, `image`, `twitter`, `jsonLd`. See [Head and SEO](/essentials/head-and-seo) |
| `favicon` | A square image of 512 px or more, served as the favicon and the manifest icons. `false` serves none |
| `manifest` | The web manifest: `shortName`, `themeColor`, `display` |
| `offline` | A service worker keeping the build's files and some pages for offline visitors |
| `lang` | The `lang` of the `html` element |

## Routing

| Option | Effect |
| --- | --- |
| `routes` | The page directory, `src/routes` by default. See [Routing](/essentials/routing) |
| `api` | The directory of API modules, `src/api` by default. See [API routes](/guides/api-routes) |
| `redirects` | Old paths sent to new ones with a 308 |
| `rewrite` | Serves a request from another path, such as a host's pages from a section |
| `base` | Where the site is mounted when not at its host's root, `/docs` |
| `trailingSlash` | `never` (the default), `always` or `ignore` |
| `prefetch` | When links are fetched ahead: `moderate` (on hover) by default |
| `navigation` | The in-place page swap, on by default. `false` loads every page fully. See [Islands](/essentials/islands) |

## Content and i18n

| Option | Effect |
| --- | --- |
| `content` | The module exporting the collections, `src/content.config.ts` by default. See [Content](/guides/content) |
| `preview` | Lets an editor see drafts on the live site, with a `secret` |
| `i18n` | `locales`, `defaultLocale`, and optionally `prefixDefault` or per-locale `domains`. See [Internationalization](/guides/i18n) |

## Assets and build

| Option | Effect |
| --- | --- |
| `images` | `quality`, `avif`, and which extra directories (`dirs`) or hosts (`remote`) are resized. See [Styling and assets](/essentials/styling-and-assets) |
| `fonts` | Self-hosted fonts, from files or a Fontsource package |
| `plugins` | Bun plugins the browser build runs, such as Tailwind's |
| `inlineStyles` | Writes each page's styles into its head in production |
| `minify` | Minifies the browser build, on for `kay build` |
| `publicEnv` | The environment variables islands may read, as a schema |
| `settings` | A module for a kay library's settings, such as `{ '@kaynooo/kayjs-ui': './src/ui-settings.ts' }`. See [kayjs-ui](/libraries/kayjs-ui) |
| `lints` | The level of each lint. See [Checks](/reference/checks) |

## Server

| Option | Effect |
| --- | --- |
| `security` | The CSP and security headers every response carries, or `false` for none. See [Deployment](/guides/deployment) |
| `proxy` | The proxies in front of the server, for the client address rate limits count |
| `compress` | Brotli and gzip for pages rendered per request, when no proxy does it |
| `health` | The route a load balancer polls, `/_kay/health` by default |
| `log` | One line per request, `'json'`, a function, or `false` |
| `bodyLimit` | The most bytes an action or API request may send, 1 MB by default |
| `shutdownTimeout` | How long a stopping server lets open requests finish, 10 seconds by default |
| `onError` | Receives every error a load, render, guard or action throws, for an error tracker |
| `serverTiming`, `tracer` | A `Server-Timing` header, and OpenTelemetry spans |

<ReadMore href="/llms/project">Every option and its exact behaviour are in the full project reference, with the head, locales and production references for the topics above.</ReadMore>
