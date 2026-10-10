---
title: Styling and assets
order: 7
description: Component stylesheets, Tailwind, public files, imported and responsive images, fonts and icons.
---

Styles and assets are imported where they are used, and Bun bundles them.

## Component styles

A component script imports its stylesheet. Each page links one stylesheet per layout, then its own, holding the CSS of every component it renders.

```kay
---
import './card.css'
---
article.card
  slot
```

`@import`, nesting and relative `url()` assets work in the stylesheet.

## Tailwind

Tailwind runs as a build plugin. Install it with `bun add -d tailwindcss bun-plugin-tailwind`, then register it in `kay.config.ts`:

```ts
import tailwind from 'bun-plugin-tailwind'
import { defineConfig } from 'kay/server'

export default defineConfig({ plugins: [tailwind] })
```

Import `src/app.css` from the root `_layout.kay`. It needs only `@import 'tailwindcss';`, and classes written with the `.class` shorthand are picked up too.

## Public files

A file in `public/` is served at its path as it is: `public/robots.txt` is `/robots.txt`. Use it for anything that needs a fixed URL.

## Imported images

Import an image for its URL, a content-named path served with a year of immutable caching:

```kay
---
import logo from '../logo.png'
---
img(src={logo} alt="Logo")
```

The same goes for fonts, video, audio and PDF files.

## Responsive images

An imported PNG, JPEG or WebP used as an `img` `src` gets a `srcset` of WebP variants, with AVIF for browsers that take it, and its `width` and `height`. Write `sizes` to say how large it shows:

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
