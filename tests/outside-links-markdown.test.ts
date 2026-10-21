import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { renderMarkdown } from '../src/content'
import { outsideLinks } from '../src/runtime/html'
import { setSite } from '../src/runtime/site'
import { pages, shutdown } from '../src/server'
import { fixtureCopy } from './scratch'

const OUT = ' target="_blank" rel="noopener"'
const BODY = '[away](https://other.example/a) [same](https://x.example/a) [root](/about) [hash](#top) [mail](mailto:a@other.example) [slashes](//evil.example/x) [own](https://other.example/b){target=_self}\n\n<a href="https://other.example/raw" target="_self">raw own</a> <a href="https://other.example/raw2" rel="author">raw rel</a> <a href=\'https://other.example/single\'>single</a>\n\n<a href="https://other.example/raw3">raw</a> <a data-target="x" href="https://other.example/raw4">data-target</a>\n'

function tag(html: string, href: string): string {
  return new RegExp(`<a [^>]*href="${href}"[^>]*>`).exec(html)?.[0] ?? ''
}

describe('renderMarkdown', () => {
  it('opens a link leaving the site in a new tab, leaving the others, a raw tag with its own target and a rel it keeps', async () => {
    setSite('https://x.example')

    const { html } = await renderMarkdown(BODY)

    expect(tag(html, 'https://other.example/a')).toContain(OUT)
    expect(tag(html, 'https://x.example/a')).not.toContain('target')
    expect(tag(html, '/about')).not.toContain('target')
    expect(tag(html, '#top')).not.toContain('target')
    expect(tag(html, 'mailto:a@other.example')).not.toContain('target')
    expect(tag(html, '//evil.example/x')).toContain(OUT)
    expect(tag(html, 'https://other.example/raw')).not.toContain('_blank')
    expect(tag(html, 'https://other.example/raw2')).toContain(' target="_blank"')
    expect(tag(html, 'https://other.example/raw2')).not.toContain('noopener')
    expect(tag(html, 'https://other.example/raw3')).toContain(OUT)
    expect(tag(html, 'https://other.example/raw4')).toContain(OUT)
  })

  it('takes any absolute link as outside while no site is known', async () => {
    setSite(undefined)

    expect(tag((await renderMarkdown(BODY)).html, 'https://x.example/a')).toContain(OUT)
  })

  it('writes none under links.outside same-tab', async () => {
    setSite('https://x.example', undefined, false, true)

    try {
      expect((await renderMarkdown(BODY)).html).not.toContain('_blank')
      expect(outsideLinks('<a href="https://other.example/">x</a>')).not.toContain('_blank')
    }
    finally {
      setSite(undefined)
    }
  })

  it('leaves the headings\' anchors alone', async () => {
    setSite('https://x.example')

    expect((await renderMarkdown('# Title\n\ntext')).html).toBe('<h1 id="title"><a href="#title">Title</a></h1>\n<p>text</p>\n')
  })
})

describe('a collection entry\'s body', () => {
  let copy: string
  let app: Elysia

  beforeAll(async () => {
    copy = await fixtureCopy('content')
    await Bun.write(join(copy, 'src/content/posts/outside.md'), `---\ntitle: Outside\ndate: 2026-09-16\n---\n\n${BODY}`)
    app = new Elysia().use(await pages({ routes: `${copy}/src/routes`, content: `${copy}/src/content.config.ts`, prebuilt: false, security: false, site: 'https://x.example', base: '/blog-root', trailingSlash: 'always' }))
  }, 60_000)

  afterAll(async () => {
    await shutdown(app)
    await rm(copy, { recursive: true, force: true })
  })

  it('opens its links leaving the site in a new tab as it renders against its site, under a base', async () => {
    const response = await app.handle(new Request('http://localhost/blog/outside/'))
    const html = await response.text()

    expect(tag(html, 'https://other.example/a')).toContain(OUT)
    expect(tag(html, 'https://x.example/a')).not.toContain('target')
    expect(tag(html, 'https://other.example/raw')).not.toContain('_blank')
    expect(tag(html, 'https://other.example/raw3')).toContain(OUT)
  })
})
