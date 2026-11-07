import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Elysia, t } from 'elysia'
import { bodyHtml, collection, renderMarkdown } from '../src/content'
import { registerCollections } from '../src/content/edit'
import { contentPlace, loadedBodies, loadEntries, setContentPlace } from '../src/content/load'
import { shutdown } from '../src/server'
import { fixtureCopy } from './scratch'
import { pages } from './shared-pages'

const schema = t.Object({ title: t.String() })
const HOSTILE = '[bad](javascript:alert(1)) [ok](/docs/a.md)\n\n<script>alert(2)</script>\n\n<img src=x onerror=alert(3)>\n\n## Part\n\n```ts\nlet a\n```\n'
const STRIP_MD = (html: string) => html.replace(/href="([^"]*)\.md"/g, 'href="$1"')

async function inProject<Result>(run: (root: string) => Promise<Result>): Promise<Result> {
  const root = await mkdtemp(join(tmpdir(), 'kay-content-transform-'))
  const before = contentPlace()

  try {
    setContentPlace(root, root)

    return await run(root)
  }
  finally {
    setContentPlace(before.root, before.base)
    await rm(root, { recursive: true, force: true })
  }
}

describe('a markdown transform', () => {
  it('runs before headings are read and code is highlighted, so a shifted heading is listed as shifted and the highlighter has the last word', async () => {
    const seen: string[] = []
    const { html, headings } = await renderMarkdown('# Top\n\n## Part\n\n```ts\nlet a\n```\n', {
      transform: (markup) => {
        seen.push(markup)

        return markup.replace(/<(\/?)h2/g, '<$1h3').replace(/<(\/?)h1/g, '<$1h2')
      },
      highlight: (code, language) => `<pre data-lang="${language}">${code}</pre>`,
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('<pre><code class="language-ts">')
    expect(headings.map(({ depth, id }) => [depth, id])).toEqual([[2, 'top'], [3, 'part']])
    expect(html).toContain('<h3 id="part"><a href="#part">Part</a></h3>')
    expect(html).toContain('<pre data-lang="ts">')
  })

  it('names renderMarkdown when it throws, gives a non-text result or is async', async () => {
    await expect(renderMarkdown('x', { transform: () => {
      throw new Error('boom')
    } })).rejects.toThrow('renderMarkdown: the markdown transform threw: boom')
    await expect(renderMarkdown('x', { transform: (() => 3) as never })).rejects.toThrow('gave number')
    expect((await renderMarkdown('x', { transform: async markup => markup.replace('x', 'y') })).html).toContain('y')
  })

  it('keeps the components of an entry: dropping, adding or moving a placeholder fails naming the file', async () => {
    await inProject(async () => {
      const compile = async (transform: (html: string) => string) => (await loadedBodies('things', { highlight: undefined, headingLinks: true, transform }, false, true)).compile('a', 'A\n\n<Callout>in</Callout>\n')

      await expect(compile(html => html.replace(/<\/?kay-component[^>]*>/g, ''))).rejects.toThrow('things/a: the markdown transform dropped')
      await expect(compile(html => `${html}<kay-component n="1" />`)).rejects.toThrow('things/a: the markdown transform dropped')
      expect((await compile(html => `<div>${html}</div>`)).segments).toHaveLength(3)
    })
  })

  it('cannot reintroduce raw HTML into a loader\'s untrusted body, and passes the author\'s own through in a trusted one', async () => {
    const evil = (html: string) => `${html}<script>alert(4)</script><a href="javascript:alert(5)" onclick="x()">more</a><div class="admonition">note</div>`

    await inProject(async () => {
      const safe = JSON.stringify((await (await loadedBodies('things', { highlight: undefined, headingLinks: true, transform: evil }, true, true)).compile('a', HOSTILE)).segments)

      expect(safe).not.toMatch(/<script|javascript:|onclick|onerror/)
      expect(safe).toContain('more')

      const trusted = JSON.stringify((await (await loadedBodies('things', { highlight: undefined, headingLinks: true, transform: evil }, false, true)).compile('a', HOSTILE)).segments)

      expect(trusted).toContain('<div class=\\"admonition\\">')
    })
  })

  it('gives a localized loader\'s entries the locale and the slug apart, and names the entry that throws', async () => {
    const seen: unknown[] = []
    const loaded = collection({ name: 'tr-notes', load: () => [{ slug: 'fr/bonjour', data: { title: 'B' }, body: 'x' }, { slug: 'en/hello', data: { title: 'H' }, body: 'y' }] }, {
      schema,
      localized: true,
      transform: (html, entry) => {
        seen.push(entry)

        return html
      },
    })

    const failing = collection({ name: 'tr-fails', load: () => [{ slug: 'one', data: { title: 'B' }, body: 'x' }] }, { schema, transform: () => {
      throw new Error('nope')
    } })

    await inProject(async () => {
      await loaded.all()
      expect(seen).toEqual([{ file: 'tr-notes/fr/bonjour', slug: 'bonjour', locale: 'fr' }, { file: 'tr-notes/en/hello', slug: 'hello', locale: 'en' }])
      await expect(failing.all()).rejects.toThrow('tr-fails/one: the markdown transform threw: nope')
    })
  })

  it('makes the CMS preview match the compile: bodyHtml applies the collection\'s transform, the config\'s unless the collection sets one', async () => {
    const notes = collection({ name: 'pv-notes', load: () => [] }, { schema, transform: (html, entry) => `${html}<!-- ${entry.locale ?? '-'}/${entry.slug} -->` })
    const before = registerCollections([['notes', notes]])

    try {
      expect(await bodyHtml('hi', { collection: 'notes', slug: 'a', locale: 'fr' })).toBe('<p>hi</p>\n<!-- fr/a -->')
      expect(await bodyHtml('hi', { collection: 'other', slug: 'a' })).toBe('<p>hi</p>\n')
      expect(await bodyHtml('hi')).toBe('<p>hi</p>\n')
    }
    finally {
      registerCollections(before)
    }
  })

  it('compiles a folder\'s entries again when the transform\'s source changes, and keeps them while it does not', async () => {
    await inProject(async (root) => {
      await Bun.write(join(root, 'posts/a.md'), '---\ntitle: A\n---\n\n[x](/p.md)\n')

      const first = await loadEntries('posts', { live: true, transform: STRIP_MD })
      const again = await loadEntries('posts', { live: true, transform: STRIP_MD })
      const changed = await loadEntries('posts', { live: true, transform: html => STRIP_MD(html).replace('<p>', '<p class="a">') })

      expect(first[0]!.segments).toEqual(['<p><a href="/p">x</a></p>\n'])
      expect(again[0]!.segments).toEqual(first[0]!.segments)
      expect(changed[0]!.segments).toEqual(['<p class="a"><a href="/p">x</a></p>\n'])
    })
  })

  it('reports a folder entry\'s throw as a content problem naming its file, the entries around it unharmed', async () => {
    await inProject(async (root) => {
      await Bun.write(join(root, 'posts/a.md'), '---\ntitle: A\n---\n\nfine\n')
      await Bun.write(join(root, 'posts/b.md'), '---\ntitle: B\n---\n\nbroken\n')

      await expect(loadEntries('posts', { live: true, transform: (_, entry) => {
        throw new Error(`no ${entry.slug}`)
      } })).rejects.toThrow(/posts\/a\.md.*the markdown transform threw: no a/s)
    })
  })

  it('stays one renderer however many entries: a corpus of 3,000 entries calls the transform once each', async () => {
    let calls = 0
    const rows = Array.from({ length: 3000 }, (_, index) => ({ slug: `n${index}`, data: { title: `N${index}` }, body: `# T${index}\n\n[l](/x/${index}.md) text\n` }))
    const big = collection({ name: 'big-corpus', load: () => rows }, { schema, transform: (html) => {
      calls++

      return STRIP_MD(html)
    } })

    await inProject(async () => {
      await big.all()
      expect(calls).toBe(3000)
    })
  })
})

describe('a markdown transform on a page under a base', () => {
  let copy: string
  let app: Elysia

  beforeAll(async () => {
    copy = await fixtureCopy('content')

    const config = join(copy, 'src/content.config.ts')

    await Bun.write(config, `${await Bun.file(config).text()}
export const notes = collection('content/notes', {
  schema: t.Object({ title: t.String() }),
  transform: (html, entry) => html.replace(/href="\\.\\/([^"]*)\\.md"/g, 'href="/notes/$1"').replace(/<img src="([^"]*)"/g, '<img src="/img/$1"').replace(/<h2/g, '<h3').replace(/<\\/h2/g, '</h3').replace('<p>', \`<p data-entry="\${entry.slug}">\`),
})
`)
    await Bun.write(join(copy, 'src/content/notes/one.md'), '---\ntitle: One\n---\n\n[two](./two.md) ![pic](cat.png)\n\n## Part\n\n<script>alert(1)</script>\n')
    await Bun.write(join(copy, 'src/routes/notes/[slug].kay'), '--- server\nimport { notes } from \'../../content.config\'\n\nconst note = await notes.get(ctx.params.slug) ?? ctx.notFound()\nconst { Content } = note\n---\narticle\n  Content\n')
    app = new Elysia().use(await pages({ dirs: { routes: `${copy}/src/routes` }, contentConfig: `${copy}/src/content.config.ts`, prebuilt: false, security: false, site: 'https://x.example', base: '/root', trailingSlash: 'always' }))
  }, 60_000)

  afterAll(async () => {
    await shutdown(app)
    await rm(copy, { recursive: true, force: true })
  })

  it('rebases the links and images it writes like authored ones, and its headings keep their anchor', async () => {
    const html = await (await app.handle(new Request('http://localhost/notes/one/'))).text()

    expect(html).toContain('<a href="/root/notes/two">two</a>')
    expect(html).toContain('src="/root/img/cat.png"')
    expect(html).toContain('<p data-entry="one">')
    expect(html).toContain('<h3 id="part"><a href="#part">Part</a></h3>')
  })
})
