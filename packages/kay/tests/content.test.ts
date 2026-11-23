import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contentPlugin, defineCollection, parseFrontmatter, renderMarkdown } from '../../plugin-content/src/index'
import { alternateLinks, formatDate, formatNumber, i18n, localizePath } from '../../plugin-i18n/src/index'
import { images, shareCard } from '../../plugin-images/src/index'
import { build } from '../src/build/index'
import { testApp } from '../src/test/index'

const tempDirs: string[] = []
function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const d of tempDirs)
    rmSync(d, { recursive: true, force: true })
})

describe('@kayjs/content — Zero-dependency Bun.markdown collections & RSS', () => {
  it('parses YAML frontmatter, renders GFM with unique heading IDs, TOC, and reading time', () => {
    const raw = `---
title: "Hello Kay v2"
date: 2026-11-23
draft: false
tags:
  - bun
  - tsx
---
# Intro

Welcome to **Kay v2**.

## Why Signals?

Fast fine-grained updates.

## Why Signals?

Duplicate headings get disambiguated IDs.
`
    const { data, body } = parseFrontmatter(raw)
    expect(data).toEqual({
      title: 'Hello Kay v2',
      date: '2026-11-23',
      draft: false,
      tags: ['bun', 'tsx'],
    })

    const rendered = renderMarkdown(body)
    expect(rendered.html).toContain('<h1 id="intro">Intro</h1>')
    expect(rendered.html).toContain('<h2 id="why-signals">Why Signals?</h2>')
    expect(rendered.html).toContain('<h2 id="why-signals-1">Why Signals?</h2>')
    expect(rendered.html).toContain('<strong>Kay v2</strong>')
    expect(rendered.headings).toEqual([
      { level: 1, id: 'intro', text: 'Intro' },
      { level: 2, id: 'why-signals', text: 'Why Signals?' },
      { level: 2, id: 'why-signals-1', text: 'Why Signals?' },
    ])
    expect(rendered.readingMinutes).toBe(1)
  })

  it('validates frontmatter with Standard Schema, filters drafts, prerenders 0 KB JS blog pages, and emits /rss.xml', async () => {
    const dir = makeTemp('kay-content-')
    const contentDir = join(dir, 'content/posts')
    mkdirSync(contentDir, { recursive: true })
    mkdirSync(join(dir, 'src/routes/blog'), { recursive: true })

    writeFileSync(join(contentDir, 'first.md'), `---
title: First Post
date: 2026-11-20
description: Introducing Kay v2
tags: [release, bun]
---
## Overview

Zero JS static blog post.
`)

    writeFileSync(join(contentDir, 'second.md'), `---
title: Second Post
date: 2026-11-23
description: Faster than ever
tags: [perf]
---
## Numbers

18ms builds.
`)

    writeFileSync(join(contentDir, 'secret-draft.md'), `---
title: Unfinished Draft
date: 2026-11-24
draft: true
---
Hidden from production.
`)

    const postSchema = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate(raw: unknown) {
          const d = (raw ?? {}) as Record<string, unknown>
          if (typeof d.title !== 'string' || !d.title)
            return { issues: [{ message: 'title is required' }] }
          return {
            value: {
              title: d.title,
              date: String(d.date ?? ''),
              description: typeof d.description === 'string' ? d.description : '',
              draft: d.draft === true,
              tags: Array.isArray(d.tags) ? d.tags.map(String) : [],
            },
          }
        },
      },
    }

    const posts = defineCollection({ dir: contentDir, schema: postSchema })
    expect(posts.all().map(p => p.slug)).toEqual(['second', 'first']) // newest first, draft excluded
    expect(posts.byTag('bun').map(p => p.slug)).toEqual(['first'])
    expect(posts.paths('/blog')).toEqual(['/blog/second', '/blog/first'])

    // Expose collection path to route files
    const contentPkg = join(import.meta.dir, '../../plugin-content/src/index.ts')
    writeFileSync(join(dir, 'src/posts.ts'), `
      import { defineCollection } from ${JSON.stringify(contentPkg)}
      export const posts = defineCollection<{ title: string, date: string, description: string }>({
        dir: ${JSON.stringify(contentDir)},
      })
    `)

    writeFileSync(join(dir, 'src/routes/blog/[slug].tsx'), `
      import { Head } from 'kay'
      import { posts } from '../../posts'

      export const prerender = true
      export function paths() { return posts.paths('/blog') }

      export default async function PostPage({ params }: { params: { slug: string } }) {
        const post = posts.get(params.slug)!
        return (
          <article>
            <Head><title>{post.data.title}</title></Head>
            <h1>{post.data.title}</h1>
            <div innerHTML={post.html} />
          </article>
        )
      }
    `)

    const plugin = contentPlugin({
      feeds: [{
        path: '/rss.xml',
        title: 'Kay Blog',
        description: 'Updates',
        site: 'https://kayjs.dev',
        linkPrefix: '/blog',
        collection: posts,
      }],
    })

    const manifest = await build({ root: dir, plugins: [plugin], static: true })
    // 0 KB JS for the entire static blog!
    expect(manifest.runtimeScript).toBeUndefined()
    expect(existsSync(join(dir, 'dist/public/rss.xml'))).toBe(true)

    const rss = readFileSync(join(dir, 'dist/public/rss.xml'), 'utf8')
    expect(rss).toContain('<title>Second Post</title>')
    expect(rss).toContain('<link>https://kayjs.dev/blog/second</link>')
    expect(rss).not.toContain('Unfinished Draft')

    const app = await testApp({ root: dir, plugins: [plugin], prebuilt: true })
    const res = await app.get('/blog/second')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).not.toContain('<script')
    expect(html).toContain('<h2 id="numbers">Numbers</h2>')

    const rssRes = await app.get('/rss.xml')
    expect(rssRes.status).toBe(200)
    expect(await rssRes.text()).toContain('<title>First Post</title>')
  })

  it('supports nested YAML frontmatter, Shiki-style highlight hook, MDX-lite embedded components, localized prerendering, and shareCard()', async () => {
    const dir = makeTemp('kay-content-adv-')
    const enDir = join(dir, 'content/posts/en')
    const frDir = join(dir, 'content/posts/fr')
    mkdirSync(enDir, { recursive: true })
    mkdirSync(frDir, { recursive: true })
    mkdirSync(join(dir, 'src/routes/posts'), { recursive: true })

    // 1. Nested YAML + custom highlight + embedded self-closing & paired components
    const md = `---
title: "Five frameworks"
date: 2026-10-19
social:
  x: "Short post"
  reddit:
    title: "Long title"
    subreddits: [webdev, bun]
---
## Benchmarks

<BarChart
  title="Build time"
  rows={[
    {"label": "Kay v2", "value": 18.8},
    {"label": "Astro", "value": 1190}
  ]}
/>

<Note tone="warning">
Watch out for **hydration**!
</Note>

\`\`\`ts
const tag = '<BarChart title="inside code fence" />'
\`\`\`
`
    const { data, body } = parseFrontmatter(md)
    expect((data.social as { reddit: { subreddits: string[] } }).reddit.subreddits).toEqual(['webdev', 'bun'])

    const rendered = renderMarkdown(body, {
      highlight: (code, lang) => `<pre data-lang="${lang ?? 'text'}"><code>${code.replaceAll('<', '&lt;')}</code></pre>`,
      components: {
        BarChart: ({ title, rows }: { title: string, rows: Array<{ label: string, value: number }> }) =>
          `<figure data-chart="${title}">${rows.map(r => `<span>${r.label}:${r.value}</span>`).join('')}</figure>`,
        Note: ({ tone, children }: { tone: string, children: { __html: string } }) =>
          `<aside data-note="${tone}">${children.__html}</aside>`,
      },
    })
    expect(rendered.html).toContain('<figure data-chart="Build time"><span>Kay v2:18.8</span><span>Astro:1190</span></figure>')
    expect(rendered.html).toContain('<aside data-note="warning"><p>Watch out for <strong>hydration</strong>!</p></aside>')
    expect(rendered.html).toContain('<pre data-lang="ts"><code>const tag = \'&lt;BarChart title="inside code fence" />\'</code></pre>')

    // 1b. Nested components wrapping fenced code blocks, headingLinks, locale forwarding, and resolveImage
    const nested = renderMarkdown(
      `## Code Tabs\n\n![Demo](./img/demo.png)\n\n<Tabs>\n<Tab label="Kay">\n\n\`\`\`kay\nh1 Hello\n\`\`\`\n\n</Tab>\n</Tabs>\n`,
      {
        headingLinks: true,
        locale: 'fr',
        highlight: (code, lang) => `<pre data-lang="${lang}"><code>${code}</code></pre>`,
        resolveImage: src => ({ src: src.replace('./img/', '/img/'), width: 800, height: 450, srcset: '/img/demo-640w.webp 640w' }),
        components: {
          Tabs: ({ children }: { children: { __html: string } }) => `<div class="tabs">${children.__html}</div>`,
          Tab: ({ label, locale, children }: { label: string, locale: string, children: { __html: string } }) =>
            `<section data-tab="${label}" data-locale="${locale}">${children.__html}</section>`,
        },
      },
    )
    expect(nested.html).toContain('<h2 id="code-tabs"><a href="#code-tabs">Code Tabs</a></h2>')
    expect(nested.html).toContain('<img src="/img/demo.png" alt="Demo" srcset="/img/demo-640w.webp 640w" width="800" height="450" loading="lazy" decoding="async">')
    expect(nested.html).toContain('<section data-tab="Kay" data-locale="fr"><pre data-lang="kay"><code>h1 Hello</code></pre></section>')

    // 2. i18n helpers
    expect(localizePath('/posts/hello', 'fr', 'en', ['en', 'fr'])).toBe('/fr/posts/hello')
    expect(localizePath('/fr/posts/hello', 'en', 'en', ['en', 'fr'])).toBe('/posts/hello')
    expect(alternateLinks('/posts/hello', { site: 'https://log.kaynooo.fr', locales: ['en', 'fr'], defaultLocale: 'en' })).toEqual([
      { locale: 'en', href: 'https://log.kaynooo.fr/posts/hello' },
      { locale: 'fr', href: 'https://log.kaynooo.fr/fr/posts/hello' },
    ])
    expect(formatNumber(1234.5, 'en-US')).toContain('1,234.5')
    expect(formatDate('2026-11-23', 'en-US', { year: 'numeric' })).toBe('2026')

    // 3. Localized static export + shareCard() OG image generation
    writeFileSync(join(enDir, 'hello.md'), `---
title: Hello English
date: 2026-11-20
---
English content.
`)
    writeFileSync(join(frDir, 'hello.md'), `---
title: Bonjour Francais
date: 2026-11-20
---
Contenu francais.
`)

    const contentPkg = join(import.meta.dir, '../../plugin-content/src/index.ts')
    const imagesPkg = join(import.meta.dir, '../../plugin-images/src/index.ts')
    writeFileSync(join(dir, 'src/posts.ts'), `
      import { defineCollection } from ${JSON.stringify(contentPkg)}
      export const posts = defineCollection<{ title: string }>({
        dir: ${JSON.stringify(join(dir, 'content/posts'))},
        localized: true,
        defaultLocale: 'en',
      })
    `)
    writeFileSync(join(dir, 'src/routes/posts/[slug].tsx'), `
      import { Head } from 'kay'
      import { shareCard } from ${JSON.stringify(imagesPkg)}
      import { posts } from '../../posts'

      export const prerender = true
      export function paths() { return posts.paths('/posts', 'en') }

      export default async function Post({ params, locals }: { params: { slug: string }, locals: { locale?: string } }) {
        const loc = locals.locale ?? 'en'
        const post = posts.get(params.slug, loc)!
        const og = shareCard({ title: post.data.title, badge: 'devlog' })
        return (
          <article>
            <Head>
              <title>{post.data.title}</title>
              <meta property="og:image" content={og} />
            </Head>
            <h1>{post.data.title}</h1>
            <div innerHTML={post.html} />
          </article>
        )
      }
    `)

    const plugins = [
      i18n({ locales: ['en', 'fr'], defaultLocale: 'en', site: 'https://log.kaynooo.fr' }),
      images({ card: { site: 'https://log.kaynooo.fr', background: '#090c13', color: '#dbe0ea' } }),
    ]

    const manifest = await build({ root: dir, plugins, static: true })
    expect(manifest.runtimeScript).toBeUndefined() // 0 KB JS!
    // Both /posts/hello and /fr/posts/hello statically exported!
    const enHtmlPath = join(dir, 'dist/static/posts/hello/index.html')
    const frHtmlPath = join(dir, 'dist/static/fr/posts/hello/index.html')
    expect(existsSync(enHtmlPath)).toBe(true)
    expect(existsSync(frHtmlPath)).toBe(true)

    const enHtml = readFileSync(enHtmlPath, 'utf8')
    const frHtml = readFileSync(frHtmlPath, 'utf8')
    expect(enHtml).toContain('<html lang="en">')
    expect(enHtml).toContain('<h1>Hello English</h1>')
    expect(enHtml).toContain('hreflang="fr" href="https://log.kaynooo.fr/fr/posts/hello"')
    expect(frHtml).toContain('<html lang="fr">')
    expect(frHtml).toContain('<h1>Bonjour Francais</h1>')

    // OG shareCard file exists in dist/static/og/!
    const ogMatch = enHtml.match(/https:\/\/log\.kaynooo\.fr(\/og\/[^"]+)/)
    expect(ogMatch).not.toBeNull()
    expect(existsSync(join(dir, 'dist/static', ogMatch![1]!))).toBe(true)
  })
})

void shareCard
