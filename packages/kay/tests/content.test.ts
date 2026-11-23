import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contentPlugin, defineCollection, parseFrontmatter, renderMarkdown } from '../../plugin-content/src/index'
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
})
