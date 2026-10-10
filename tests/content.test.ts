import type { Collection } from '../src/content'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { Elysia, t } from 'elysia'
import { check } from '../src/check'
import { collection, highlightCode, renderMarkdown } from '../src/content'
import { feedXml } from '../src/content/feed'
import { setContentPlace } from '../src/content/load'
import { compileMarkdown, MarkdownError } from '../src/content/markdown'
import { writeContentManifests } from '../src/content/server'
import { sanitizeHtml } from '../src/runtime'
import { pages } from '../src/server'
import { readClient, readManifest, writeManifest } from '../src/server/client'
import { prerenderPages } from '../src/server/prerender'

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
    expect(html).toContain('<slot data-component="tests/fixtures/content/src/components/counter.kay" data-props="[{&quot;start&quot;:1},2]"><button>Count <!--[-->2<!--]--></button></slot>')
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

  it('write Atom, escaping what they carry', () => {
    const xml = feedXml([{ slug: 'a', data: {}, headings: [], Content: () => ({ t: '' }), file: 'a.md' }], { path: '/feed.xml', title: 'Fish & chips', format: 'atom', item: () => ({ title: 'A <b>bold</b> move', path: '/a', date: new Date('2026-01-02') }) }, 'https://x.example')

    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">')
    expect(xml).toContain('<title>Fish &amp; chips</title>')
    expect(xml).toContain('<entry><title>A &lt;b>bold&lt;/b> move</title><link href="https://x.example/a"/><id>https://x.example/a</id><updated>2026-01-02T00:00:00.000Z</updated></entry>')
  })

  it('need the site\'s URL, and a content config kay.config.ts names must exist', async () => {
    await expect(pages({ routes, content: 'tests/fixtures/content/src/missing.config.ts', prebuilt: false })).rejects.toThrow('names tests/fixtures/content/src/missing.config.ts as the content config, and there is no such file')
    await expect(pages({ routes, content, prebuilt: false })).rejects.toThrow('has a feed, whose links need the site\'s URL')
  })
})

describe('prerendering a collection', () => {
  it('renders a page for every entry of the collection it exports as prerender, from what kay build compiled', async () => {
    const root = process.cwd()
    const manifest = (await readManifest(root))!

    try {
      expect(await writeContentManifests(root, join(root, '.kay/client'), content)).toBe(5)
      expect(await prerenderPages(root, { routes, content }, (await readClient(root))!)).toBe(2)
      expect(await Bun.file(join(root, '.kay/client/pages/blog/hello.html')).text()).toContain('<h1 class="title">Hello world</h1>')
      expect(await Bun.file(join(root, '.kay/client/pages/blog/draft.html')).exists()).toBe(false)
    }
    finally {
      await rm(join(root, '.kay/client/pages'), { recursive: true, force: true })
      await rm(join(root, '.kay/client/content'), { recursive: true, force: true })
      await writeManifest(root, manifest)
    }
  })
})

describe('kay check', () => {
  it('types loads from the schema and reports an entry the schema or the components refuse, at its line', async () => {
    const posts = join(FIXTURE, 'src/content/posts')
    const page = join(FIXTURE, 'src/routes/typo.kay')

    expect(await check(FIXTURE, { site: SITE, lints: { seo: 'allow' } })).toEqual([])

    try {
      await Bun.write(join(posts, 'broken.md'), '---\ntitle: Broken\ndate: someday\n---\n\n<Missing />\n\n<Counter start="2" />\n\n<Callout kind="warn">\nText\n</Callout>\n')
      await Bun.write(page, '--- server\nimport { posts } from \'../content.config\'\n\nconst first = (await posts.all())[0]!\n---\np {first.data.titel}\n')

      const diagnostics = (await check(FIXTURE, { site: SITE })).map(({ file, line, message }) => ({ file: file.slice(file.indexOf(FIXTURE)), line, message }))

      expect(diagnostics).toContainEqual({ file: `${FIXTURE}/src/content/posts/broken.md`, line: 3, message: expect.stringContaining('date: ') })
      expect(diagnostics).toContainEqual({ file: `${FIXTURE}/src/content/posts/broken.md`, line: 6, message: 'uses <Missing>, which the collection\'s components do not name' })
      expect(diagnostics.some(diagnostic => diagnostic.file === `${FIXTURE}/src/routes/typo.kay` && diagnostic.message.includes('titel'))).toBe(true)
      // A component's props are typed as a template's would be: a string where it takes a number, a prop it does not take.
      expect(diagnostics).toContainEqual({ file: `${FIXTURE}/src/content/posts/broken.md`, line: 8, message: expect.stringMatching(/^<Counter> takes other props: Type 'string' is not assignable to type 'number'/) })
      expect(diagnostics).toContainEqual({ file: `${FIXTURE}/src/content/posts/broken.md`, line: 10, message: expect.stringMatching(/^<Callout> takes other props: Object literal may only specify known properties, and 'kind' does not exist/) })
    }
    finally {
      await rm(join(posts, 'broken.md'), { force: true })
      await rm(page, { force: true })
    }
  }, 30_000)
})

