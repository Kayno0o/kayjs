---
title: "@kayjs/content"
description: Zero-dependency Markdown collections powered by Bun.markdown and Bun.YAML with Standard Schema frontmatter, Shiki highlighting, MDX-lite TSX components, and RSS.
section: plugins
order: 3
---

`@kayjs/content` turns folders of Markdown files into typed, lazy-rendered collections using Bun's native Zig `Bun.markdown.html()` and `Bun.YAML.parse()` — **zero npm Markdown parser dependencies** and **0 KB** client JS.

## Defining a collection

Define one collection and import it from `kay.config.ts`, index pages, and post pages alike. Use `render` to lazy-load heavy Shiki highlighters and embedded TSX components only when a page renders Markdown:

```ts
// src/content.ts
import { defineCollection } from '@kayjs/content'

export const posts = defineCollection({
  dir: 'src/content/posts',
  localized: true,          // Reads <dir>/<locale>/<slug>.md
  defaultLocale: 'en',
  headingLinks: true,       // Wraps h2-h6 in self-referencing <a href="#id">
  schema: postSchema,       // Any Standard Schema validator
  render: async () => {
    const [{ highlight }, { Note }] = await Promise.all([
      import('./highlight'),
      import('./components/Note'),
    ])
    return { highlight, components: { Note } }
  },
})
```

In your detail route's `load()`, call `await entry.render()` once — `entry.html` and `entry.headings` are then cached synchronously. Routes and config hooks that only read frontmatter (`.all()`, `.paths()`, RSS, sitemaps) never load Shiki or TSX components.

## Automatic `@kayjs/images` optimization

When `@kayjs/images` is enabled in `kay.config.ts`, relative Markdown images (`![Diagram](./img/arch.png)`) are automatically optimized using your `images()` plugin widths, formats, quality, and disk cache — no manual `resolveImage` wiring needed. Pass `resolveImage: false` to opt out, or pass a custom `resolveImage` function to override.

## Fast lazy rendering & O(1) lookup

- `posts.all(locale)` and `posts.paths('/posts', locale)` parse frontmatter only (skipping `draft: true` files before Markdown/Shiki runs).
- `entry.html` and `entry.headings` render lazily and memoize on first access.
- `posts.get(slug, locale)` resolves `<dir>/<slug>.md` directly in O(1) without scanning every other file in the directory.

## Embedded TSX components (MDX-lite)

Use registered components directly inside `.md` files with string props, `{json}` expressions, or nested Markdown bodies:

```markdown
<Note title="Heads up">
Supports **bold**, lists, and fenced code blocks inside components.
</Note>
```

## RSS feeds (`contentPlugin`)

```ts
import { contentPlugin } from '@kayjs/content'

export default defineConfig({
  plugins: [
    contentPlugin({
      feeds: [{
        path: '/rss.xml',
        title: 'My Blog',
        description: 'Latest updates',
        site: 'https://example.com',
        collection: posts,
        linkPrefix: '/posts',
      }],
    }),
  ],
})
```
