---
title: Styling and assets
order: 7
description: Component stylesheets, Tailwind, public files, imported and responsive images, fonts and icons.
---

Styles and assets are imported where they are used, and Bun bundles them.

## Component styles

A component script imports its stylesheet. Each page links one stylesheet per layout, then its own, holding the CSS of every component it renders, those its server fence imports included.

```kay
---
import './card.css'
---
article.card
  slot
```

`@import`, nesting and relative `url()` assets work in the stylesheet.

Imported `with { type: 'text' }`, a stylesheet is its text instead, a string in server code and in the executable `kay build --compile` writes, for a mail or a generated page to inline; it joins no page stylesheet. The text is the file as written, a Tailwind entry's `@import` lines included, not the CSS built from it, and an island importing it carries it in its script. A stylesheet imported under a name without the attribute is refused by `kay check` (`css-import-without-text`).

```ts
import theme from './theme.css' with { type: 'text' }
```

## Tailwind

Tailwind runs as a build plugin. Install it with `bun add -d tailwindcss bun-plugin-tailwind`, then register it in `kay.config.ts`:

```ts
import tailwind from 'bun-plugin-tailwind'
import { defineConfig } from 'kay/server'

export default defineConfig({ plugins: [tailwind] })
```

Import `src/app.css` from the root `_layout.kay`. It needs only `@import 'tailwindcss';`, and classes written with the `.class` shorthand are picked up too.

## Public files

A file in `public/` is served at its path as it is: `public/robots.txt` is `/robots.txt`. Use it for anything that needs a fixed URL. One at a path a page serves, in any locale, or an endpoint, a redirect, an API route or a feed, stops the server at boot; kay's own sitemap, `robots.txt`, favicons and `/sw.js` give way to it.

An HTML file is also served without its `.html`, and an `index.html` at its directory, as a static host does: `public/shelf/books.html` at `/shelf/books`, `public/shelf/index.html` at `/shelf`. A site exported into `public/` keeps its links that way. Anything else served at that exact path, a file, a page or a redirect, wins.

## Imported images

Import an image for its URL, a content-named path served with a year of immutable caching:

```kay
---
import logo from '../logo.png'
---
img(src={logo} alt="Logo")
```

The same goes for fonts, video, audio, PDF and wasm files.

## Wasm and workers

A `.wasm` file is imported for its URL as well, then loaded from it:

```kay
---
import add from '../add.wasm'

onMount(async () => {
  const { instance } = await WebAssembly.instantiateStreaming(fetch(add))
})
---
p Ready
```

Server code importing one `with { type: 'file' }` keeps Bun's meaning, the file's own path, embedded in an executable.

An island, and any package it imports, names a file shipped beside a module with `new URL('./file', import.meta.url)`. kay writes that file with the assets and bundles a script on its own as a worker, its imports included, so `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })` works in development, in a build and in a compiled executable. The URL is relative to the island's chunk, so it holds under a `base`.

- A package starting itself as its threads' worker, as an emscripten build does, gets a bundle of its own, and one building its worker from a blob, as qr-scanner does, works as it is.
- Only a relative path written as a string, naming a file, is shipped: a directory, a template with a part, an absolute path or a call inside a comment is left as written.
- A worker bundles as an island does, its stylesheets dropped and its API imports as stubs, but without the config's `plugins`. One that fails to build fails the build, each error at its `file:line:column`.
- When an island or its worker compiles wasm, kay's content security policy adds `'wasm-unsafe-eval'` to `script-src`, and `worker-src 'self' blob:` when one starts a worker from a blob. They join a `csp` setting its own `script-src` or `worker-src` too, unless it sets that directive to `false` or `'none'`.
- Threads sharing memory need a page isolated from other origins: set `security: { headers: { 'cross-origin-embedder-policy': 'credentialless' } }`; kay already sends `cross-origin-opener-policy: same-origin`. Set it in kay.config.ts for the whole site, or in a page's `page` for that page alone, which links then load fully.

## Responsive images

An imported PNG, JPEG, WebP, GIF or AVIF used as an `img` `src` gets a `srcset` of WebP variants, with AVIF for browsers that take it, and its `width` and `height`. Write `sizes` to say how large it shows:

```kay
---
import hero from '../hero.jpg'
---
img(src={hero} sizes="(min-width: 60rem) 50vw, 100vw" alt="The workshop")
```

An image always drawn at one width in pixels, such as a logo with `sizes="95px"`, gets one variant per screen density instead, from 1x to `images.maxDensity`, 3x when it is `Infinity`, each rounded up to a width the image route makes, a multiple of 16 below 320: `96w` and `192w` for that logo, never wider than the image itself.

`image(hero, { aspect: '16/9' })` from `kay/image` cuts the variants to a shape instead of relying on `object-fit`. Spread its result on the element:

```kay
---
import { image } from 'kay/image'
import hero from '../hero.jpg'
---
img({...image(hero, { aspect: '16/9', sizes: '100vw' })} alt="The workshop")
```

An animated GIF keeps its frames: it gets no variants and is served as it is.

### Private images

Images the app keeps behind a session, looked up its own way such as by a database id, go through the same variants once `images.resolve` gives their file and `images.guard` admits the request:

```ts
import { defineConfig } from 'kay/server'
import { guard } from 'kay'
import { mediaPath } from './src/media'

export default defineConfig({
  images: {
    guard: guard((ctx) => {
      if (!ctx.locals.session.get('userId'))
        ctx.deny(401)
    }),
    resolve: async src => src.startsWith('/media/') ? mediaPath(src.slice(7)) : undefined,
  },
})
```

`image('/media/42', { width, height })` then resizes that `src`. The answers are private to the browser, revalidated by their ETag, and `resolve` gets the guard's `ctx` too. There `ctx.locals` holds what the app's plugins add, such as the session, but not Elysia's `cookie`, `query`, `headers` or `body`: read `ctx.cookies`, `ctx.url` and `ctx.request` instead. The `src` is whatever a visitor asks for: look it up, never join it to a directory, since the path `resolve` returns is read as it is. A static export has no image route, so it refuses `resolve`.

## Fonts

`fonts` in `kay.config.ts` self-hosts font files, declared with `@font-face` in every page's head. An installed Fontsource package is listed once:

```ts
export default defineConfig({
  fonts: [
    { fontsource: '@fontsource-variable/inter' },
    { family: 'Lora', src: 'src/fonts/lora-italic.woff2', style: 'italic' },
  ],
})
```

`subset: ['latin', 'latin-ext']` on a Fontsource entry declares each subset with its `unicode-range`, so a page downloads only the files its text needs.

Then use the family as usual: `font-family: Inter, system-ui, sans-serif`, or with Tailwind `@theme { --font-sans: Inter, system-ui, sans-serif; }`.

<Callout type="note">

`preload: true` on a face fetches it with the page, but on a slow phone it can hold back the first paint. Leave it off unless text painting in that font first matters more.

</Callout>

## Icons

Any Iconify set installed as `@iconify-json/<prefix>` is imported one icon at a time, as `~icons/<prefix>/<name>`. Imported under a capitalised name, it is a tag:

```kay
---
import Home from '~icons/tabler/home'
---
a(href="/")
  Home.size-5
  | Home
```

The icon sizes to the surrounding text and takes its colour from `currentColor`. An icon without text beside it needs `role="img"` and an `aria-label`.

<ReadMore href="/llms/styles-and-assets">Inlined styles, remote and uploaded images, share cards, AVIF settings and runtime icon lookup are in the full styles and assets reference.</ReadMore>
