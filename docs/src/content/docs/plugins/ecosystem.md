---
title: "@kayjs/i18n · mail · spa · tailwind · icons"
description: Composable plugins for localization, email delivery, opt-in SPA swaps, Tailwind v4, and inline SVG icon sets.
section: plugins
order: 6
---

Every remaining capability is an opt-in package built strictly on `KayPlugin` via `definePlugin(...)`.

## Conventions & ordering

- **Stateless plugins** export a single camelCase factory matching the package name from the package root: `tailwind()`, `icons()`, `images()`, `i18n()`, `content()`, `seo()`, `spa()`, `mcp()`.
- **Stateful service plugins** also give routes and actions a handle. Their `createX()` returns one object that is both the plugin and the handle: `plugins: [auth, mail, rooms]` registers what `createAuth()`, `createMailer()` and `createRooms()` returned.
- **Client-safe UI barrel exception**: `@kayjs/ui` exports only browser-safe JSX components; its build plugin lives at `@kayjs/ui/plugin` (`ui()`).
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

Zero-runtime inline SVGs from any `@iconify-json/*` icon pack:

```tsx
import { Icon } from '@kayjs/icons'
import arrowRight from '~icons/tabler/arrow-right'

<Icon icon={arrowRight} class="size-4" />
```

`kay icons-find garbage` prints the icons of the installed sets that match, such as `~icons/tabler/trash`, so an agent imports a name that exists. It also matches related words, typos and half-typed words. An app's own icon picker gets the same search from `findIcons(set, query, { limit, offset })` in `@kayjs/icons/search`. Call it on the server: it reads a 2 MB word table on first use.

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
