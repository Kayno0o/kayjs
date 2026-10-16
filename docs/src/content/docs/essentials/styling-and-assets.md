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

Imported `with { type: 'text' }`, a stylesheet is its text as a string instead. Use it to inline CSS in a mail or a generated page. It joins no page stylesheet.

```ts
import theme from './theme.css' with { type: 'text' }
```

## Linked or inlined styles

In production, a page with small styles writes them into its head, so the browser paints without a stylesheet request. A page whose styles compress to more than about 14 KB links them instead. One cached file then serves every page.

The size counts a page's styles together with its layouts'. Two pages of one app can differ. `kay dev` always links them.

When a page's styles are over that size, kay still tries to inline what the page uses. It writes into the head only the rules for the classes its components write, Tailwind's included, if they fit under the same size.

kay links the full stylesheet for the rest. The browser fetches it without holding the first paint back. Once it arrives, every rule is there, so a class built at runtime or coming from your data still gets its style. You need no safelist and no setting.

Until that stylesheet arrives, such a class shows unstyled. A class no page names, from Markdown for instance, stays inline on every page. A page whose own rules are still over the size links its stylesheets as before.

When you move to another page without a reload, the next page's rules come with it.

Set `inlineStyles` in `kay.config.ts` to force one way.

```ts
export default defineConfig({ inlineStyles: false })
```

`true` inlines every page's styles, whatever their size. `false` links them all.

## Tailwind

Tailwind runs as a build plugin. Install it with `bun add -d tailwindcss bun-plugin-tailwind`, then register it in `kay.config.ts`.

```ts
import tailwind from 'bun-plugin-tailwind'
import { defineConfig } from 'kay/server'

export default defineConfig({ plugins: [tailwind] })
```

Import `src/app.css` from the root `_layout.kay`. It needs only `@import 'tailwindcss';`. Classes written with the `.class` shorthand work too.

## Public files

A file in `public/` is served at its path as it is: `public/robots.txt` is `/robots.txt`. Use it for anything that needs a fixed URL.

An HTML file is also served without its `.html`, as a static host does. `public/shelf/books.html` is at `/shelf/books`, and `public/shelf/index.html` at `/shelf`.

Dotfiles, `.env` files and editor backups are neither served nor exported. `.well-known/` is the one dotfile folder that is served. A static export keeps `.htaccess` and `.nojekyll`, which the host reads.

<ReadMore href="/llms/styles-and-assets">The editor backup extensions that are left out, and how a public file and a page with the same URL conflict.</ReadMore>

## Imported images

Import an image for its URL. It is a content-named path served with long-lived caching.

```kay
---
import logo from '../logo.png'
---
img(src={logo} alt="Logo")
```

The same goes for fonts, video, audio, PDF and wasm files.

## Wasm and workers

A `.wasm` file is imported for its URL as well, then loaded from it.

```kay
---
import add from '../add.wasm'

onMount(async () => {
  const { instance } = await WebAssembly.instantiateStreaming(fetch(add))
})
---
p Ready
```

A worker is a file named with `new URL`. kay bundles it on its own, imports included.

```ts
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
```

This works in development, in a build and in a compiled executable. When an island or its worker compiles wasm, kay's content security policy allows it.

Threads sharing memory need extra headers, which the reference lists.

## Responsive images

An imported PNG, JPEG, WebP, GIF or AVIF used as an `img` `src` gets a `srcset` of WebP variants, with AVIF for browsers that take it. It also gets its `width` and `height`.

Write `sizes` to say how large the image shows. The browser then loads the smallest variant that fits.

```kay
---
import hero from '../hero.jpg'
---
img(src={hero} sizes="(min-width: 60rem) 50vw, 100vw" alt="The workshop")
```

Every image a template or a collection entry's Markdown writes loads lazily and decodes off the main thread, unless it says otherwise. Give the hero image above the fold `loading="eager"` or `fetchpriority="high"`, so it does not show late.

`image(hero, { aspect: '16/9' })` from `kay/image` cuts the variants to a shape instead of relying on `object-fit`. Spread its result on the element.

```kay
---
import { image } from 'kay/image'
import hero from '../hero.jpg'
---
img({...image(hero, { aspect: '16/9', sizes: '100vw' })} alt="The workshop")
```

### Private images

An image the app keeps behind a session, such as one looked up by a database id, goes through the same variants. `images.resolve` gives its file and `images.guard` admits the request.

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

`image('/media/42', { width, height })` then resizes that `src`.

The `src` is whatever a visitor asks for. Look it up, and never join it to a directory.

## Fonts

`fonts` in `kay.config.ts` self-hosts font files, declared with `@font-face` in every page's head. List an installed Fontsource package once.

```ts
export default defineConfig({
  fonts: [
    { fontsource: '@fontsource-variable/inter' },
    { family: 'Lora', src: 'src/fonts/lora-italic.woff2', style: 'italic' },
  ],
})
```

Then use the family as usual: `font-family: Inter, system-ui, sans-serif`. With Tailwind, write `@theme { --font-sans: Inter, system-ui, sans-serif; }`.

While a font loads, kay shows the text in a stand-in sized like it. It reads the font's metrics and declares a fallback such as `"Inter Fallback"`, a resized Arial, Times New Roman or Courier New.

kay adds the fallback right after the family in your stylesheets' `font-family`, `font` and `--font-*` values. The page then barely moves when the font arrives. A stack in an inline `style` attribute is left as you wrote it.

<Callout type="note">

Faces load once the page uses them. `preload: true` fetches one with the page, on a Fontsource entry too, but can hold back the first paint on a slow phone.

</Callout>

## Icons

Any Iconify set installed as `@iconify-json/<prefix>` is imported one icon at a time, as `~icons/<prefix>/<name>`. Imported under a capitalised name, it is a tag that takes classes.

```kay
---
import Home from '~icons/tabler/home'
---
a(href="/")
  Home.size-5
  | Home
```

The icon sizes to the surrounding text and takes its colour from `currentColor`.

An icon without text beside it needs `role="img"` and an `aria-label`.

<ReadMore href="/llms/styles-and-assets">Worker and wasm details, fixed-width and cropped images, remote and uploaded images, share cards, AVIF settings and runtime icon lookup.</ReadMore>
