import type { Collection } from '../src/content'
import { mkdtemp, readdir, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { Elysia, t } from 'elysia'
import { outputDir } from '../src/build/assets'
import { check } from '../src/check'
import { bodyHtml, collection, highlightCode, renderMarkdown } from '../src/content'
import { feedXml } from '../src/content/feed'
import { contentMode, contentPlace, loadEntries, manifestFile, setContentMode, setContentPlace } from '../src/content/load'
import { compileMarkdown, MarkdownError } from '../src/content/markdown'
import { serveFeeds, writeContentManifests } from '../src/content/server'
import { sanitizeHtml } from '../src/runtime'
import { pages, shutdown } from '../src/server'
import { ServedPaths } from '../src/server/served-paths'
import { scratchBuild } from './prerendered'
import { fixtureCopy } from './scratch'

const FIXTURE = 'tests/fixtures/content'
const routes = `${FIXTURE}/src/routes`
const content = `${FIXTURE}/src/content.config.ts`
const SITE = 'https://blog.example'
const app = new Elysia().use(await pages({ routes, content, prebuilt: false, security: false, site: SITE }))

async function get(path: string): Promise<{ status: number, html: string, type: string | null }> {
  const response = await app.handle(new Request(`http://localhost${path}`))

  return { status: response.status, html: await response.text(), type: response.headers.get('content-type') }
}

describe('Markdown entries', () => {
  it('render with anchored headings, a table of contents, highlighted code and kay components, islands included', async () => {
    const { status, html } = await get('/blog/hello')

    expect(status).toBe(200)
    expect(html).toContain('<nav class="toc"><a href="#hello-world">Hello world</a><a href="#getting-started">Getting started</a></nav>')
    expect(html).toContain('<h2 id="getting-started"><a href="#getting-started">Getting started</a></h2>')
    expect(html).toContain('<aside class="callout warn">\n<p>Mind the <strong>gap</strong>.</p>\n</aside>')
    expect(html).toContain('<pre class="highlighted" data-language="ts">const less = 1 &lt; 2\n</pre>')
    expect(html).toContain(`<slot data-component="tests/fixtures/content/src/components/counter.kay" data-props='[{"start":1},2]' data-chunk="${(/data-chunk="(counter-\w+\.js)"/).exec(html)![1]}"><button>Count <!--[-->2<!--]--></button></slot>`)
    expect(html).toMatch(/<link rel="modulepreload" href="\/_kay\/counter-[\w-]+\.js">/)
    expect((await get('/blog/missing')).status).toBe(404)
  })

  it('list sorted by the collection\'s order, data collections of JSON and YAML alike', async () => {
    const { html } = await get('/blog')

    expect(html).toContain('<ul class="posts"><li><a href="/blog/second">Second post</a></li><li><a href="/blog/hello">Hello world</a></li></ul>')
    expect(html).toContain('<p class="authors">Ada, Bob</p>')
  })

  it('read their frontmatter against the schema, defaults filled in and dates decoded', async () => {
    const { posts } = await import(`../${content}`) as { posts: Collection<{ title: string, date: Date, tags: string[], draft?: boolean }> }
    const second = await posts.get('second')

    expect(second?.data).toEqual({ title: 'Second post', date: new Date('2026-09-15'), tags: [] })
    expect(second?.file).toBe('tests/fixtures/content/src/content/posts/second.md')
    // A draft only shows in `kay dev`.
    expect((await posts.all()).map(post => post.slug)).toEqual(['second', 'hello'])
    expect(await posts.get('draft')).toBeUndefined()
  })

  it('show drafts as the app\'s dev option says, over NODE_ENV', async () => {
    const previous = process.env.NODE_ENV
    const draftStatus = async (env: string, dev: boolean) => {
      process.env.NODE_ENV = env
      const served = await pages({ routes, content, prebuilt: false, dev, security: false, site: SITE })

      return (await served.handle(new Request('http://localhost/blog/draft'))).status
    }

    try {
      expect(await draftStatus('production', true)).toBe(200)
      expect(await draftStatus('development', false)).toBe(404)
    }
    finally {
      if (previous === undefined)
        delete process.env.NODE_ENV
      else
        process.env.NODE_ENV = previous

      setContentMode({ dev: false, prebuilt: false })
    }
  })
})

describe('the content mode', () => {
  it('asks the loaders for their preview in development, reads the build\'s entries when prebuilt, and goes back to NODE_ENV as its server stops', async () => {
    const root = process.cwd()
    const asked: boolean[] = []
    const probe = (name: string) => collection({ name, load: ({ preview }) => {
      asked.push(preview)

      return []
    } }, { schema: t.Object({}) })
    const built = manifestFile(outputDir(root), 'content/authors')
    const authors = async () => (await collection('content/authors', { schema: t.Object({ name: t.String() }) }).all()).map(author => author.data.name)

    try {
      setContentMode({ dev: true, prebuilt: false })
      await probe('mode-dev').all()
      setContentMode({ dev: false, prebuilt: false })
      await probe('mode-production').all()
      expect(asked).toEqual([true, false])

      await Bun.write(built, JSON.stringify([{ slug: 'built', file: 'built.json', data: { name: 'Built' }, lines: {} }]))
      expect(await authors()).not.toContain('Built')
      setContentMode({ dev: false, prebuilt: true })
      expect(await authors()).toEqual(['Built'])

      const served = await pages({ routes, content, prebuilt: false, dev: true, security: false, log: false, site: SITE })

      expect(contentMode().dev).toBe(true)
      served.listen(0)
      await shutdown(served)
      expect(contentMode()).toMatchObject({ dev: process.env.NODE_ENV === 'development' })
    }
    finally {
      await rm(built, { force: true })
      setContentMode({ dev: false, prebuilt: false })
    }
  })
})

describe('the compile cache of entries', () => {
  it('keeps one file per entry however often it changes, drops the files of earlier versions, and compiles again only what changed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-content-cache-'))
    const cache = join(root, '.kay/cache/content')
    const before = contentPlace()

    try {
      await Bun.write(join(root, 'posts/a.md'), '---\ntitle: A\n---\n\nbody\n')
      await Bun.write(join(root, 'posts/b.md'), '---\ntitle: B\n---\n\nbody\n')
      await Bun.write(join(cache, 'abc123.json'), '{}')
      setContentPlace(root, root)

      const titles = async () => (await loadEntries('posts', { live: true })).map(entry => (entry.data as { title: string }).title)

      expect(await titles()).toEqual(['A', 'B'])

      for (const title of ['A2', 'A3', 'A4']) {
        await Bun.write(join(root, 'posts/a.md'), `---\ntitle: ${title}\n---\n\nbody\n`)
        expect(await titles()).toEqual([title, 'B'])
      }

      const files = await readdir(cache)

      expect(files).toHaveLength(2)
      expect(files.every(name => name.endsWith('.entry.json'))).toBe(true)
    }
    finally {
      setContentPlace(before.root, before.base)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reads an entry edited within 2 seconds of caching again even at the same size and time, and trusts a stamp that had settled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-content-stamp-'))
    const before = contentPlace()
    const entry = (title: string) => `---\ntitle: ${title}\n---\n\nbody\n`

    try {
      const recent = new Date(Date.now() - 100)
      const old = new Date(Date.now() - 3_600_000)

      await Bun.write(join(root, 'posts/fresh.md'), entry('One'))
      await Bun.write(join(root, 'posts/settled.md'), entry('One'))
      await utimes(join(root, 'posts/fresh.md'), recent, recent)
      await utimes(join(root, 'posts/settled.md'), old, old)
      setContentPlace(root, root)

      const titles = async () => (await loadEntries('posts', { live: true })).map(found => (found.data as { title: string }).title)

      expect(await titles()).toEqual(['One', 'One'])

      await Bun.write(join(root, 'posts/fresh.md'), entry('Two'))
      await Bun.write(join(root, 'posts/settled.md'), entry('Two'))
      await utimes(join(root, 'posts/fresh.md'), recent, recent)
      await utimes(join(root, 'posts/settled.md'), old, old)

      expect(await titles()).toEqual(['Two', 'One'])
    }
    finally {
      setContentPlace(before.root, before.base)
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('feeds', () => {
  it('serve a collection as RSS, newest first, drafts left out, links absolute', async () => {
    const { status, html, type } = await get('/blog/rss.xml')

    expect(status).toBe(200)
    expect(type).toBe('application/rss+xml; charset=utf-8')
    expect(html).toContain('<atom:link href="https://blog.example/blog/rss.xml" rel="self" type="application/rss+xml"/>')
    expect(html.indexOf('<title>Second post</title>')).toBeLessThan(html.indexOf('<title>Hello world</title>'))
    expect(html).toContain('<link>https://blog.example/blog/hello</link>')
    expect(html).not.toContain('Not yet')
  })

  it('build a collection\'s XML once until its entries are read afresh', async () => {
    let titles = ['First']
    let items = 0
    const posts = collection({ name: 'feed-once', load: () => titles.map(title => ({ slug: title.toLowerCase(), data: { title } })) }, { schema: t.Object({ title: t.String() }), feed: { path: '/once.xml', title: 'Once', item: (entry) => {
      items++

      return { title: entry.data.title, path: `/${entry.slug}`, date: new Date('2026-01-01') }
    } } })
    const feeds = new Elysia()

    serveFeeds(feeds, new ServedPaths(), [posts], 'https://x.example')

    const xml = async () => (await feeds.handle(new Request('http://localhost/once.xml'))).text()
    const first = await xml()

    expect(await xml()).toBe(first)
    expect(items).toBe(1)
    titles = ['First', 'Second']
    posts.invalidate()
    expect(await xml()).toContain('<title>Second</title>')
    expect(items).toBe(3)
  })

  it('write Atom, escaping what they carry', () => {
    const xml = feedXml([{ slug: 'a', data: {}, headings: [], words: 0, readingTime: 0, Content: () => ({ t: '' }), file: 'a.md' }], { path: '/feed.xml', title: 'Fish & chips', format: 'atom', item: () => ({ title: 'A <b>bold</b> move', path: '/a', date: new Date('2026-01-02') }) }, 'https://x.example')

    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">')
    expect(xml).toContain('<title>Fish &amp; chips</title>')
    expect(xml).toContain('<entry><title>A &lt;b>bold&lt;/b> move</title><link href="https://x.example/a"/><id>https://x.example/a</id><updated>2026-01-02T00:00:00.000Z</updated></entry>')
  })

  describe('write links as trailingSlash writes the canonical URL', () => {
    const entry = { slug: 'a', data: {}, headings: [], words: 0, readingTime: 0, Content: () => ({ t: '' }), file: 'a.md' }
    const feed = (format: 'rss' | 'atom') => ({ path: '/feed.xml', title: 'T', format, item: () => ({ title: 'A', path: '/blog/a', date: new Date('2026-01-02') }) })

    it.each(['rss', 'atom'] as const)('under always, in %s and under a base, a localized home too', (format) => {
      const xml = feedXml([entry], feed(format), 'https://x.example/app', '/fr', 'always')

      expect(xml).toContain('https://x.example/app/blog/a/')
      expect(xml).not.toContain('https://x.example/app/blog/a<')
      expect(xml).not.toContain('https://x.example/app/blog/a"')
      expect(xml).toContain('https://x.example/app/fr/')
      expect(xml).toContain('https://x.example/app/feed.xml')
    })

    it.each(['never', 'ignore', undefined] as const)('as written under %s', (trailingSlash) => {
      const xml = feedXml([entry], feed('rss'), 'https://x.example', '/', trailingSlash)

      expect(xml).toContain('<guid>https://x.example/blog/a</guid>')
    })

    it('when served', async () => {
      const posts = collection({ name: 'feed-slash', load: () => [{ slug: 'a', data: {} }] }, { schema: t.Object({}), feed: { path: '/slash.xml', title: 'S', item: entry => ({ title: 'A', path: `/${entry.slug}`, date: new Date('2026-01-01') }) } })
      const feeds = new Elysia()

      serveFeeds(feeds, new ServedPaths(), [posts], 'https://x.example', false, undefined, 'always')

      const xml = await (await feeds.handle(new Request('http://localhost/slash.xml'))).text()

      expect(xml).toContain('<guid>https://x.example/a/</guid>')
    })
  })

  it('need the site\'s URL, and a content config kay.config.ts names must exist', async () => {
    await expect(pages({ routes, content: 'tests/fixtures/content/src/missing.config.ts', prebuilt: false })).rejects.toThrow('names tests/fixtures/content/src/missing.config.ts as the content config, and there is no such file')
    await expect(pages({ routes, content, prebuilt: false })).rejects.toThrow('has a feed, whose links need the site\'s URL')
  })
})

describe('prerendering a collection', () => {
  it('renders a page for every entry of the collection it exports as prerender, from what kay build compiled', async () => {
    const build = await scratchBuild()

    try {
      expect(await writeContentManifests(process.cwd(), build.dir, content)).toBe(5)
      expect(await build.prerender({ routes, content })).toBe(2)
      expect(await Bun.file(join(build.pages, 'blog/hello.html')).text()).toContain('<h1 class="title">Hello world</h1>')
      expect(await Bun.file(join(build.pages, 'blog/draft.html')).exists()).toBe(false)
    }
    finally {
      await build.remove()
    }
  })
})

describe('kay check', () => {
  it('types loads from the schema and reports an entry the schema or the components refuse, at its line', async () => {
    const copy = await fixtureCopy('content')
    const posts = join(copy, 'src/content/posts')
    const page = join(copy, 'src/routes/typo.kay')

    try {
      await Bun.write(join(posts, 'broken.md'), '---\ntitle: Broken\ndate: someday\n---\n\n<Missing />\n\n<Counter start="2" />\n\n<Callout kind="warn">\nText\n</Callout>\n')
      await Bun.write(page, '--- server\nimport { posts } from \'../content.config\'\n\nconst first = (await posts.all())[0]!\n---\np {first.data.titel}\n')

      const diagnostics = (await check(copy, { site: SITE, lints: { seo: 'allow' } })).map(({ file, line, message }) => ({ file: file.slice(file.indexOf(copy)), line, message }))

      // The two files alone: the fixture's own pass.
      expect(new Set(diagnostics.map(diagnostic => diagnostic.file))).toEqual(new Set([`${copy}/src/content/posts/broken.md`, `${copy}/src/routes/typo.kay`]))
      expect(diagnostics).toContainEqual({ file: `${copy}/src/content/posts/broken.md`, line: 3, message: expect.stringContaining('date: ') })
      expect(diagnostics).toContainEqual({ file: `${copy}/src/content/posts/broken.md`, line: 6, message: 'uses <Missing>, which the collection\'s components do not name' })
      expect(diagnostics.some(diagnostic => diagnostic.file === `${copy}/src/routes/typo.kay` && diagnostic.message.includes('titel'))).toBe(true)
      // A component's props are typed as a template's would be: a string where it takes a number, a prop it does not take.
      expect(diagnostics).toContainEqual({ file: `${copy}/src/content/posts/broken.md`, line: 8, message: expect.stringMatching(/^<Counter> takes other props: Type 'string' is not assignable to type 'number'/) })
      expect(diagnostics).toContainEqual({ file: `${copy}/src/content/posts/broken.md`, line: 10, message: expect.stringMatching(/^<Callout> takes other props: Object literal may only specify known properties, and 'kind' does not exist/) })
    }
    finally {
      await rm(copy, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('compiling Markdown', () => {
  it('reads component attributes as text, JSON or a bare true', async () => {
    const { segments } = await compileMarkdown('<Chart title="Sales &amp; costs" data={[1, {"a": "}"}]} wide />\n', 1)

    expect(segments).toEqual([{ component: 'Chart', props: { title: 'Sales & costs', data: [1, { a: '}' }], wide: true }, children: [], line: 1 }, '\n'])
  })

  it.each([
    ['innerHTML', '<Callout innerHTML="<script>alert(1)</script>" />\n', { line: 1, message: '<Callout> sets innerHTML, which would put its text on the page as markup: write what it wraps between its tags' }],
    ['markup in a JSON object', '<Callout title={{"t":"<script>alert(1)</script>"}} />\n', undefined],
    ['markup in a JSON list', '<Callout items={[{"t":"<b>x</b>"}]} />\n', undefined],
  ])('refuses an attribute that would put its text on the page as markup: %s', async (_name, source, shape) => {
    const compiled = expect(compileMarkdown(source, 1)).rejects

    await (shape ? compiled.toMatchObject(shape) : compiled.toBeInstanceOf(MarkdownError))
  })

  it('keeps a JSON attribute holding no markup', async () => {
    expect((await compileMarkdown('<Callout items={[{"t":1}]} />\n', 1)).segments).toContainEqual({ component: 'Callout', props: { items: [{ t: 1 }] }, children: [], line: 1 })
  })

  it.each([
    ['JSON three braces deep', '<Chart rows={[{"v":{"w":1}}]} />\n', { rows: [{ v: { w: 1 } }] }],
    ['JSON strings holding braces and escaped quotes', '<Chart rows={[{"v":"a \\"}\\" {"}]} />\n', { rows: [{ v: 'a "}" {' }] }],
    ['quoted text holding > and }', '<Chart title="a > b }" note=\'c > "d"\' />\n', { title: 'a > b }', note: 'c > "d"' }],
    ['a tag inside a paragraph', 'See <Chart rows={[{"v":{"w":1}}]} /> here\n', { rows: [{ v: { w: 1 } }] }],
  ])('reads a component tag of any depth: %s', async (_name, source, props) => {
    const { segments } = await compileMarkdown(source, 1)

    expect(segments).toContainEqual({ component: 'Chart', props, children: [], line: 1 })
  })

  it('reads a wrapping tag whose JSON is deep', async () => {
    const { segments } = await compileMarkdown('<Chart rows={[{"v":{"w":{"x":"}"}}}]}>\n\nIn\n\n</Chart>\n', 1)

    expect(segments[0]).toEqual({ component: 'Chart', props: { rows: [{ v: { w: { x: '}' } } }] }, children: ['\n<p>In</p>\n'], line: 1 })
  })

  it.each([
    ['a stray brace after the prop', '<Chart rows={[1]}} />'],
    ['text after the prop', '<Chart rows={[{"v":1}]},{"v":2}]} />'],
    ['a brace never closed', '<Chart rows={[1] />'],
    ['a quote never closed', '<Chart title="a />'],
    ['a tag never ended', '<Chart rows={[1]}'],
    ['a wrapping tag', '<Chart rows={[1]}}>\n\nIn\n\n</Chart>'],
    ['a tag inside a paragraph', 'See <Chart rows={[1]}} /> here'],
  ])('refuses a component tag kay cannot read at its line, rather than passing it through: %s', async (_name, tag) => {
    await expect(compileMarkdown(`Intro\n\n${tag}\n`, 5)).rejects.toMatchObject({ code: 'markdown-invalid', line: 7 })
    await expect(bodyHtml(`Intro\n\n${tag}\n`)).rejects.toMatchObject({ code: 'markdown-invalid', line: 3 })
  })

  it.each([
    ['a tag spread over lines', 'Intro\n\n<Chart\n  title="a"\n  rows={[1]}} />\n', 3],
    ['a tag after another in its paragraph', '<Badge />\ntext\n<Chart rows={[1]}} />\n', 3],
    ['a closing tag holding text', '<Chart>\n\nIn\n\n</Chart x>\n', 5],
    ['a closing tag holding a /', '<Chart>\n\nIn\n\n</Chart/>\n', 5],
  ])('names the line of the tag it cannot read: %s', async (_name, source, line) => {
    await expect(compileMarkdown(source, 1)).rejects.toMatchObject({ code: 'markdown-invalid', line })
  })

  it.each([
    ['a capital after <', 'if 1<A then\n'],
    ['a capital after < and a comma', 'a<B, then x = 1\n'],
    ['a capital after < ending at code', 'x <Foo`bar`\n'],
  ])('leaves prose setting no attribute and with no > after it as text: %s', async (_name, source) => {
    const { segments } = await compileMarkdown(source, 1)

    expect(segments.every(segment => typeof segment === 'string')).toBe(true)
  })

  it.each([
    ['a code span, then the >', 'Intro\n\n<Chart foo `x` >\n'],
    ['a code span in the tag, then a >', '<Chart foo `x` bar> text\n'],
  ])('refuses a valueless tag whose > sits past a code span: %s', async (_name, source) => {
    await expect(compileMarkdown(source, 1)).rejects.toMatchObject({ code: 'markdown-invalid' })
  })

  it.each([
    ['a > only inside a code span', 'x <Foo `a > b`\n'],
    ['a blank line before the >', '<Chart foo\n\nmore >\n'],
    ['nothing after it', 'Intro\n\n<Chart stray'],
  ])('leaves a valueless tag with no later > in its block as text: %s', async (_name, source) => {
    const { segments } = await compileMarkdown(source, 1)

    expect(segments.every(segment => typeof segment === 'string')).toBe(true)
  })

  it.each([
    ['a quote', 'a\n> <Chart stray\n> b\n'],
    ['a nested quote', 'a\n> > <Chart stray\n> > b\n'],
    ['a nested quote with no space', 'a\n>> <Chart stray\n>> b\n'],
    ['an indented marker', 'a\n   > <Chart stray\n   > b\n'],
    ['a > in a code span of the quote', 'a\n> <Chart stray `x > y`\n> b\n'],
  ])('does not read a blockquote marker as the closing > of a valueless tag: %s', async (_name, source) => {
    const { segments } = await compileMarkdown(source, 1)

    expect(segments.every(segment => typeof segment === 'string')).toBe(true)
    expect(segments.join('')).toContain('&lt;Chart stray')
  })

  it('still reads a > after a tag in a quote as its close, and a tag in a quote', async () => {
    await expect(compileMarkdown('a\n> <Chart stray\n> b >\n', 1)).rejects.toMatchObject({ code: 'markdown-invalid' })
    expect((await compileMarkdown('> > <Chart a="1" />\n', 1)).segments).toContainEqual({ component: 'Chart', props: { a: '1' }, children: [], line: 1 })
    expect((await compileMarkdown('> <Chart a="1"\n> b="2" />\n', 1)).segments).toContainEqual({ component: 'Chart', props: { a: '1', b: '2' }, children: [], line: 1 })
    expect((await compileMarkdown('> <Chart a="x\n  y"\ncontinued />\n', 1)).segments).toContainEqual({ component: 'Chart', props: { a: 'x\n  y', continued: true }, children: [], line: 1 })
    expect((await compileMarkdown('> <Chart a="1">\n>\n> in\n>\n> </Chart>\n', 1)).segments).toContainEqual({ component: 'Chart', props: { a: '1' }, children: ['\n<p>in</p>\n'], line: 1 })
  })

  it('reads a > alone after the markers of a later line as the close of a quoted tag, and a lone marker run as markers', async () => {
    expect((await compileMarkdown('> <Chart a="1"\n> >\n> </Chart>\n', 1)).segments).toContainEqual(expect.objectContaining({ component: 'Chart', props: { a: '1' } }))
    expect((await compileMarkdown('> > <Chart a="1"\n> > >\n> > </Chart>\n', 1)).segments).toContainEqual(expect.objectContaining({ component: 'Chart', props: { a: '1' } }))
    expect((await compileMarkdown('> <Chart a="1"\n>\n> b="2" />\n', 1)).segments).toContainEqual({ component: 'Chart', props: { a: '1', b: '2' }, children: [], line: 1 })
  })

  it('comes out escaped for a prose-fallback tag, with no live element', async () => {
    expect(await bodyHtml('<A/onfocus=alert(1)')).toBe('<p>&lt;A/onfocus=alert(1)</p>\n')
    expect(await bodyHtml('<A/onfocus=alert(1)\n\n>')).toBe('<p>&lt;A/onfocus=alert(1)</p>\n<blockquote>\n</blockquote>\n')
  })

  it('reads hostile valueless tags in linear time', async () => {
    const units = ['<A `x` ', '<A <B ', '<A/', '<A `', '> <A\n', '<A\n>>>>>>>>\n']
    const times: number[] = []

    for (const count of [200_000, 400_000]) {
      const start = performance.now()

      for (const unit of units) {
        try {
          await compileMarkdown(unit.repeat(count), 1)
        }
        catch {}
      }

      times.push(performance.now() - start)
    }

    expect(times[1]!).toBeLessThan(times[0]! * 4 + 500)
  }, 60_000)

  it('leaves a tag kay cannot read alone in code', async () => {
    const { segments } = await compileMarkdown('`<Chart rows={[1]}} />` in code\n\n```md\n<Chart rows={[1]}} />\n```\n', 1)

    expect(segments).toEqual(['<p><code>&lt;Chart rows={[1]}} /&gt;</code> in code</p>\n<pre><code class="language-md">&lt;Chart rows={[1]}} /&gt;\n</code></pre>\n'])
  })

  it('leaves a tag written in code alone, and refuses one never closed at its line', async () => {
    const { segments } = await compileMarkdown('`<Callout>` in code\n', 1)

    expect(segments).toEqual(['<p><code>&lt;Callout&gt;</code> in code</p>\n'])

    const unclosed = compileMarkdown('Intro\n\n<Callout type="warn">\n\nBody\n', 5)

    await expect(unclosed).rejects.toBeInstanceOf(MarkdownError)
    await expect(unclosed).rejects.toMatchObject({ line: 7, message: '<Callout> is never closed: end it with </Callout>, or write <Callout />' })
  })

  it('leaves tags in fenced and indented code alone, and reads one spread over several lines', async () => {
    const { segments } = await compileMarkdown('Intro\n\n    <Callout type="x">\n\n```md\n<Callout>\n```\n\n<Callout\n  type="warn">\n\nIn\n\n</Callout>\n', 1)

    expect(segments[0]).toBe('<p>Intro</p>\n<pre><code>&lt;Callout type=&quot;x&quot;&gt;\n</code></pre>\n<pre><code class="language-md">&lt;Callout&gt;\n</code></pre>\n')
    expect(segments[1]).toEqual({ component: 'Callout', props: { type: 'warn' }, children: ['\n<p>In</p>\n'], line: 9 })
  })

  it('refuses two files with one slug, naming both', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-content-'))

    try {
      setContentPlace(dir, dir)
      await Bun.write(join(dir, 'guides/index.md'), 'Guides\n')
      await Bun.write(join(dir, 'guides.md'), 'Also guides\n')
      await expect(collection('.', { schema: t.Object({}) }).all()).rejects.toThrow(/has the slug guides, as .*guides.* does; rename one/)
    }
    finally {
      setContentPlace(process.cwd(), join(process.cwd(), FIXTURE, 'src'))
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('compiles each entry once, keyed by its content, so a change recompiles that entry only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-content-'))
    let highlighted = 0
    const make = () => collection('posts', {
      schema: t.Object({}),
      highlight: (code) => {
        highlighted++

        return `<pre>${code}</pre>`
      },
    })

    try {
      setContentPlace(dir, dir)
      await Bun.write(join(dir, 'posts/a.md'), '```\na\n```\n')
      await Bun.write(join(dir, 'posts/b.md'), '```\nb\n```\n')
      expect((await make().all()).length).toBe(2)
      expect(highlighted).toBe(2)

      await Bun.write(join(dir, 'posts/b.md'), '```\nb changed\n```\n')
      await make().all()
      expect(highlighted).toBe(3)
    }
    finally {
      setContentPlace(process.cwd(), join(process.cwd(), FIXTURE, 'src'))
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('Markdown entries\' length', () => {
  it('counts the words of the rendered text, components\' own output left out, and reads them at 230 a minute', async () => {
    const { posts } = await import(`../${content}`) as { posts: Collection<{ title: string }> }
    const hello = await posts.get('hello')

    // Headings and paragraphs count, the code's symbols and the Counter and Callout elements do not; the Callout's Markdown does.
    expect(hello).toMatchObject({ words: 17, readingTime: 1 })

    const lengths = collection({ name: 'lengths', load: () => [
      { slug: 'empty', data: {}, body: '' },
      { slug: 'short', data: {}, body: 'Three little words' },
      { slug: 'long', data: {}, body: `${'word '.repeat(460)}\n\n<b>a &amp; b</b>\n` },
    ] }, { schema: t.Object({}) })
    const [empty, long, short] = await lengths.all()

    expect([empty!.words, empty!.readingTime]).toEqual([0, 0])
    expect([short!.words, short!.readingTime]).toEqual([3, 1])
    expect([long!.words, long!.readingTime]).toEqual([462, 2])
  })
})

describe('Markdown outside collections', () => {
  it('renders a string as entries render, headings anchored and code highlighted when asked', async () => {
    const shout = (code: string, language: string | undefined) => `<pre class="shout">${language}:${code.toUpperCase()}</pre>`
    const note = await renderMarkdown('## Hello world\n\nSee https://example.com\n\n```ts\nconst a = 1\n```\n', { highlight: shout })

    expect(note.headings).toEqual([{ depth: 2, id: 'hello-world', text: 'Hello world' }])
    expect(note.html).toContain('<h2 id="hello-world"><a href="#hello-world">Hello world</a></h2>')
    expect(note.html).toContain('<a href="https://example.com">https://example.com</a>')
    expect(note.html).toContain('<pre class="shout">ts:CONST A = 1\n</pre>')
    expect((await renderMarkdown('```ts\na < b\n```\n')).html).toBe('<pre><code class="language-ts">a &lt; b\n</code></pre>\n')
  })

  it('gives the HTML a body puts on the page outside its components, with their markup as kay takes it', async () => {
    expect(await bodyHtml('Hi <b>there</b>\n\n<Callout title="a}">In <i>it</i></Callout>\n\nBye')).toBe('<p>Hi <b>there</b></p>\n<p><kay-component n="0">In <i>it</i></kay-component></p>\n<p>Bye</p>\n')
    await expect(bodyHtml('<Callout onclick=alert(1)//}>hi')).rejects.toBeInstanceOf(MarkdownError)
    await expect(bodyHtml('<Callout>open')).rejects.toBeInstanceOf(MarkdownError)
  })

  it('highlights a code string as a Markdown code block renders, plain without a highlighter', async () => {
    expect(String(await highlightCode('a < b', 'ts'))).toBe('<pre><code class="language-ts">a &lt; b</code></pre>')
    expect(String(await highlightCode('x', undefined))).toBe('<pre><code>x</code></pre>')
    expect(String(await highlightCode('x', 'ts', { highlight: async (code, language) => `<pre data-lang="${language}">${code}</pre>` }))).toBe('<pre data-lang="ts">x</pre>')
  })

  it('keeps the images and tables a user\'s Markdown holds once sanitizeHtml is told to, and nothing that runs', async () => {
    const { html } = await renderMarkdown('![Cat](/cat.png "A cat")\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<img src="javascript:x" onerror="alert(1)">\n')
    const options = { tags: ['img', 'table', 'thead', 'tbody', 'tr', 'th', 'td'], attributes: { img: ['src', 'alt', 'title'] } }
    const kept = String(sanitizeHtml(html, options))

    expect(kept).toContain('<img src="/cat.png" alt="Cat" title="A cat">')
    expect(html).toContain('<img loading="lazy" decoding="async" src="/cat.png" alt="Cat" title="A cat" />')
    expect((await renderMarkdown('<img src="/hero.png" alt="" fetchpriority="high">\n')).html).toBe('<img decoding="async" src="/hero.png" alt="" fetchpriority="high">\n')
    expect((await renderMarkdown('<img alt="a > b" src="/a.png" loading="eager">\n')).html).toBe('<img decoding="async" alt="a > b" src="/a.png" loading="eager">\n')
    expect(kept).toContain('<table>\n<thead>\n<tr><th>a</th><th>b</th></tr>\n</thead>\n<tbody>\n<tr><td>1</td><td>2</td></tr>\n</tbody>\n</table>')
    expect(kept).toContain('<img>')
    expect(kept).not.toContain('onerror')
    expect(() => sanitizeHtml('', { tags: ['script'] })).toThrow('never keeps <script>')
    expect(() => sanitizeHtml('', { attributes: { img: ['onerror'] } })).toThrow('never keeps onerror')
    expect(() => sanitizeHtml('', { tags: ['plaintext'] })).toThrow('never keeps <plaintext>')
    expect(() => sanitizeHtml('', { tags: ['img'], attributes: { imgg: ['src'] } })).toThrow('attributes of <imgg>, a tag it does not keep')
  })

  it('gives the defaults to img tags alone, by their attribute names, and never inside another tag', async () => {
    const html = async (markdown: string) => (await renderMarkdown(markdown)).html

    expect(await html('<img-x src="/a.png"></img-x>\n')).toBe('<p><img-x src="/a.png"></img-x></p>\n')
    expect(await html('<img alt="loading=eager decoding=sync" src="/a.png">\n')).toBe('<img loading="lazy" decoding="async" alt="loading=eager decoding=sync" src="/a.png">\n')
    expect(await html('<p><a title="<img src=x>" href="/">x</a></p>\n')).toBe('<p><a title="<img src=x>" href="/">x</a></p>\n')
    expect(await html('<IMG SRC="/a.png" Loading="eager">\n')).toBe('<img decoding="async" SRC="/a.png" Loading="eager">\n')
  })

  it('leaves an img inside a comment or a raw-text element alone, and ends the pass at an unclosed comment', async () => {
    const html = async (markdown: string) => (await renderMarkdown(markdown)).html
    const bare = '<img src="/a.png">'

    for (const tag of ['script', 'style', 'textarea', 'title']) {
      const out = await html(`<${tag}>${bare}</${tag}>\n\n${bare}\n`)

      expect(out).toContain(`<${tag}>${bare}</${tag}>`)
      expect(out).toContain('<img loading="lazy" decoding="async" src="/a.png">')
    }

    expect(await html(`<!-- ${bare} -->\n\n${bare}\n`)).toContain(`<!-- ${bare} -->`)
    expect(await html(`<!-- ${bare}\n`)).not.toContain('loading=')
  })

  it('reads a page of unclosed img tags in linear time', async () => {
    const start = performance.now()
    const { html } = await renderMarkdown(`<div>\n${'<img '.repeat(20_000)}`)

    expect(performance.now() - start).toBeLessThan(250)
    expect(html).not.toContain('loading=')
  })

  it('checks every URL an opted-in attribute holds, and writes back only the attributes it read', () => {
    const options = { tags: ['img', 'video', 'source', 'blockquote', 'span'], attributes: { img: ['src', 'srcset', 'alt'], video: ['poster'], source: ['src'], blockquote: ['cite'], a: ['href', 'rel', 'xlink:href', 'action'], span: ['data'] } }
    const kept = (markup: string) => String(sanitizeHtml(markup, options))

    expect(kept('<img src="javascript:x" srcset="/a.png 1x, javascript:y 2x" alt="a">')).toBe('<img alt="a">')
    expect(kept('<img srcset="/a.png 1x, https://cdn.example.com/b.png 2x">')).toBe('<img srcset="/a.png 1x, https://cdn.example.com/b.png 2x">')
    expect(kept('<video poster="javascript:x"><source src="/v.mp4"></video>')).toBe('<video><source src="/v.mp4"></video>')
    expect(kept('<blockquote cite="data:text/html,x">q</blockquote>')).toBe('<blockquote>q</blockquote>')
    expect(kept('<img src="/a.png" src="javascript:x" alt=\'say "hi"\'>')).toBe('<img src="/a.png" alt="say &quot;hi&quot;">')
    expect(kept('<img alt="a > b" src="javascript:x">')).toBe('<img> b" src="javascript:x">')
    expect(kept('<a xlink:href="javascript:x" action="javascript:x">x</a>')).toBe('<a>x</a>')
    expect(kept('<a xlink:href="/x" action="/x">x</a>')).toBe('<a xlink:href="/x" action="/x">x</a>')
    expect(kept('<span data="hello">x</span>')).toBe('<span data="hello">x</span>')
    expect(kept('<a href="/x" rel="opener">x</a>')).toBe('<a href="/x" rel="nofollow ugc">x</a>')
  })

  it('renders a user\'s text of unclosed tags in linear time', async () => {
    // The best of three runs, so a pause under load does not count; eight times the input takes about eight times as long, where a quadratic pass took sixty-four.
    const best = async (markup: string) => {
      const times: number[] = []

      for (let run = 0; run < 3; run++) {
        const start = performance.now()

        await renderMarkdown(markup, { highlight: code => code })
        times.push(performance.now() - start)
      }

      return Math.min(...times)
    }

    for (const unit of ['<pre><code>', '<h2 id="a"><a href="#b">x\n\n']) {
      const small = await best(unit.repeat(5000))
      const large = await best(unit.repeat(40_000))

      expect(large / small).toBeLessThan(24)
    }
  })

  it('recompiles the entries when a module the content config imports changes, though the highlighter reads the same', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-content-'))
    let mark = 'old'
    // The highlighter's source is the same in both runs, standing for one that calls a helper the config imports.
    const highlight = (code: string) => `<pre data-by="${mark}">${code}</pre>`
    const loaded = async () => (await loadEntries('posts', { highlight, live: true })).flatMap(entry => entry.segments ?? []).join()

    try {
      setContentPlace(dir, dir, join(dir, 'content.config.ts'))
      await Bun.write(join(dir, 'content.config.ts'), 'import \'./helper\'\n')
      await Bun.write(join(dir, 'helper.ts'), 'export const theme = \'old\'\n')
      await Bun.write(join(dir, 'posts/a.md'), '```\na\n```\n')
      expect(await loaded()).toContain('data-by="old"')

      mark = 'new'
      await Bun.write(join(dir, 'helper.ts'), 'export const theme = \'new\'\n')
      expect(await loaded()).toContain('data-by="new"')
    }
    finally {
      setContentPlace(process.cwd(), join(process.cwd(), FIXTURE, 'src'))
      await rm(dir, { recursive: true, force: true })
    }
  })
})
