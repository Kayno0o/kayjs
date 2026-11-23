---
title: "@kayjs/images & @kayjs/seo"
description: Build-time AVIF/WebP image optimization, OG shareCard() PNG generation, self-hosted fonts, JSON-LD, sitemaps, and redirects.
section: plugins
order: 5
---

## Responsive images & OG `shareCard()` (`@kayjs/images`)

Add `images()` to `kay.config.ts` to optimize imported `.png`/`.jpg`/`.webp` assets into content-hashed AVIF & WebP variants cached in `.kay-cache/images/`:

```ts
import { images } from '@kayjs/images'

export default defineConfig({
  plugins: [
    images({
      widths: [320, 640, 960, 1280],
      formats: ['avif', 'webp'],
      card: {
        site: 'https://example.com',
        background: '#090c13',
        color: '#dbe0ea',
        accent: '#f5b83d',
      },
    }),
  ],
})
```

Render responsive images with `image()` or `<Picture>`:

```tsx
import { image, Picture } from '@kayjs/images'
import hero from '../assets/hero.jpg'

<Picture asset={hero} sizes="(min-width: 48rem) 50vw, 100vw" alt="Hero" priority />
<img {...image(hero, { sizes: '100vw' })} alt="Hero" />
```

Generate 1200×630 OG PNG cards at build time:

```tsx
import { shareCard } from '@kayjs/images'

const og = shareCard({ title: post.title, badge: 'Release' })
```

## Metadata, Self-Hosted Fonts & Sitemap (`@kayjs/seo`)

```ts
import { seo } from '@kayjs/seo'

seo({
  site: 'https://example.com',
  name: 'My Site',
  titleTemplate: '%s | My Site',
  description: { en: 'English summary', fr: 'Résumé français' },
  favicon: ['src/favicon.svg', 'src/favicon.png'],
  redirects: { '/old-url': '/new-url' },
  fonts: [
    { family: 'Chakra Petch', src: '@fontsource/chakra-petch/files/chakra-petch-latin-600-normal.woff2', weight: 600 },
  ],
})
```

`@kayjs/seo` emits immutable hashed `.woff2` files, injects `<link rel="preload" as="font">` + `@font-face` CSS, applies `titleTemplate`, adds canonical URLs, and generates `/sitemap.xml`.
