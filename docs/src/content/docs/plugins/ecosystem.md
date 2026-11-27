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
- **Declarative ordering**: plugins declare `enforce: 'pre' | 'post'`, `after: ['...']`, `providesLocals`, and `readsLocals`. Core sorts plugins deterministically (`pre` → normal → `post`, respecting `after`) and fails at startup if a plugin declares `readsLocals` before its provider runs. Two plugins with the same `name` also fail, since `after` and the build data find a plugin by its name. An `after` name that no plugin has counts as an optional plugin that is not installed, unless it is one typo away from a registered name: then kay fails and names it.

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

`resend()` retries a `429` or `5xx` answer twice, after the wait Resend asks for. It sends the mail's id as idempotency key, so Resend never delivers a retried mail twice. Pass `retries: 0` to turn this off.

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

`kay icons-find garbage` prints the icons of the installed sets that match, such as `~icons/tabler/trash`, so an agent imports a name that exists. It searches `@iconify-json/*` packages, `@iconify/json` (hoisted installs included), your `.svg` folders and the sets passed to `icons({ sets })`, ten icons per set unless `--limit` says otherwise; `--set tabler` searches one. Matching is English-only and covers related words (`garbage` finds `trash`), typos (`calnedar`), other forms of a word (`searching`), half-typed words (`shopp`) and two words typed apart (`sign out` finds `logout`).

An app's own icon picker gets the same search from `@kayjs/icons/search`:

- `findIcons(set, query, { limit, offset })` ranks names holding the query as whole words first (in any word order), then related words — icons answering more query words rank ahead of partial matches — and mid-word hits (`pin` in `spinner`) last. It throws on a negative or fractional `offset` (`< 0`) or `limit` (`< 1`).
- `relatedWords(word)` returns `[word, strength]` pairs for an "also searched" list.

Keep `@kayjs/icons/search` server-side: it reads a ~1.7 MB word table on first call, and `kay build` warns when an island imports it.

## `@kayjs/tailwind`

Opt-in Tailwind CSS v4 integration. `tailwind()` auto-loads `bun-plugin-tailwind` from your project and defaults to `src/app.css`:

```ts
import { tailwind } from '@kayjs/tailwind'

tailwind({ css: 'src/app.css' })
```

## `@kayjs/spa`

Multi-page navigation (`0 KB` JS) is the default, and most apps are best served by it plus [`regions()`](#regions) for the parts of a page that change in place. Add `spa()` only when an island must stay alive from one page to the next:

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
- **Styles**: after a swap the head's stylesheets are in the order the next page serves them, so the cascade is the one a full load gives. Links it adds keep every attribute.
- **Scroll**: the browser's own scroll restoring is turned off, and back and forward restore the saved offset once. An element with `data-kay-keep-scroll="key"` keeps its own offset across a swap and per history entry.
- **Motion**: the swap runs in a view transition, and not when the user asks for reduced motion.

### Regions

A link that opens a detail pane or switches a tab should not download the whole page. `regions()` swaps one part of the page and asks the server for that part alone. It works with or without `spa()`.

```ts
import { regions } from '@kayjs/spa'

export default defineConfig({
  plugins: [regions()],
})
```

Wrap the part in a `<Region>` and point links at it by name:

```tsx
import { Region } from '@kayjs/kay'

export default function Icons({ data }) {
  return (
    <main>
      <Region name="results">
        {data.items.map(i => <a href={`?icon=${i}`} data-kay-target="pane">{i}</a>)}
      </Region>
      <Region name="pane" aria-label="Icon detail">
        <h2>{data.icon}</h2>
      </Region>
    </main>
  )
}
```

The browser asks for `x-kay-region: pane`. The server skips the layouts and every other region, and sends only the inside of `pane`. Without JavaScript the link is a normal link and the whole page loads. History works as usual: each swap is an entry, and back and forward restore the region. `ctx.region` is the name asked for, so `load()` can skip data the region does not show.

- **Append**: add `data-kay-append` to a "Load more" link. The next page is added to the region and the link goes. The history entry is replaced, not pushed.
- **Forms**: a `<form method="get" data-kay-target="results">` swaps on submit, and empty fields stay out of the URL. Add `data-kay-live` to swap while the user types. A typing burst makes one history entry, and a pause of one second ends the burst. A `<form method="post" data-kay-target="x">` posts in the background, follows the redirect and swaps region `x` from the page it lands on. Without JavaScript it posts normally.
- **Motion and scroll**: a swap runs in a view transition where the browser has them, and not when the user asks for reduced motion. Each history entry remembers the scroll of the window and of the regions, and back and forward restore both. A new swap leaves the page where it is and puts the region back at its top, unless the region has `data-kay-keep-scroll`. A `#hash` link to something already on the page scrolls to it without a fetch, and after a swap the page scrolls to the hash of the new address.
- **Current page**: after a swap, links whose `href` is the new address get `aria-current="page"`, and the others lose it.
- **Weight**: the regions client is loaded only by pages that render a `<Region>`. Every other page ships none of it.
- **Keep links in step**: `data-kay-sync="q icon"` on a link copies those query params from the current URL after each swap. On an input or select it keeps the field equal to the param of its name.
- **Prefetch**: put the link inside `data-kay-prefetch` and its region is fetched on hover or focus, with the same cache as `spa()`.
- **Nesting**: a region can sit inside another, as long as each has its own name. A "Load more" link can then append to an inner list while a live search swaps the outer region. Asking for the inner region renders it alone, and the outer one is never sent. Asking for the outer region renders it with a fresh inner region, and any fetch still running for the old inner one is dropped. Back and forward work across both. The server still builds the other children of an outer region when only the inner one is asked for, but does not send them.
- **Title**: a swap sets `document.title` to what the whole page would have, `<Head>` title template included, and back and forward restore it. The server sends it in an `x-kay-title` header, so the response stays small.
- **Loading and focus**: the region gets `aria-busy="true"` when a fetch takes more than 150 ms, so you can style it. A link moves focus to the region. A region with an `aria-label` announces it. Give the region an `aria-label` that says what changed.
- **Islands** inside the new HTML hydrate as usual.
- **Redraw from script**: after a change made in the background, such as a `fetch` to an action, `await refreshRegion('side')` from `@kayjs/spa/regions` asks the server for that region at the current address again and swaps it. It adds no history entry, leaves focus where it is and skips the prefetch cache. The promise rejects when the page has no such region, the fetch fails or the answer lacks it.

If the page has no region of that name, or the fetch fails, the link loads the whole page. `kay check` reports a `data-kay-target` that names no `<Region>`. Two regions with one name throw, and a region inside a region of the same name is a compile error. If you use `spa()` too, give each path either region links or page links, not both for the same history entries.
