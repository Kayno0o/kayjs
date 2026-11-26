import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { content, defineCollection, parseFrontmatter, renderMarkdown } from '../../plugin-content/src/index'
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

    // get() never leaves the collection folder, whatever the slug or locale
    writeFileSync(join(dir, 'content/outside.md'), '---\ntitle: Outside\n---\nPrivate.\n')
    mkdirSync(join(contentDir, 'nested'))
    writeFileSync(join(contentDir, 'nested/deep.md'), '---\ntitle: Deep\n---\nNested.\n')
    expect(posts.get('../outside')).toBeUndefined()
    expect(posts.get('nested/../../outside')).toBeUndefined()
    expect(posts.get('nested/deep')?.data.title).toBe('Deep')
    rmSync(join(contentDir, 'nested'), { recursive: true, force: true })
    posts.clearCache()
    const localizedPosts = defineCollection({ dir: contentDir, localized: true })
    expect(localizedPosts.get('outside', '..')).toBeUndefined()
    expect(localizedPosts.all('..')).toEqual([])

    // Expose collection path to route files
    const contentPkg = join(import.meta.dir, '../../plugin-content/src/index.ts')
    writeFileSync(join(dir, 'src/posts.ts'), `
      import { defineCollection } from ${JSON.stringify(contentPkg)}
      export const posts = defineCollection<{ title: string, date: string, description: string }>({
        dir: ${JSON.stringify(contentDir)},
      })
    `)

    writeFileSync(join(dir, 'src/routes/blog/[slug].tsx'), `
      import { Head } from '@kayjs/kay'
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

    const plugin = content({
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
    // 0 KB JS for the entire static blog, and no server/ folder left in dist/!
    expect(manifest.runtimeScript).toBeUndefined()
    expect(existsSync(join(dir, 'dist/server'))).toBe(false)
    expect(existsSync(join(dir, 'dist/rss.xml'))).toBe(true)

    const rss = readFileSync(join(dir, 'dist/rss.xml'), 'utf8')
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
      import { Head } from '@kayjs/kay'
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
    // Both /posts/hello and /fr/posts/hello statically exported directly into dist/!
    const enHtmlPath = join(dir, 'dist/posts/hello/index.html')
    const frHtmlPath = join(dir, 'dist/fr/posts/hello/index.html')
    expect(existsSync(join(dir, 'dist/server'))).toBe(false)
    expect(existsSync(enHtmlPath)).toBe(true)
    expect(existsSync(frHtmlPath)).toBe(true)

    const enHtml = readFileSync(enHtmlPath, 'utf8')
    const frHtml = readFileSync(frHtmlPath, 'utf8')
    expect(enHtml).toContain('<html lang="en">')
    expect(enHtml).toContain('<h1>Hello English</h1>')
    expect(enHtml).toContain('hreflang="fr" href="https://log.kaynooo.fr/fr/posts/hello"')
    expect(frHtml).toContain('<html lang="fr">')
    expect(frHtml).toContain('<h1>Bonjour Francais</h1>')

    // OG shareCard file exists in dist/og/!
    const ogMatch = enHtml.match(/https:\/\/log\.kaynooo\.fr(\/og\/[^"]+)/)
    expect(ogMatch).not.toBeNull()
    expect(existsSync(join(dir, 'dist', ogMatch![1]!))).toBe(true)
  })

  it('#3516: supports lazy render() without content/meta split and auto-wires @kayjs/images for relative Markdown images', async () => {
    const dir = makeTemp('kay-content-3516-')
    const imgDir = join(dir, 'src/content/posts/img')
    mkdirSync(imgDir, { recursive: true })
    mkdirSync(join(dir, 'src/routes/posts'), { recursive: true })

    // Valid 1x1 PNG
    const pngBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    writeFileSync(join(imgDir, 'chart.png'), pngBytes)
    writeFileSync(join(dir, 'src/content/posts/hello.md'), `---
title: Auto Images & Single Collection
date: 2026-11-24
---
## Overview

![Chart](./img/chart.png)

<Badge label="fast" />
`)

    // 1. Unit check: lazy render() is NOT called on metadata operations, throws clearly if html read early, runs once on entry.render()
    let renderLoaderCalls = 0
    const col = defineCollection({
      dir: join(dir, 'src/content/posts'),
      render: async () => {
        renderLoaderCalls++
        return {
          components: {
            Badge: ({ label }: { label: string }) => `<span data-badge="${label}">${label}</span>`,
          },
        }
      },
    })

    expect(col.paths('/posts')).toEqual(['/posts/hello'])
    expect(col.all().length).toBe(1)
    expect(renderLoaderCalls).toBe(0)

    const e = col.get('hello')!
    expect(() => e.html).toThrow(/await entry\.render\(\)/)
    const rendered = await e.render()
    expect(renderLoaderCalls).toBe(1)
    expect(rendered.html).toContain('<span data-badge="fast">fast</span>')
    // Cached synchronously afterwards
    expect(e.html).toContain('<span data-badge="fast">fast</span>')
    expect(e.headings).toEqual([{ level: 2, id: 'overview', text: 'Overview' }])
    await e.render()
    expect(renderLoaderCalls).toBe(1)

    // 2. Full build check: single src/content.ts imported by kay.config.ts + routes, auto-wired @kayjs/images with zero resolveImage boilerplate
    const contentPkg = join(import.meta.dir, '../../plugin-content/src/index.ts')
    const imagesPkg = join(import.meta.dir, '../../plugin-images/src/index.ts')

    writeFileSync(join(dir, 'src/Badge.tsx'), `
      export function Badge({ label }: { label: string }) {
        return <span class="badge">{label}</span>
      }
    `)
    writeFileSync(join(dir, 'src/content.ts'), `
      import { defineCollection } from ${JSON.stringify(contentPkg)}
      export const posts = defineCollection<{ title: string }>({
        dir: 'src/content/posts',
        render: async () => {
          const { Badge } = await import('./Badge')
          return { components: { Badge } }
        },
      })
    `)
    writeFileSync(join(dir, 'kay.config.ts'), `
      import { content } from ${JSON.stringify(contentPkg)}
      import { images } from ${JSON.stringify(imagesPkg)}
      import { posts } from './src/content'

      export default {
        plugins: [
          images({ widths: [640], formats: ['webp'], quality: 80 }),
          content({
            feeds: [{
              path: '/rss.xml',
              title: 'Auto Feed',
              description: 'Single collection',
              site: 'https://example.com',
              collection: posts,
              linkPrefix: '/posts',
            }],
          }),
        ],
      }
    `)
    writeFileSync(join(dir, 'src/routes/posts/[slug].tsx'), `
      import { posts } from '../../content'
      export const prerender = true
      export function paths() { return posts.paths('/posts') }
      export async function load({ params }: { params: { slug: string } }) {
        const post = posts.get(params.slug)!
        await post.render()
        return { post }
      }
      export default function PostPage({ data }: { data: { post: { data: { title: string }, html: string } } }) {
        return <article><h1>{data.post.data.title}</h1><div innerHTML={data.post.html} /></article>
      }
    `)

    const manifest = await build({ root: dir, static: true })
    expect(manifest.runtimeScript).toBeUndefined()
    expect(existsSync(join(dir, 'dist/server'))).toBe(false)
    const html = readFileSync(join(dir, 'dist/posts/hello/index.html'), 'utf8')
    expect(html).toContain('<span class="badge">fast</span>')
    // Relative ./img/chart.png was automatically optimized into /img/chart-... without any resolveImage code!
    const imgMatch = html.match(/src="(\/img\/chart-[^"]+)"/)
    expect(imgMatch).not.toBeNull()
    expect(existsSync(join(dir, 'dist', imgMatch![1]!))).toBe(true)
    expect(readFileSync(join(dir, 'dist/rss.xml'), 'utf8')).toContain('<title>Auto Images &amp; Single Collection</title>')
  })

  it('#3554: kay check validates frontmatter with file:line and content() auto-watches registered collections', async () => {
    const dir = makeTemp('kay-content-check-')
    mkdirSync(join(dir, 'src/content/posts'), { recursive: true })
    mkdirSync(join(dir, 'src/routes'), { recursive: true })

    writeFileSync(join(dir, 'src/content/posts/good.md'), '---\ntitle: Good Post\ndate: 2026-01-01\n---\nHello\n')
    writeFileSync(join(dir, 'src/content/posts/bad.md'), '---\ntitle: ""\ndate: not-a-date\n---\nBroken\n')
    writeFileSync(join(dir, 'src/routes/index.tsx'), 'export default function Home() { return <h1>Hi</h1> }\n')

    const contentPkg = join(import.meta.dir, '../../plugin-content/src/index.ts')
    writeFileSync(join(dir, 'src/collections.ts'), `
      import { defineCollection } from ${JSON.stringify(contentPkg)}
      const schema = {
        '~standard': {
          version: 1 as const,
          vendor: 'test',
          validate(raw: unknown) {
            const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
            const issues: Array<{ message: string, path: string[] }> = []
            if (typeof o.title !== 'string' || o.title.trim().length === 0)
              issues.push({ message: 'title is required', path: ['title'] })
            if (typeof o.date !== 'string' || !/^\\d{4}-\\d{2}-\\d{2}$/.test(o.date))
              issues.push({ message: 'date must be YYYY-MM-DD', path: ['date'] })
            if (issues.length > 0)
              return { issues }
            return { value: { title: o.title, date: o.date } }
          },
        },
      }
      export const posts = defineCollection({ dir: 'src/content/posts', schema })
    `)

    // Notice kay.config.ts passes content() with NO collections list and NO import of src/collections.ts!
    writeFileSync(join(dir, 'kay.config.ts'), `
      import { content } from ${JSON.stringify(contentPkg)}
      export default { plugins: [content()] }
    `)

    const { checkProject } = await import('../src/cli/check')
    const checked = await checkProject(dir, { skipTypecheck: true })
    expect(checked.ok).toBe(false)
    expect(checked.errors).toContain('src/content/posts/bad.md:2:1: error: @kayjs/content: title: title is required')
    expect(checked.errors).toContain('src/content/posts/bad.md:3:1: error: @kayjs/content: date: date must be YYYY-MM-DD')

    // Auto-registration: watchPaths includes the collection directory without listing it in content()
    const plugin = content()
    const watched = typeof plugin.watchPaths === 'function' ? plugin.watchPaths(dir) : []
    expect(watched).toContain(join(dir, 'src/content/posts'))
  })
})

void shareCard
