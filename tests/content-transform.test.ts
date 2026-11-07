import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Elysia, t } from 'elysia'
import { contentChecks } from '../src/check/project'
import { bodyHtml, collection, renderMarkdown } from '../src/content'
import { registerCollections } from '../src/content/edit'
import { contentPlace, loadedBodies, loadEntries, markdownOf, setContentPlace, setMarkdownDefaults } from '../src/content/load'
import { compileMarkdown, MarkdownError } from '../src/content/markdown'
import { contained, footnoted } from '../src/content/markdown-extensions'
import { shutdown } from '../src/server'
import { fixtureCopy } from './scratch'
import { pages } from './shared-pages'

const schema = t.Object({ title: t.String() })
const HOSTILE = '[bad](javascript:alert(1)) [ok](/docs/a.md)\n\n<script>alert(2)</script>\n\n<img src=x onerror=alert(3)>\n\n## Part\n\n```ts\nlet a\n```\n'
const STRIP_MD = (html: string) => html.replace(/href="([^"]*)\.md"/g, 'href="$1"')

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  }
  catch (error) {
    return error
  }

  return undefined
}

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

  it('keeps the components of an entry: dropping, adding or reordering a placeholder fails naming the file', async () => {
    await inProject(async () => {
      const compile = async (transform: (html: string) => string) => (await loadedBodies('things', { transform }, { sanitize: false, preview: true })).compile('a', 'A\n\n<Callout>one</Callout>\n\n<Callout>two</Callout>\n')

      await expect(compile(html => html.replace(/<\/?kay-component[^>]*>/g, ''))).rejects.toThrow('things/a: the markdown transform dropped')
      await expect(compile(html => `${html}<kay-component n="1" />`)).rejects.toThrow('things/a: the markdown transform dropped')
      await expect(compile(html => html.replace(/(<kay-component n="0">.*?<\/kay-component>)([\s\S]*)(<kay-component n="1">.*?<\/kay-component>)/, '$3$2$1'))).rejects.toThrow('things/a: the markdown transform dropped, added or reordered')
      expect((await compile(html => `<div>${html}</div>`)).segments).toHaveLength(5)
    })
  })

  it('cannot reintroduce raw HTML into a loader\'s untrusted body, and passes the author\'s own through in a trusted one', async () => {
    const evil = (html: string) => `${html}<script>alert(4)</script><a href="javascript:alert(5)" onclick="x()">more</a><div class="admonition">note</div>`

    await inProject(async () => {
      const safe = JSON.stringify((await (await loadedBodies('things', { transform: evil }, { sanitize: true, preview: true })).compile('a', HOSTILE)).segments)

      expect(safe).not.toMatch(/<script|javascript:|onclick|onerror/)
      expect(safe).toContain('more')

      const trusted = JSON.stringify((await (await loadedBodies('things', { transform: evil }, { sanitize: false, preview: true })).compile('a', HOSTILE)).segments)

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
      await expect(failing.all()).rejects.toThrow('tr-fails/one:1 the markdown transform threw: nope')
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

describe('what a markdown hook reports', () => {
  it('names the entry once, keeps the original error as the cause, and reports an async rejection', async () => {
    await inProject(async () => {
      const failure = new Error('nope')
      const bodies = await loadedBodies('things', { transform: async () => Promise.reject(failure) }, { sanitize: false, preview: true })
      const error = await rejection(bodies.compile('a', 'x')) as MarkdownError

      expect(error).toBeInstanceOf(MarkdownError)
      expect(error.message).toBe('things/a: the markdown transform threw: nope')
      expect(error.bare).toBe('the markdown transform threw: nope')
      expect(error.cause).toBe(failure)
    })
  })

  it('names a folder entry\'s file once in the problem a build reports', async () => {
    await inProject(async (root) => {
      await Bun.write(join(root, 'posts/a.md'), '---\ntitle: A\n---\n\nfine\n')

      const error = await rejection(loadEntries('posts', { live: true, preprocess: () => {
        throw new Error('bad preprocess')
      } })) as Error

      expect(error.message.match(/posts\/a\.md/g)).toHaveLength(1)
      expect(error.message).toContain('the markdown preprocess threw: bad preprocess')
    })
  })

  it('refuses a bound function, whose source the cache cannot read', () => {
    const bound = String as never

    expect(() => markdownOf({ transform: bound })).toThrow('bound or native function')
    expect(() => markdownOf({ preprocess: bound })).toThrow('markdown.preprocess')
  })

  it('reports a throwing transform to kay check, naming the entry', async () => {
    const copy = await fixtureCopy('content')

    try {
      const config = join(copy, 'src/content.config.ts')

      await Bun.write(config, (await Bun.file(config).text()).replace('components: { Callout, Counter },', 'components: { Callout, Counter },\n  transform: () => { throw new Error(\'check me\') },'))

      const { problems } = await contentChecks(copy, {})

      expect(problems.some(problem => problem.message.includes('the markdown transform threw: check me'))).toBe(true)
    }
    finally {
      await rm(copy, { recursive: true, force: true })
    }
  })
})

describe('a markdown preprocess', () => {
  it('runs on the source before components are read, so what it writes is a component', async () => {
    await inProject(async () => {
      const bodies = await loadedBodies('things', { preprocess: (markdown, entry) => markdown.replace('{{note}}', `<Callout>${entry.slug}</Callout>`) }, { sanitize: false, preview: true })
      const { segments } = await bodies.compile('a', 'Hi\n\n{{note}}\n')

      expect(segments).toContainEqual(expect.objectContaining({ component: 'Callout' }))
    })
  })

  it('works in renderMarkdown with the same function as a collection takes', async () => {
    const preprocess = (markdown: string, entry: { file: string }) => `${markdown}\n\n${entry.file}`

    expect((await renderMarkdown('Hi', { preprocess })).html).toContain('<p>renderMarkdown</p>')
    expect((await renderMarkdown('Hi', { preprocess, entry: { file: 'notes/a.md', slug: 'a' } })).html).toContain('<p>notes/a.md</p>')
  })
})

describe('the entry a hook is given', () => {
  const seenIn = (seen: unknown[]) => (html: string, entry: unknown) => {
    seen.push(entry)

    return html
  }

  it('is the same file for a folder entry in the build and in the preview, a new entry included', async () => {
    await inProject(async (root) => {
      await Bun.write(join(root, 'posts/a.md'), '---\ntitle: A\n---\n\nbody\n')

      const built: unknown[] = []
      const previewed: unknown[] = []

      await loadEntries('posts', { live: true, transform: seenIn(built) })

      const before = registerCollections([['posts', collection('posts', { schema, transform: seenIn(previewed) })]])

      try {
        await bodyHtml('body', { collection: 'posts', slug: 'a' })
        await bodyHtml('body', { collection: 'posts', slug: 'fresh' })
        expect(built).toEqual([{ file: 'posts/a.md', slug: 'a' }])
        expect(previewed).toEqual([{ file: 'posts/a.md', slug: 'a' }, { file: 'posts/fresh.md', slug: 'fresh' }])
      }
      finally {
        registerCollections(before)
      }
    })
  })

  it('is the same file for a localized folder, and for a loader\'s entry', async () => {
    await inProject(async (root) => {
      await Bun.write(join(root, 'pages/fr/bonjour.md'), '---\ntitle: B\n---\n\nbody\n')

      const built: unknown[] = []
      const previewed: unknown[] = []
      const loaded: unknown[] = []

      await loadEntries('pages', { live: true, localized: true, transform: seenIn(built) })

      const rows = collection({ name: 'rows', load: () => [{ slug: 'fr/x', data: { title: 'X' }, body: 'y' }] }, { schema, localized: true, transform: seenIn(loaded) })
      const before = registerCollections([['pages', collection('pages', { schema, localized: true, transform: seenIn(previewed) })], ['rows', rows]])

      try {
        await bodyHtml('body', { collection: 'pages', slug: 'bonjour', locale: 'fr' })
        await rows.all()
        await bodyHtml('body', { collection: 'rows', slug: 'x', locale: 'fr' })
        expect(built).toEqual([{ file: 'pages/fr/bonjour.md', slug: 'bonjour', locale: 'fr' }])
        expect(previewed).toEqual(built)
        expect(loaded).toEqual([{ file: 'rows/fr/x', slug: 'x', locale: 'fr' }, { file: 'rows/fr/x', slug: 'x', locale: 'fr' }])
      }
      finally {
        registerCollections(before)
      }
    })
  })

  it('falls back on the config\'s transform when the collection sets none, and the collection\'s wins', async () => {
    const mark = (name: string) => (html: string) => `${html}<p>${name}</p>`

    setMarkdownDefaults({ transform: mark('config') })

    try {
      await inProject(async () => {
        const plain = collection({ name: 'dflt-plain', load: () => [{ slug: 'a', data: { title: 'A' }, body: 'x' }] }, { schema })
        const own = collection({ name: 'dflt-own', load: () => [{ slug: 'a', data: { title: 'A' }, body: 'x' }] }, { schema, transform: mark('own') })

        const text = async (found: typeof plain) => ((await found.get('a'))!.Content({}) as unknown as { t: string }).t

        expect(await text(plain)).toContain('<p>config</p>')
        expect(await text(own)).toContain('<p>own</p>')
        expect(await text(own)).not.toContain('config')
      })
    }
    finally {
      setMarkdownDefaults(undefined)
    }
  })

  it('keeps what a folder entry\'s author wrote, raw tags included, around what the transform adds', async () => {
    await inProject(async (root) => {
      await Bun.write(join(root, 'posts/a.md'), `---\ntitle: A\n---\n\n${HOSTILE}`)

      const [entry] = await loadEntries('posts', { live: true, transform: html => `${html}<!-- seen -->` })
      const html = entry!.segments!.join('')

      expect(html).toContain('<script>alert(2)</script>')
      expect(html).toContain('<!-- seen -->')
      expect(html.match(/<script>/g)).toHaveLength(1)
    })
  })
})

describe('the cache of a transform', () => {
  const lines = async (transform: (html: string) => string) => {
    const cache = await loadedBodies('things', { transform }, { sanitize: false, preview: false })

    for (const [slug, body] of Object.entries({ a: 'x', b: 'y' }))
      await cache.compile(slug, body)

    await cache.save()
  }

  it('keeps a loader\'s bodies while the transform is as it was and compiles them again when its source changes', async () => {
    await inProject(async () => {
      const counted = { compiles: 0 }

      await lines((html) => {
        counted.compiles++

        return html
      })
      expect(counted.compiles).toBe(2)
      await lines((html) => {
        counted.compiles++

        return html
      })
      expect(counted.compiles).toBe(2)
      await lines((html) => {
        counted.compiles++

        return `${html}!`
      })
      expect(counted.compiles).toBe(4)
    })
  })

  it('compiles again when the lockfile or a JSON file the config imports changes', async () => {
    await inProject(async (root) => {
      const config = join(root, 'content.config.ts')
      const counted = { compiles: 0 }
      const run = async () => {
        const cache = await loadedBodies('things', { transform: (html) => {
          counted.compiles++

          return html
        } }, { sanitize: false, preview: false })

        await cache.compile('a', 'x')
        await cache.save()
      }

      await Bun.write(join(root, 'labels.json'), '{"note":"Note"}')
      await Bun.write(config, 'import labels from \'./labels.json\'\nexport default labels\n')
      await Bun.write(join(root, 'bun.lock'), 'one')
      setContentPlace(root, root, config)
      await run()
      await run()
      expect(counted.compiles).toBe(1)
      await Bun.write(join(root, 'bun.lock'), 'two')
      await run()
      expect(counted.compiles).toBe(2)
      await Bun.write(join(root, 'labels.json'), '{"note":"Remark"}')
      await run()
      expect(counted.compiles).toBe(3)
    })
  })
})

describe('built-in containers and footnotes', () => {
  const render = async (markdown: string, options: { containers?: boolean, footnotes?: boolean } = { containers: true, footnotes: true }) => (await compileMarkdown(markdown, 1, options)).segments.join('')

  it('are off unless set, so content renders as it did', async () => {
    const source = '::: note Title\ntext\n:::\n\nA[^1]\n\n[^1]: Note\n'

    expect(await render(source, {})).toBe(await render(source, { containers: false, footnotes: false }))
    expect(await render(source, {})).toContain(':::')
    expect(await render(source, {})).not.toContain('<aside')
  })

  it('turn :::kind Title into an aside whose inside is Markdown across paragraphs, lists and code', async () => {
    const html = await render('::: Warning Heads up <b>\n**bold** text\n\n- one\n- two\n\n```ts\nlet a\n```\n:::\n\nAfter\n')

    expect(html).toContain('<aside class="admonition warning">')
    expect(html).toContain('<p class="admonition-title">Heads up &lt;b></p>')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<li>one</li>')
    expect(html).toContain('<pre><code class="language-ts">let a')
    expect(html).toMatch(/<\/aside>\s*<p>After<\/p>/)
  })

  it('nest, leave a fence inside alone, and leave openers nothing closes and closers with no opener as text', async () => {
    const nested = await render(':::outer\n:::inner\nx\n:::\ny\n:::\n')

    expect(nested.match(/<aside/g)).toHaveLength(2)
    expect(nested.indexOf('admonition outer')).toBeLessThan(nested.indexOf('admonition inner'))

    const fenced = await render('```md\n:::note\nx\n:::\n```\n')

    expect(fenced).not.toContain('<aside')
    expect(fenced).toContain(':::note')
    expect(await render(':::note\nnever closed\n')).toContain(':::note')
    expect(await render('text\n\n:::\n')).not.toContain('<aside')
    expect(await render(':::not a kind!\nx\n:::\n')).toContain('<aside class="admonition not">')
  })

  it('keep a sanitized loader\'s body safe: the aside is dropped for its text and nothing runs', async () => {
    const { segments } = await compileMarkdown(':::note <script>alert(1)</script>\n<img src=x onerror=alert(2)>\n:::\n', 1, { containers: true, sanitize: true })

    expect(segments.join('')).not.toMatch(/<script|onerror|<aside/)
  })

  it('read hostile input in linear time: unclosed openers, deep nesting and stray closers at scale', async () => {
    for (const source of [':::a\n'.repeat(60_000), `${':::a\n'.repeat(5_000)}${':::\n'.repeat(5_000)}`, ':::\n'.repeat(60_000), `:::a ${'x '.repeat(30_000)}\ny\n:::\n`, `[^a]: ${'x'.repeat(100_000)}\n${'[^a]'.repeat(20_000)}`, '`'.repeat(2).concat('[^a] `'.repeat(30_000)), '[^a]: d\n\n'.concat('`a``b```c````'.repeat(8_000), '[^a]')]) {
      const started = performance.now()

      contained(source)
      footnoted(source)
      expect(performance.now() - started).toBeLessThan(1500)
    }
  })

  it('number footnotes in order of reference with a list and links back, and keep ids apart from headings\'', async () => {
    const html = await render('# fn 1\n\n## fnref 1\n\nA[^b] and B[^a] and again[^b].\n\n[^a]: First *note*\n    continued\n[^b]: Second\n[^unused]: Dropped\n')

    expect(html).toContain('<sup id="fnref:1"><a href="#fn:1">1</a></sup>')
    expect(html).toContain('<sup id="fnref:2"><a href="#fn:2">2</a></sup>')
    expect(html).toContain('<sup><a href="#fn:1">1</a></sup>')
    expect(html).toContain('<section class="footnotes">')
    expect(html).toMatch(/<li><span id="fn:1"><\/span>Second <a href="#fnref:1"/)
    expect(html).toMatch(/<li><span id="fn:2"><\/span>First <em>note<\/em> continued <a href="#fnref:2"/)
    expect(html).not.toContain('Dropped')

    const ids = [...html.matchAll(/ id="([^"]*)"/g)].map(found => found[1])

    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('fn-1')
  })

  it('leave a reference with no definition, an escaped one, code spans and fences as written', async () => {
    const html = await render('A[^missing] and \\[^a] and `code[^a]` and B[^a]\n\n```\n[^a]\n```\n\n[^a]: Def\n')

    expect(html).toContain('[^missing]')
    expect(html).toContain('[^a] and <code>code[^a]</code>')
    expect(html).toContain('<pre><code>[^a]\n')
    expect(html.match(/<sup/g)).toHaveLength(1)
  })

  it('work in renderMarkdown and agree with a collection\'s compile', async () => {
    const source = ':::tip\nuse it[^1]\n:::\n\n[^1]: Footnote\n'
    const { html } = await renderMarkdown(source, { containers: true, footnotes: true })

    expect(html).toContain('<aside class="admonition tip">')
    expect(html).toContain('<section class="footnotes">')
    expect(html).toBe(await render(source))
  })
})