describe('compiling Markdown', () => {
  it('reads component attributes as text, JSON or a bare true', async () => {
    const { segments } = await compileMarkdown('<Chart title="Sales &amp; costs" data={[1, {"a": "}"}]} wide />\n', 1)

    expect(segments).toEqual([{ component: 'Chart', props: { title: 'Sales & costs', data: [1, { a: '}' }], wide: true }, children: [], line: 1 }, '\n'])
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
    expect(kept).toContain('<table>\n<thead>\n<tr><th>a</th><th>b</th></tr>\n</thead>\n<tbody>\n<tr><td>1</td><td>2</td></tr>\n</tbody>\n</table>')
    expect(kept).toContain('<img>')
    expect(kept).not.toContain('onerror')
    expect(() => sanitizeHtml('', { tags: ['script'] })).toThrow('never keeps <script>')
    expect(() => sanitizeHtml('', { attributes: { img: ['onerror'] } })).toThrow('never keeps onerror')
    expect(() => sanitizeHtml('', { tags: ['plaintext'] })).toThrow('never keeps <plaintext>')
    expect(() => sanitizeHtml('', { tags: ['img'], attributes: { imgg: ['src'] } })).toThrow('attributes of <imgg>, a tag it does not keep')
  })

  it('checks every URL an opted-in attribute holds, and writes back only the attributes it read', () => {
    const options = { tags: ['img', 'video', 'source', 'blockquote'], attributes: { img: ['src', 'srcset', 'alt'], video: ['poster'], source: ['src'], blockquote: ['cite'], a: ['href', 'rel'] } }
    const kept = (markup: string) => String(sanitizeHtml(markup, options))

    expect(kept('<img src="javascript:x" srcset="/a.png 1x, javascript:y 2x" alt="a">')).toBe('<img alt="a">')
    expect(kept('<img srcset="/a.png 1x, https://cdn.example.com/b.png 2x">')).toBe('<img srcset="/a.png 1x, https://cdn.example.com/b.png 2x">')
    expect(kept('<video poster="javascript:x"><source src="/v.mp4"></video>')).toBe('<video><source src="/v.mp4"></video>')
    expect(kept('<blockquote cite="data:text/html,x">q</blockquote>')).toBe('<blockquote>q</blockquote>')
    expect(kept('<img src="/a.png" src="javascript:x" alt=\'say "hi"\'>')).toBe('<img src="/a.png" alt="say &quot;hi&quot;">')
    expect(kept('<img alt="a > b" src="javascript:x">')).toBe('<img> b" src="javascript:x">')
    expect(kept('<a href="/x" rel="opener">x</a>')).toBe('<a href="/x" rel="nofollow ugc">x</a>')
  })

  it('renders a user\'s text of unclosed tags in linear time', async () => {
    const time = async (markup: string) => {
      const start = performance.now()

      await renderMarkdown(markup, { highlight: code => code })

      return performance.now() - start
    }

    expect(await time('<pre><code>'.repeat(40_000))).toBeLessThan(500)
    expect(await time('<h2 id="a"><a href="#b">x\n\n'.repeat(40_000))).toBeLessThan(500)
  })
})
