---
title: Styling and assets
order: 7
description: Component stylesheets, Tailwind, public files, imported and responsive images, fonts and icons.
---

Styles and assets are imported where they are used, and Bun bundles them.

## Component styles

A component script imports its stylesheet. A page links the stylesheets of its layouts, then its own, holding the CSS of every component it renders.

```kay
---
import './card.css'
---
article.card
  slot
```

`@import`, nesting and relative `url()` assets work in the stylesheet.

Imported `with { type: 'text' }`, a stylesheet is its text as a string instead, for a mail or a generated page to inline. It joins no page stylesheet.

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

Import `src/app.css` from the root `_layout.kay`. It needs only `@import 'tailwindcss';`, and classes written with the `.class` shorthand work too.

## Public files

A file in `public/` is served at its path as it is: `public/robots.txt` is `/robots.txt`. Use it for anything that needs a fixed URL.

An HTML file is also served without its `.html`, as a static host does: `public/shelf/books.html` at `/shelf/books`, and `public/shelf/index.html` at `/shelf`.

## Imported images

Import an image for its URL, a content-named path served with long-lived caching:

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

A worker is a file named with `new URL`, and kay bundles it on its own, imports included:

```ts
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
```

This works in development, in a build and in a compiled executable. When an island or its worker compiles wasm, kay's content security policy allows it. Threads sharing memory need extra headers, which the reference lists.

## Responsive images

An imported PNG, JPEG, WebP, GIF or AVIF used as an `img` `src` gets a `srcset` of WebP variants, with AVIF for browsers that take it, and its `width` and `height`. Write `sizes` to say how large it shows, and the browser loads the smallest variant that fits:

```kay
---
import hero from '../hero.jpg'
---
img(src={hero} sizes="(min-width: 60rem) 50vw, 100vw" alt="The workshop")
```

`image(hero, { aspect: '16/9' })` from `kay/image` cuts the variants to a shape instead of relying on `object-fit`. Spread its result on the element:

```kay
---
import { image } from 'kay/image'
import hero from '../hero.jpg'
---
img({...image(hero, { aspect: '16/9', sizes: '100vw' })} alt="The workshop")
```

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

`image('/media/42', { width, height })` then resizes that `src`. The `src` is whatever a visitor asks for: look it up, never join it to a directory.

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

Then use the family as usual: `font-family: Inter, system-ui, sans-serif`, or with Tailwind `@theme { --font-sans: Inter, system-ui, sans-serif; }`.

<Callout type="note">

Faces load once the page uses them. `preload: true` fetches one with the page, but can hold back the first paint on a slow phone.

</Callout>

## Icons

Any Iconify set installed as `@iconify-json/<prefix>` is imported one icon at a time, as `~icons/<prefix>/<name>`. Imported under a capitalised name, it is a tag that takes classes:

```kay
---
import Home from '~icons/tabler/home'
---
a(href="/")
  Home.size-5
  | Home
```

The icon sizes to the surrounding text and takes its colour from `currentColor`. An icon without text beside it needs `role="img"` and an `aria-label`.

<ReadMore href="/llms/styles-and-assets">Inlined styles, worker and wasm details, fixed-width and cropped images, private, remote and uploaded images, share cards, AVIF settings, public file conflicts and runtime icon lookup are in the full styles and assets reference.</ReadMore>
