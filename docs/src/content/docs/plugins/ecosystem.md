---
title: "@kayjs/i18n · mail · spa · tailwind · icons"
description: Composable plugins for localization, email delivery, opt-in SPA swaps, Tailwind v4, and inline SVG icon sets.
section: plugins
order: 6
---

Every remaining capability is an opt-in package built strictly on `KayPlugin` via `definePlugin(...)`.

## Conventions & ordering

- **Stateless plugins** export a single camelCase factory matching the package name from the package root: `tailwind()`, `images()`, `i18n()`, `content()`, `seo()`, `spa()`, `mcp()`.
- **Stateful service plugins** also give routes and actions a handle. Their `createX()` returns one object that is both the plugin and the handle: `plugins: [auth, mail, rooms]` registers what `createAuth()`, `createMailer()` and `createRooms()` returned.
- **Client-safe barrels**: `@kayjs/ui` and `@kayjs/icons` export only what an island can import; their build plugins live at `@kayjs/ui/plugin` (`ui()`) and `@kayjs/icons/plugin` (`icons()`).
- **Declarative ordering**: plugins declare `enforce: 'pre' | 'post'`, `after: ['...']`, `providesLocals`, and `readsLocals`. Core sorts plugins deterministically (`pre` → normal → `post`, respecting `after`) and fails at startup if a plugin declares `readsLocals` before its provider runs.

## `@kayjs/i18n`

Prefix-free default locale with prefixed secondary locales (`/fr/...`), automatic `<html lang>` and internal `<a href="/...">` rewriting, `prerenderPaths` expansion, `hreflang` alternate links, and `Intl` helpers (`localizePath`, `alternateLinks`, `formatDate`, `formatNumber`):

```ts
import { i18n } from '@kayjs/i18n'

i18n({
  locales: ['en', 'fr'],
  defaultLocale: 'en',
  site: 'https://example.com',
  messages: { en, fr },
})
```

- Every request receives `ctx.locals.locale`, `ctx.locals.t(key)`, `ctx.locals.localize(path, target?)`, and `ctx.locals.alternates()`.
- Add `data-no-localize` to any `<a>` tag to skip automatic locale prefixing.
- Missing translation keys are reported by both `kay check` and `kay i18n-check`.

## `@kayjs/mail`

Send transactional email through Resend or any custom `MailTransport`, with a dev-only outbox preview at `/_kay/mail` (and `/_kay/mail.json`):

```ts
// src/mail.ts
import { createMailer, resend } from '@kayjs/mail'

export const mail = createMailer({
  from: 'hello@example.com',
  // Omit transport to auto-use RESEND_API_KEY when set
  transport: process.env.RESEND_API_KEY ? resend() : undefined,
})
```

Register `mail` in `kay.config.ts`. In development and tests, sent messages are recorded in `mail.outbox` and rendered at `/_kay/mail`. In `NODE_ENV=production`, the preview routes are never mounted and no outbox copy is kept in memory.

## `@kayjs/icons`

Zero-runtime inline SVGs from any `@iconify-json/*` icon pack. Register `icons()` from `@kayjs/icons/plugin` in `kay.config.ts`, then import icons anywhere, islands included:

```tsx
import { Icon } from '@kayjs/icons'
import arrowRight from '~icons/tabler/arrow-right'

<Icon icon={arrowRight} class="size-4" />
```

Registering `icons()` also types the `~icons/*` imports. A tsconfig that leaves `kay.config.ts` out gets them from `/// <reference types="@kayjs/icons/ambient" />` in a `.d.ts` file.

Your own icons go in `src/icons` as `.svg` files: `src/icons/logo.svg` imports as `~icons/local/logo`. Each file needs a `viewBox`, or a `width` and `height`. Name other folders with `icons({ dirs: { brand: 'assets/brand' } })`, or give `src/icons` another prefix with `dirs: { app: 'src/icons' }`. `kay dev` reloads an edited file.

`<Icon>` takes any SVG attribute. Your `width`, `height` and `viewBox` replace the icon's own. An icon given a non-blank `aria-label` or `aria-labelledby` gets `role="img"`; any other is `aria-hidden`.

An import of an icon or set that does not exist fails `kay check` and the build, naming the file and the closest icons that do.

`kay icons-find garbage` prints the icons of the installed sets that match, such as `~icons/tabler/trash`, so an agent imports a name that exists. It searches `@iconify-json/*` packages, `@iconify/json`, your `.svg` folders and the sets passed to `icons({ sets })`, ten icons per set unless `--limit` says otherwise; `--set tabler` searches one. It also matches related words, typos, other forms of a word, half-typed words and two words typed apart (`sign out` finds `logout`). An app's own icon picker gets the same search from `findIcons(set, query, { limit, offset })` in `@kayjs/icons/search`, which ranks icons answering more of the query's words first and throws on a negative or fractional page; `relatedWords(word)` lists the words a query also searched, with their strength. Call it on the server: it reads a 1.7 MB word table on first use, and `kay build` warns when an island imports it.

## `@kayjs/tailwind`

Opt-in Tailwind CSS v4 integration. `tailwind()` auto-loads `bun-plugin-tailwind` from your project and defaults to `src/app.css`:

```ts
import { tailwind } from '@kayjs/tailwind'

tailwind({ css: 'src/app.css' })
```

## `@kayjs/spa`

Multi-page navigation (`0 KB` JS) is the default. Add `spa()` to `plugins` to opt into in-place HTML swaps:

```ts
import { spa } from '@kayjs/spa'

export default defineConfig({
  plugins: [spa()],
})
```

- **Persistent islands**: Add `data-persist="id"` to an element or island to keep its live DOM and state across navigations.
- **Prefetch on hover/focus**: Add `data-kay-prefetch` to internal links (respects `Save-Data`).
- **Opt-out**: Add `data-no-spa` to any link that should trigger a full page load.
- **Accessibility**: Updates `<title>`, `<html lang>`, head metadata, scroll position, focus, and a polite `aria-live` route announcer.
