import type { Collection } from '../src/content'
import type { ServedRoute } from '../src/server/guards'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, setSystemTime, spyOn } from 'bun:test'
import { t } from 'elysia'
import { TypeCompiler } from 'elysia/type-system'
import { readClientSources } from '../src/build/client'
import { collection, collectionInfo, collections, customField, entries, entryFile, entrySource, fileField, imageField, removeEntry, saveEntry } from '../src/content'
import { entryIssues, registerCollections, registerEditSite } from '../src/content/edit'
import { contentPlace, parseEntry, setContentPlace } from '../src/content/load'
import { MarkdownError } from '../src/content/markdown'
import * as validate from '../src/content/validate'
import { ContentError } from '../src/content/validate'
import { cached } from '../src/runtime/cache'
import { showDraft } from '../src/runtime/edit'
import { editableEntry, editMarks, placeFieldMarks, withFieldMarks } from '../src/runtime/fields'
import { child, loop } from '../src/runtime/html'
import { navigation } from '../src/runtime/navigation'
import { editing, previewing } from '../src/runtime/preview'
import { html as renderedHtml } from '../src/runtime/rendered'
import { editedEntry, editRequested, enterPreview, pages, previewUrl } from '../src/server'
import { entryUrls } from '../src/server/entry-urls'
import { inPreview, previewRequested, requestDrafts } from '../src/server/preview'
import { extensionEditor } from '../src/server/routes'
import { cms, resetCms } from './fixtures/cms/src/cms'
import { articles, news, pages as pagesCollection } from './fixtures/cms/src/content.config'
import { scratchBuild } from './prerendered'
import { scratchDir } from './scratch'

const FIXTURE = 'tests/fixtures/cms'
const SECRET = 'a-preview-secret-long-enough-for-kay-0123456789'
// A CMS's extension: its editor, and its admin screens under `/admin`.
const EDITOR = { name: 'editor', editor: `${FIXTURE}/src/components/draft-editor.kay`, routes: { dir: `${FIXTURE}/admin`, prefix: '/admin' } }
// Another extension, whose pages are content the editor edits.
const BLOG = { name: 'blog', routes: { dir: `${FIXTURE}/blog`, prefix: '/blog' } }
const options = { routes: `${FIXTURE}/src/routes`, content: `${FIXTURE}/src/content.config.ts`, api: `${FIXTURE}/src/api`, site: 'https://news.example', inlineStyles: false, security: false as const, preview: { secret: SECRET }, extensions: [EDITOR, BLOG] }
const app = await pages({ ...options, prebuilt: false })
const COOKIE = /^kay_preview=([^;]+);/
const HYDRATION_MARK = /<!--[[\]]-->/g

async function get(path: string, cookie?: string): Promise<{ status: number, html: string, headers: Headers }> {
  const response = await app.handle(new Request(`http://localhost${path}`, { headers: cookie === undefined ? {} : { cookie } }))

  return { status: response.status, html: await response.text(), headers: response.headers }
}

// The cookie a preview link sets, as the browser sends it back.
async function previewCookie(link: string): Promise<string> {
  const response = await app.handle(new Request(`http://localhost${link}`))

  expect(response.status).toBe(307)

  return `kay_preview=${COOKIE.exec(response.headers.get('set-cookie') ?? '')![1]}`
}

// Runs with the collections' folders read from `base`, a copy of the fixture's `src` holding `folders` there, as a project whose folders are elsewhere; removes it after.
async function readingFrom<T>(base: string, folders: string[], run: () => Promise<T>): Promise<T> {
  const before = contentPlace()

  try {
    for (const folder of folders)
      await cp(`${FIXTURE}/src/${folder}`, join(base, folder), { recursive: true })

    setContentPlace(before.root, base)

    return await run()
  }
  finally {
    setContentPlace(before.root, before.base)
    await rm(base, { recursive: true, force: true })
  }
}

// Runs with `named` as the collections the content config exports.
async function exporting<T>(named: [string, Collection<unknown>][], run: () => Promise<T>): Promise<T> {
  const before = registerCollections(named)

  try {
    return await run()
  }
  finally {
    registerCollections(before)
  }
}

// What a promise rejected with, or undefined once it resolved.
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  }
  catch (error) {
    return error
  }

  return undefined
}

afterEach(() => {
  resetCms()
  news.invalidate()
  setSystemTime()
})

describe('loaded collections', () => {
  const schema = t.Object({ title: t.String() })

  it('read what a loader gives against the schema, a Markdown body compiled and HTML kept as it is', async () => {
    const notes = collection({ name: 'notes-compiled', load: () => [
      { slug: 'b', data: { title: 'Second' }, body: '# Intro\n\nSome **bold** text.' },
      { slug: 'a', data: { title: 'First' }, html: '<p>From the CMS</p>' },
    ] }, { schema })
    const [first, second] = await notes.all()

    expect(notes.dir).toBeUndefined()
    expect(notes.name).toBe('notes-compiled')
    expect(first).toMatchObject({ slug: 'a', data: { title: 'First' }, headings: [], words: 3, readingTime: 1, file: 'notes-compiled/a' })
    expect(String((first!.Content as unknown as () => { t: string })().t)).toBe('<p>From the CMS</p>')
    expect(second!.headings).toEqual([{ depth: 1, id: 'intro', text: 'Intro' }])
    expect((second!.Content as unknown as () => { t: string })().t).toContain('<strong>bold</strong>')
    expect((await notes.get('b'))?.data.title).toBe('Second')
  })

  it('refuses entries the schema refuses, a missing or repeated slug, and anything but an array, loading again on the next read', async () => {
    let given: unknown = [{ slug: 'a', data: { title: 1 } }, { slug: 'a', data: { title: 'Again' } }, { data: {} }]
    const notes = collection({ name: 'notes-refused', load: () => given as [] }, { schema })

    const refused = await rejection(notes.all())

    expect(refused).toBeInstanceOf(ContentError)
    expect((refused as ContentError).problems.map(problem => `${problem.file} ${problem.message}`)).toEqual([
      'notes-refused/a has the slug a, as an earlier entry does',
      'notes-refused[2] has no slug: an entry gives a non-empty string',
    ])

    given = [{ slug: 'a', data: { title: 1 } }]
    expect((await rejection(notes.all()) as ContentError).problems[0]!.message).toStartWith('title:')

    given = { entries: [] }
    await expect(notes.all()).rejects.toThrow('kay: the collection notes-refused\'s load gave object, where it gives an array of entries')

    given = [{ slug: 'a', data: { title: 'Fixed' } }]
    expect((await notes.all()).map(entry => entry.data.title)).toEqual(['Fixed'])
  })

  it('keeps the entries until invalidate(), or refreshes them in the background past a ttl', async () => {
    let loads = 0
    const notes = collection({ name: 'notes-kept', load: () => [{ slug: 'a', data: { title: `Load ${++loads}` } }] }, { schema })
    const timed = collection({ name: 'notes-timed', load: () => [{ slug: 'a', data: { title: `Load ${++loads}` } }], ttl: '1m' }, { schema })

    expect((await notes.get('a'))?.data.title).toBe('Load 1')
    expect((await notes.get('a'))?.data.title).toBe('Load 1')
    notes.invalidate()
    expect((await notes.get('a'))?.data.title).toBe('Load 2')

    expect((await timed.get('a'))?.data.title).toBe('Load 3')
    setSystemTime(new Date(Date.now() + 2 * 60_000))
    // Stale, so this read still gets it and starts the refresh the next one sees.
    expect((await timed.get('a'))?.data.title).toBe('Load 3')
    await Bun.sleep(0)
    expect((await timed.get('a'))?.data.title).toBe('Load 4')
  })
})

describe('a CMS behind a collection', () => {
  it('renders its entries, drafts left out, and shows a change once a webhook invalidates it', async () => {
    const list = await get('/news')

    expect(list.html).toContain('<li>Launch day</li>')
    expect(list.html).not.toContain('Next year')
    expect((await get('/news/launch')).html).toContain('<p class="headings">What ships</p>')
    expect((await get('/news/roadmap')).status).toBe(404)
    expect(cms.loads).toEqual([false])

    cms.entries[0]!.title = 'Launch moved'
    expect((await get('/news')).html).toContain('<li>Launch day</li>')
    expect((await app.handle(new Request('http://localhost/api/hook', { method: 'POST' }))).status).toBe(204)
    expect((await get('/news')).html).toContain('<li>Launch moved</li>')
    // The prerendered page of an entry, which the hook names no path of.
    expect((await get('/news/launch')).html).toContain('<h1>Launch moved</h1>')
  })

  it('lists its published entries in the sitemap and the feed, drafts left out', async () => {
    const sitemap = (await get('/sitemap.xml')).html
    const feed = (await get('/news/rss.xml')).html

    expect(sitemap).toContain('<loc>https://news.example/news/launch</loc>')
    expect(sitemap).not.toContain('roadmap')
    expect(feed).toContain('<title>Launch day</title>')
    expect(feed).not.toContain('Next year')
  })
})

describe('the collections a CMS edits', () => {
  it('describes each exported collection: its JSON Schema with the kinds kay knows, its folder in the repository and its draft field', async () => {
    const found = await collections()
    const articles = found.find(each => each.name === 'articles')!

    expect(found.map(each => each.name)).toEqual(['articles', 'news', 'notes', 'pages'])
    expect(found[1]).toEqual({ name: 'news', kind: 'loaded', schema: expect.objectContaining({ type: 'object', required: ['title', 'published', 'tags'] }), body: { kind: 'markdown' }, components: [], localized: false, count: 2 })
    expect(found[2]).toEqual({ name: 'notes', title: 'Notes de service', kind: 'loaded', schema: expect.objectContaining({ type: 'object' }), components: [], localized: true, count: 2 })
    expect(articles).toMatchObject({ kind: 'folder', body: { kind: 'markdown' }, components: [], localized: true, dir: 'tests/fixtures/cms/src/content/articles', draftField: 'hidden', count: 2 })
    expect(articles).not.toHaveProperty('title')
    expect(articles).not.toHaveProperty('repoRoot')
    expect(articles.schema.properties).toMatchObject({ author: { 'type': 'string', 'x-kay': { kind: 'reference', collection: 'news' } }, cover: { 'type': 'string', 'x-kay': { kind: 'image' } } })
    expect(JSON.stringify(articles.schema)).not.toContain('"Date"')
  })

  it('lists a collection by its order field, which a CMS reads as orderField', async () => {
    expect((await pagesCollection.all()).map(page => page.slug)).toEqual(['home', 'about', 'contact'])
    expect((await collections()).find(each => each.name === 'pages')).toMatchObject({ orderField: 'order' })
    expect((await collections()).find(each => each.name === 'articles')).not.toHaveProperty('orderField')
  })

  it('image and file fields take a path or an http(s) address and refuse any other scheme', () => {
    for (const field of [imageField(), fileField()]) {
      const check = TypeCompiler.Compile(field)

      for (const value of ['', '/files/a.png', 'a/b.png', '//cdn.example.com/a.png', 'https://example.com/a.png', 'http://example.com/a.png', 'HTTPS://example.com/a.png', 'my file.png'])
        expect(check.Check(value)).toBe(true)

      for (const value of ['javascript:alert(1)', 'data:text/html,x', 'JavaScript:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'vbscript:x', 'file:///etc/passwd', 'ftp://example.com/a'])
        expect(check.Check(value)).toBe(false)
    }

    const own = TypeCompiler.Compile(imageField({ pattern: '\\.png$' }))

    expect(own.Check('/a.png')).toBe(true)
    expect(own.Check('/a.jpg')).toBe(false)
    expect(own.Check('javascript:alert(1).png')).toBe(false)
  })

  it('reports a custom field kind in the schema beside the schema it wraps, so saves validate by it alone', () => {
    const color = customField('color', t.String({ pattern: '^#[0-9a-f]{6}$' }))

    expect(JSON.parse(JSON.stringify(color))).toEqual({ 'type': 'string', 'pattern': '^#[0-9a-f]{6}$', 'x-kay': { kind: 'color' } })
    expect(TypeCompiler.Compile(color).Check('#00ff00')).toBe(true)
    expect(TypeCompiler.Compile(color).Check('green')).toBe(false)
    expect(() => customField('a/b', t.String())).toThrow('names a kind outside letters')
    expect(() => customField('', t.String())).toThrow('names a kind outside letters')
  })

  it('refuses a custom field kind named like a built-in one, listing them', () => {
    for (const kind of ['text', 'textarea', 'markdown', 'number', 'integer', 'boolean', 'date', 'datetime', 'image', 'file', 'json', 'reference'])
      expect(() => customField(kind, t.String())).toThrow(`names a kind the editor has built in (text, textarea, markdown, number, integer, boolean, date, datetime, image, file, json, reference)`)

    expect(customField('select', t.String())['x-kay']).toEqual({ kind: 'select' })
  })

  it('describes one collection by name, running no other collection\'s loader', async () => {
    const info = await collectionInfo('articles')

    expect([cms.loads, await collectionInfo('posts')]).toEqual([[], undefined])
    expect(info).toEqual((await collections()).find(each => each.name === 'articles'))
  })

  it('runs a loader once for an entry screen\'s info and entry at once, and once more for each read after', async () => {
    let loads = 0
    const tales = collection({ name: 'tales', load: async () => {
      loads++
      await Bun.sleep(5)

      return [{ slug: 'hello', data: { title: 'Hello' }, body: '# Hi' }]
    } }, { schema: t.Object({ title: t.String() }) })

    await exporting([['tales', tales]], async () => {
      const [info, found] = await Promise.all([collectionInfo('tales'), entries('tales', { slug: 'hello' })])

      expect(loads).toBe(1)
      expect(info).toMatchObject({ kind: 'loaded', count: 1, body: { kind: 'markdown' } })
      expect(found.map(entry => entry.slug)).toEqual(['hello'])

      await entries('tales')

      expect(loads).toBe(2)
    })
  })

  it('does not hand a read after a save the load that began before it', async () => {
    let held = [{ slug: 'hello', data: { title: 'Old' } }]
    const gate = Promise.withResolvers<void>()
    let loads = 0
    const tales = collection({ name: 'tales', load: async () => {
      const seen = structuredClone(held)

      // Only the first load, begun before the save, stays under way.
      if (++loads === 1)
        await gate.promise

      return seen
    }, save: (entry) => {
      held = [{ slug: entry.slug, data: entry.data as { title: string } }]
    } }, { schema: t.Object({ title: t.String() }) })

    await exporting([['tales', tales]], async () => {
      const slow = entries('tales')

      expect(loads).toBe(1)
      await saveEntry('tales', { slug: 'hello', data: { title: 'New' } })

      const after = await entries('tales')

      expect(after[0]!.data).toEqual({ title: 'New' })
      gate.resolve()
      expect((await slow)[0]!.data).toEqual({ title: 'Old' })
      expect(loads).toBe(2)
    })
  })

  it.each(['save', 'remove'] as const)('does not hand a read during a %s the load that began before it', async (write) => {
    let held = [{ slug: 'hello', data: { title: 'Old' } }]
    const slowGate = Promise.withResolvers<void>()
    const writeGate = Promise.withResolvers<void>()
    const writeBegun = Promise.withResolvers<void>()
    const loadBegun = new Map<number, PromiseWithResolvers<void>>()
    const begun = (nth: number): PromiseWithResolvers<void> => loadBegun.get(nth) ?? loadBegun.set(nth, Promise.withResolvers<void>()).get(nth)!
    let loads = 0
    const tales = collection({ name: 'tales', load: async () => {
      const seen = structuredClone(held)
      const mine = ++loads

      begun(mine).resolve()

      // Only the first load, begun before the write, stays under way.
      if (mine === 1)
        await slowGate.promise

      return seen
    }, save: async (entry) => {
      writeBegun.resolve()
      await writeGate.promise
      held = [{ slug: entry.slug, data: entry.data as { title: string } }]
    }, remove: async () => {
      writeBegun.resolve()
      await writeGate.promise
      held = []
    } }, { schema: t.Object({ title: t.String() }) })

    await exporting([['tales', tales]], async () => {
      const slow = entries('tales')

      await begun(1).promise

      const writing = write === 'save' ? saveEntry('tales', { slug: 'hello', data: { title: 'New' } }) : removeEntry('tales', 'hello')

      await writeBegun.promise

      const before = loads
      const during = entries('tales')

      // The read made while the write is under way begins its own load rather than joining the first, which is still under way.
      await begun(before + 1).promise
      expect(loads).toBe(before + 1)
      writeGate.resolve()
      await writing
      await during
      slowGate.resolve()
      expect((await slow)[0]!.data).toEqual({ title: 'Old' })
      expect((await entries('tales')).map(entry => entry.data)).toEqual(write === 'save' ? [{ title: 'New' }] : [])
    })
  })

  it('keeps sharing the load a save started after the older one it replaced ends', async () => {
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    const secondBegun = Promise.withResolvers<void>()
    let loads = 0
    const tales = collection({ name: 'tales', load: async () => {
      const mine = ++loads

      if (mine === 2)
        secondBegun.resolve()

      // The first two loads stay under way until the test ends them; any other runs at once.
      await gates[mine - 1]?.promise

      return [{ slug: 'hello', data: { title: 'Hello' } }]
    }, save: () => undefined }, { schema: t.Object({ title: t.String() }) })

    await exporting([['tales', tales]], async () => {
      const first = entries('tales')

      await saveEntry('tales', { slug: 'hello', data: { title: 'Hello' } })

      const second = entries('tales')

      await secondBegun.promise
      gates[0]!.resolve()
      await first

      // The older load has ended, and the newer one is still under way for this read to share.
      const third = entries('tales')

      gates[1]!.resolve()
      await Promise.all([second, third])

      expect(loads).toBe(2)
    })
  })

  it('leaves a loader alone for the names and kinds of its collections when counts is false', async () => {
    let loads = 0
    const tales = collection({ name: 'tales', load: () => {
      loads++

      return []
    } }, { schema: t.Object({ title: t.String() }) })

    await exporting([['tales', tales]], async () => {
      expect(await collectionInfo('tales', { counts: false })).toEqual({ name: 'tales', kind: 'loaded', schema: expect.objectContaining({ type: 'object' }), components: [], localized: false })
      expect((await collections({ counts: false })).map(each => each.name)).toEqual(['tales'])
      expect(loads).toBe(0)
    })
  })

  it('asks a loader able to count for the count, and to give one entry for that entry, running `load` for neither', async () => {
    const calls: string[] = []
    const tales = collection({
      name: 'tales',
      load: () => {
        calls.push('load')

        return []
      },
      count: () => {
        calls.push('count')

        return 7
      },
      body: false,
      get: (place) => {
        calls.push(`get ${place}`)

        return place === 'fr/hello' ? { slug: place, data: { title: 'Salut' }, html: '' } : undefined
      },
    }, { schema: t.Object({ title: t.String() }), localized: true })

    await exporting([['tales', tales]], async () => {
      expect(await collectionInfo('tales')).toMatchObject({ kind: 'loaded', count: 7 })
      expect(await collectionInfo('tales')).not.toHaveProperty('body')
      expect((await entries('tales', { slug: 'hello', locale: 'fr' })).map(entry => [entry.slug, entry.locale, entry.data])).toEqual([['hello', 'fr', { title: 'Salut' }]])
      expect(await entries('tales', { slug: 'hello', locale: 'en' })).toEqual([])
      expect(calls).toEqual(['count', 'count', 'get fr/hello', 'get en/hello'])

      // Without a locale in a localized collection the slug could be any locale's, so `load` runs.
      await entries('tales', { slug: 'hello' })

      expect(calls.at(-1)).toBe('load')
    })
  })

  it('reads the entries a filter keeps in full, in their order, and of the other files only the slug they may set', async () => {
    const read = spyOn(Bun, 'file')

    try {
      expect(await entries('articles', { slug: 'hello', locale: 'fr' })).toMatchObject([{ slug: 'hello', locale: 'fr', data: { title: 'Bonjour' } }])
      // Each file is read for a `slug` of its own; the entry itself is parsed once more.
      expect(read.mock.calls.filter(([file]) => String(file).includes('articles'))).toHaveLength(3)
    }
    finally {
      read.mockRestore()
    }

    expect((await entries('articles', { offset: 1, limit: 1 })).map(entry => entry.locale)).toEqual(['fr'])
    expect((await entries('news', { offset: 1 })).map(entry => entry.slug)).toEqual(['roadmap'])
    expect((await entries('notes', { slug: 'hello' })).map(entry => entry.locale)).toEqual(['en', 'fr'])
    expect(await entries('news', { slug: 'nothing' })).toEqual([])
  })

  it('lists entries as their source holds them, drafts included and told apart, one locale\'s when asked', async () => {
    expect(await entries('news')).toEqual([
      { slug: 'launch', data: { title: 'Launch day', published: true, tags: ['launch'] }, body: '## What ships\n\nEverything.', draft: false, url: '/news/launch' },
      { slug: 'roadmap', data: { title: 'Next year', published: false, tags: ['roadmap'] }, body: 'Not yet.', draft: true, url: '/news/roadmap' },
    ])
    expect(cms.loads).toEqual([true])
    expect(await entries('articles', { locale: 'fr' })).toEqual([{ slug: 'hello', locale: 'fr', path: 'tests/fixtures/cms/src/content/articles/fr/hello.md', data: { title: 'Bonjour' }, body: '\nSalut.\n', draft: false, url: '/articles/hello' }])
    expect((await entries('articles')).map(entry => [entry.locale, entry.draft])).toEqual([['en', true], ['fr', false]])
    expect(await articles.all('en')).toEqual([])
    expect(await entries('notes', { locale: 'fr' })).toEqual([{ slug: 'hello', locale: 'fr', data: { title: 'Salut' }, draft: false }])
    expect(await rejection(entries('posts'))).toMatchObject({ message: 'kay: no collection is exported from the content config as posts; it exports articles, news, notes, pages' })
    expect(await rejection(entries('news', { locale: 'fr' }))).toMatchObject({ message: 'kay: entries() was asked for the fr entries of news, which is not localized' })
    expect(() => parseEntry('broken.json', '{')).toThrow(MarkdownError)
  })

  it('names the line of the file a frontmatter or YAML error sits on, not the YAML\'s own', () => {
    const lineOf = (name: string, source: string): number | undefined => {
      try {
        parseEntry(name, source)

        return undefined
      }
      catch (error) {
        return error instanceof MarkdownError ? error.line : undefined
      }
    }

    expect(lineOf('a.md', '---\ntitle: A\ndescription: How X: y\nz: 1\n---\nBody\n')).toBe(3)
    // The first field is on line 2, after the delimiter.
    expect(lineOf('a.md', '---\ntitle: How X: y\n---\n')).toBe(2)
    // A field spanning lines is named where it starts, and what is valid before it stays unblamed.
    expect(lineOf('a.md', '---\ntags: [a,\n  b]\nlist:\n  - one\ndescription: How X: y\n---\n')).toBe(6)
    expect(lineOf('a.md', '---\ntags:\n  - a\n  - [b\n---\n')).toBe(2)
    expect(lineOf('a.yaml', 'title: A\n\ndescription: How X: y\n')).toBe(3)
    // A field breaking only with the others around it is told where the YAML starts.
    expect(lineOf('a.md', '---\na: 1\n  b: 2\n---\n')).toBe(2)
    expect(lineOf('a.md', '---\ntitle: A\nz: 1\n---\nBody\n')).toBeUndefined()
  })

  it('takes as draft field a boolean one alone', () => {
    // @ts-expect-error title holds a string
    expect(collection('content/none', { schema: t.Object({ title: t.String(), hidden: t.Optional(t.Boolean()) }), draft: 'title' }).name).toBe('content/none')
    expect(collection('content/none', { schema: t.Object({ title: t.String(), hidden: t.Optional(t.Boolean()) }), draft: 'hidden' }).name).toBe('content/none')
  })

  it('names the locales the site serves, and refuses an entry written in another', async () => {
    const before = registerEditSite({ urls: async () => undefined, locales: ['en', 'fr'] })

    try {
      expect((await collections())[0]).toMatchObject({ name: 'articles', locales: ['en', 'fr'] })
      expect(await entrySource('articles', 'hello', { title: 'Hallo' }, { locale: 'de' })).toEqual({ issues: [{ collection: 'articles', slug: 'hello', locale: 'de', path: '', key: 'locale', message: 'names a locale the site does not serve: it serves en, fr' }] })
    }
    finally {
      registerEditSite(before)
    }
  })

  it('finds an entry\'s page from the route prerendering its collection, in its locale, under the base, on its domain', async () => {
    const route = { pattern: '/news/:slug', file: resolve(`${FIXTURE}/src/routes/news/[slug].kay`), params: ['slug'], layouts: [], special: {}, guards: [] } as unknown as ServedRoute
    const settings = { locales: ['en', 'fr'], defaultLocale: 'en', prefixDefault: false }
    const urls = entryUrls([route], '/site', 'always', settings)

    expect(await urls(news, { slug: 'launch' })).toBe('/site/news/launch/')
    expect(await urls(news, { slug: 'launch', locale: 'fr' })).toBe('/site/fr/news/launch/')
    expect(await urls(articles, { slug: 'hello', locale: 'fr' })).toBeUndefined()
    expect(await entryUrls([route], '', undefined, { ...settings, hosts: { en: 'news.example', fr: 'nouvelles.example' } })(news, { slug: 'launch', locale: 'fr' })).toBe('https://nouvelles.example/news/launch')
  })

  it('gives a folder entry\'s file as the editor wrote it, keeping its format and body, for the CMS to commit', async () => {
    const hello = 'tests/fixtures/cms/src/content/articles/fr/hello.md'

    expect(await entrySource('articles', 'hello', { title: 'Salut', published: '2026-01-01T00:00:00.000Z' }, { locale: 'fr' })).toEqual({ file: { path: hello, absolute: join(process.cwd(), hello), repoPath: hello, text: '---\ntitle: Salut\npublished: 2026-01-01T00:00:00.000Z\n---\n\nSalut.\n' } })
    expect(await entrySource('articles', 'new-one', { title: 'New' }, { locale: 'en', body: '# Hi' })).toMatchObject({ file: { path: 'tests/fixtures/cms/src/content/articles/en/new-one.md', text: '---\ntitle: New\n---\n\n# Hi\n' } })
    expect(await entrySource('articles', '../escape', { title: 3 })).toEqual({ issues: [
      { collection: 'articles', slug: '../escape', path: '', key: 'slug', message: 'has a slug naming another file than its own: its parts are not empty, ., .. nor hidden' },
      { collection: 'articles', slug: '../escape', path: '', key: 'locale', message: 'names no locale, which each entry of a localized collection has' },
      { collection: 'articles', slug: '../escape', path: 'title', message: expect.any(String) },
    ] })
    expect(await rejection(entrySource('news', 'launch', {}))).toMatchObject({ message: expect.stringContaining('saveEntry()') })
  })

  // kayjs-cms's script check leaves a body bodyHtml cannot read to this refusal.
  it.each(['<Callout onclick=alert(1)//}>hi', '<Callout onmouseover=alert(1)//} />'])('refuses a body holding a component tag kay cannot read: %s', async (body) => {
    expect(await entrySource('articles', 'hostile', { title: 'X' }, { locale: 'en', body })).toEqual({ issues: expect.arrayContaining([expect.objectContaining({ collection: 'articles', slug: 'hostile', body: true })]) })
    expect(await saveEntry('news', { slug: 'hostile', data: { title: 'X', published: '2026-01-01T00:00:00.000Z', tags: [] }, body })).toEqual({ issues: expect.arrayContaining([expect.objectContaining({ collection: 'news', slug: 'hostile', body: true })]) })
  })

  // An entry's data is an object of fields, as `entries()` reads it back.
  it.each([
    ['a list', 'entrySource', 'pages', 'listed', [1]],
    ['a string', 'saveEntry', 'news', 'plain', 'text'],
  ] as const)('refuses data that is %s, not an object of fields', async (kind, call, collection, slug, data) => {
    const result = call === 'entrySource' ? await entrySource(collection, slug, data) : await saveEntry(collection, { slug, data })

    expect(result).toEqual({ issues: [{ collection, slug, path: '', message: `holds a ${kind.slice(2)} as its data, not an object of fields` }] })
  })

  it('gives the file a folder entry is read from, for the CMS to delete', async () => {
    const hello = 'tests/fixtures/cms/src/content/articles/fr/hello.md'
    const contact = 'tests/fixtures/cms/src/content/pages/contact.yaml'

    expect(await entryFile('articles', 'hello', { locale: 'fr' })).toEqual({ file: { path: hello, absolute: join(process.cwd(), hello), repoPath: hello } })
    expect(await entryFile('pages', 'contact')).toEqual({ file: { path: contact, absolute: join(process.cwd(), contact), repoPath: contact } })
    // An option given as undefined is absent, and a JSON entry is found as any other.
    expect(await entryFile('pages', 'about', { locale: undefined })).toMatchObject({ file: { path: 'tests/fixtures/cms/src/content/pages/about.json' } })
    expect(await entryFile('pages', 'missing')).toEqual({ issues: [{ collection: 'pages', slug: 'missing', path: '', key: 'slug', message: 'names no entry of the collection' }] })
    expect(await entryFile('articles', 'hello')).toMatchObject({ issues: [{ key: 'locale' }] })
    expect(await entryFile('pages', '../pages/about')).toMatchObject({ issues: [{ key: 'slug' }] })
    expect(await rejection(entryFile('news', 'launch'))).toMatchObject({ message: expect.stringContaining('removeEntry()') })

    const base = await scratchDir('cms-')

    await readingFrom(base, ['content/pages'], async () => {
      await mkdir(join(base, 'content/pages/guide'), { recursive: true })
      await writeFile(join(base, 'content/pages/guide/index.md'), '---\ntitle: Guide\norder: 5\n---\n')

      expect(await entryFile('pages', 'guide')).toMatchObject({ file: { absolute: join(base, 'content/pages/guide/index.md') } })
    })
  })

  it('refuses a slug naming another file in a folder: hidden, a new file reading back as another entry, a control character, an empty part', async () => {
    for (const slug of ['.hidden', 'guide/index', 'a\u0000b', 'a//b', ''])
      expect(await entrySource('pages', slug, { title: 'T', order: 1 })).toMatchObject({ issues: [{ key: 'slug' }] })

    expect(await entrySource('pages', 'index', { title: 'T', order: 1 })).toMatchObject({ file: { path: 'tests/fixtures/cms/src/content/pages/index.md' } })
    // `en/index.md` would read back as an entry `en` outside any locale.
    expect(await entrySource('articles', 'index', { title: 'T' }, { locale: 'en' })).toEqual({ issues: [{ collection: 'articles', slug: 'index', locale: 'en', path: '', key: 'slug', message: 'has a slug whose file, en/index, reads back as no entry of a locale: give the entry another slug' }] })
    expect(await entrySource('pages', 'guide/index', { title: 'T', order: 1 })).toMatchObject({ issues: [{ key: 'slug', message: 'has a slug whose file, guide/index, reads back as guide: write the entry as guide' }] })
    // A draft takes the same rule, so the page shows no entry the CMS cannot save.
    expect(await entryIssues('pages', pagesCollection, { slug: 'guide/index', data: { title: 'T', order: 1 } })).toMatchObject({ issues: [{ key: 'slug' }] })

    const base = await scratchDir('cms-')

    await readingFrom(base, ['content/pages'], async () => {
      await mkdir(join(base, 'content/pages/guide/index'), { recursive: true })
      await writeFile(join(base, 'content/pages/guide/index/index.json'), '{}\n')

      expect(await entrySource('pages', 'guide/index', { title: 'Guide', order: 5 })).toMatchObject({ file: { absolute: join(base, 'content/pages/guide/index/index.json') } })
    })
  })

  it('writes each entry back as it read it, in its own format', async () => {
    const dir = `${FIXTURE}/src/content/pages`

    // An option given as undefined is absent, as an entry read back hands it.
    for (const entry of await entries('pages', { locale: undefined })) {
      const written = await entrySource('pages', entry.slug, entry.data, { locale: entry.locale, body: entry.body })

      expect(written).toMatchObject({ file: { path: entry.path } })
      expect('file' in written && written.file.text).toBe(await Bun.file(entry.path!).text())
    }

    expect((await entries('pages')).map(entry => entry.path)).toEqual([`${dir}/about.json`, `${dir}/contact.yaml`, `${dir}/home.md`])
    expect(await entrySource('pages', 'home', { title: 'Home', order: 1 }, { body: '\r\n  Indented.\r\n\r\n' })).toMatchObject({ file: { text: '---\ntitle: Home\norder: 1\n---\n\n  Indented.\n' } })
    expect(await entrySource('pages', 'about', { title: 'About', order: 2 }, { body: 'Dropped.' })).toEqual({ issues: [{ collection: 'pages', slug: 'about', path: '', body: true, message: 'goes to about.json, a data file holding no body' }] })
  })

  it('lists a file that does not parse with its problem, and throws for a folder missing, as from a build alone', async () => {
    const base = await scratchDir('cms-')

    await readingFrom(base, ['content/pages'], async () => {
      await writeFile(join(base, 'content/pages/broken.json'), '{')
      await writeFile(join(base, 'content/pages/torn.md'), '---\ntitle: [\n---\n\nLost.\n')
      await writeFile(join(base, 'content/pages/listed.yaml'), '- one\n')
      await writeFile(join(base, 'content/pages/empty.yaml'), '')

      expect((await entries('pages')).find(entry => entry.slug === 'broken')).toEqual({ slug: 'broken', path: expect.stringMatching(/content\/pages\/broken\.json$/), data: undefined, draft: false, problem: expect.stringContaining('content/pages/broken.json:1 the JSON does not parse') })
      expect((await entries('pages')).find(entry => entry.slug === 'listed')).toMatchObject({ data: undefined, problem: expect.stringMatching(/content\/pages\/listed\.yaml holds a list, not an entry's fields$/) })
      expect((await entries('pages')).find(entry => entry.slug === 'empty')).toMatchObject({ data: undefined, problem: expect.stringMatching(/content\/pages\/empty\.yaml holds null, not an entry's fields$/) })
      expect(await rejection(entries('articles'))).toMatchObject({ message: expect.stringMatching(/^kay: articles's folder .*content\/articles is missing/) })
      expect((await collections()).find(each => each.name === 'articles')).toMatchObject({ body: { kind: 'markdown' } })
      // The editor writes over a file that does not parse, in its name, a Markdown one keeping the body its frontmatter did not break.
      expect(await entrySource('pages', 'broken', { title: 'Mended', order: 4 })).toMatchObject({ file: { absolute: join(base, 'content/pages/broken.json'), text: '{\n  "title": "Mended",\n  "order": 4\n}\n' } })
      expect((await entries('pages')).find(entry => entry.slug === 'torn')).toMatchObject({ data: undefined, body: '\nLost.\n', problem: expect.stringContaining('torn.md') })
      expect(await entrySource('pages', 'torn', { title: 'Torn', order: 5 })).toMatchObject({ file: { absolute: join(base, 'content/pages/torn.md'), text: '---\ntitle: Torn\norder: 5\n---\n\nLost.\n' } })
      expect(await entrySource('pages', 'torn', { title: 'Torn', order: 5 }, { body: 'Found.' })).toMatchObject({ file: { text: '---\ntitle: Torn\norder: 5\n---\n\nFound.\n' } })
    })
  })

  it('leaves out the folder and paths of a collection outside the repository, and writes none of its files', async () => {
    const base = await mkdtemp(join(tmpdir(), 'kay-cms-'))

    await readingFrom(base, ['content/pages'], async () => {
      const pages = (await collections()).find(each => each.name === 'pages')

      expect(pages).not.toHaveProperty('dir')
      expect((await entries('pages'))[0]).not.toHaveProperty('path')
      expect(await rejection(entrySource('pages', 'about', { title: 'About', order: 2 }))).toMatchObject({ message: expect.stringContaining('outside the repository') })
    })
  })

  it('reads a loader as it is, refusing what gives no entries, telling a collection failing to read, and hands `url` the data its schema decoded alone', async () => {
    const schema = t.Object({ title: t.String() })
    const odd = collection({ name: 'odd', load: (() => 'nope') as never }, { schema })
    const slugless = collection({ name: 'slugless', load: (() => [{ data: {} }]) as never }, { schema })
    const listy = collection({ name: 'listy', load: (() => [{ slug: 'a', data: ['x'], html: '' }, { slug: 'b', data: 'x', html: '' }, { slug: 'c', html: '' }]) as never }, { schema })
    const broken = collection({ name: 'broken', load: () => {
      throw new Error('the CMS is down')
    } }, { schema })
    const titled = collection({ name: 'titled', load: () => [{ slug: 'good', data: { title: 'Good' }, html: '' }, { slug: 'bad', data: { title: 3 }, html: '' }] }, { schema, url: entry => `/t/${entry.data.title.toLowerCase()}` })
    const failing = collection({ name: 'failing', load: () => [{ slug: 'one', data: { title: 'One' }, html: '' }] }, { schema, url: () => {
      throw new Error('no page')
    } })

    await exporting([['odd', odd], ['slugless', slugless], ['listy', listy], ['broken', broken], ['titled', titled], ['failing', failing]], async () => {
      expect(await rejection(entries('odd'))).toMatchObject({ message: 'kay: odd\'s load gave string, not an array of entries' })
      expect(await rejection(entries('slugless'))).toMatchObject({ message: 'kay: slugless\'s load gave an entry with no slug: {"data":{}}' })
      expect((await entries('listy')).map(entry => entry.problem)).toEqual(['a list', 'a string', 'undefined'].map((kind, at) => `kay: listy's entry ${'abc'[at]} holds ${kind} as its data, not an object of fields`))
      expect((await collections()).find(each => each.name === 'broken')).toMatchObject({ body: { kind: 'markdown' }, problem: 'kay: broken\'s entries failed to read; the server\'s log says why' })
      expect(await rejection(entries('broken'))).toMatchObject({ message: 'kay: broken\'s load threw: the CMS is down' })
      expect((await collections()).find(each => each.name === 'titled')).not.toHaveProperty('problem')

      const before = registerEditSite({ urls: async (_, entry) => `/route/${entry.slug}` })

      try {
        // An entry the schema refuses takes the route's page.
        expect((await entries('titled')).map(entry => entry.url)).toEqual(['/t/good', '/route/bad'])
      }
      finally {
        registerEditSite(before)
      }

      expect(await rejection(entries('failing'))).toMatchObject({ message: 'no page' })
    })
  })

  it('hands a loaded entry to its loader\'s save and remove, then reads the collection afresh', async () => {
    expect(await saveEntry('news', { slug: 'later', data: { title: 'Later on', published: true, tags: [] }, body: 'Soon.' })).toEqual({})
    expect((await news.get('later'))?.data.title).toBe('Later on')
    expect(await saveEntry('news', { slug: 'later', data: { title: 3 } })).toMatchObject({ issues: [{ collection: 'news', slug: 'later', path: 'published' }, { path: 'tags' }, { path: 'title' }] })
    expect(await removeEntry('news', 'later')).toEqual({})
    expect(await news.get('later')).toBeUndefined()
    expect(await rejection(saveEntry('articles', { slug: 'hello', locale: 'fr', data: { title: 'T' } }))).toMatchObject({ message: expect.stringContaining('entrySource()') })
  })

  it('takes a loaded slug as its loader does, refusing one climbing out, and removes only an entry it has', async () => {
    expect(await saveEntry('news', { slug: '/about', data: { title: 'About', published: true, tags: [] } })).toEqual({})
    expect(await removeEntry('news', '/about')).toEqual({})
    expect(await removeEntry('news', '/about')).toEqual({ issues: [{ collection: 'news', slug: '/about', path: '', key: 'slug', message: 'names no entry of the collection' }] })
    expect(await removeEntry('news', '../launch')).toMatchObject({ issues: [{ key: 'slug', message: expect.stringContaining('. or ..') }] })
    expect(await removeEntry('news', '..\\launch')).toMatchObject({ issues: [{ key: 'slug' }] })
    expect(await removeEntry('news', 'launch', 'fr')).toMatchObject({ issues: [{ key: 'locale' }] })
    expect(await saveEntry('news', { slug: 'a/../b', data: { title: 'T', published: true, tags: [] } })).toMatchObject({ issues: [{ key: 'slug' }] })
    expect(cms.entries.map(entry => entry.slug)).toEqual(['launch', 'roadmap'])
  })

  it('removes a localized loader\'s entry in its locale', async () => {
    let held = [{ slug: 'en/hello', data: { title: 'Hello' }, html: '' }, { slug: 'fr/hello', data: { title: 'Salut' }, html: '' }]
    const tales = collection({ name: 'tales', load: () => held, remove: ({ slug, locale }) => {
      held = held.filter(entry => entry.slug !== `${locale}/${slug}`)
    } }, { schema: t.Object({ title: t.String() }), localized: true })

    await exporting([['tales', tales]], async () => {
      expect(await removeEntry('tales', 'hello', 'fr')).toEqual({})
      expect(held.map(entry => entry.slug)).toEqual(['en/hello'])
      expect(await removeEntry('tales', 'hello', 'fr')).toMatchObject({ issues: [{ key: 'slug', message: 'names no entry of the collection' }] })
    })
  })

  it('refuses to create an entry the collection holds, and tells the loader\'s save it creates', async () => {
    const saved: unknown[] = []
    let loads = 0
    let held = [{ slug: 'en/hello', data: { title: 'Hello' }, html: '' }]
    // Ignores `create`, overwriting as a plain save does.
    const tales = collection({ name: 'tales', load: () => {
      loads++

      return held
    }, save: async (entry) => {
      await Bun.sleep(5)
      saved.push(entry)
      held = [...held.filter(each => each.slug !== `${entry.locale}/${entry.slug}`), { slug: `${entry.locale}/${entry.slug}`, data: entry.data as { title: string }, html: '' }]
    } }, { schema: t.Object({ title: t.String() }), localized: true })

    await exporting([['tales', tales]], async () => {
      expect(await saveEntry('tales', { slug: 'hello', locale: 'en', data: { title: 'Hi' } }, { create: true })).toEqual({ issues: [{ collection: 'tales', slug: 'hello', locale: 'en', path: '', key: 'slug', message: 'names an entry the collection already holds' }] })
      expect(loads).toBe(1)
      expect(await saveEntry('tales', { slug: 'hello', locale: 'fr', data: { title: 'Salut' } }, { create: true })).toEqual({})
      expect(await saveEntry('tales', { slug: 'hello', locale: 'fr', data: { title: 'Bonjour' } })).toEqual({})
      expect(saved).toEqual([{ slug: 'hello', locale: 'fr', data: { title: 'Salut' }, create: true }, { slug: 'hello', locale: 'fr', data: { title: 'Bonjour' } }])
      // Two creates at once run in turn, the second finding the first's entry.
      expect(await Promise.all(['Un', 'Deux'].map(async title => saveEntry('tales', { slug: 'new', locale: 'fr', data: { title } }, { create: true })))).toEqual([{}, { issues: [expect.objectContaining({ slug: 'new', key: 'slug' })] }])
      expect(held.find(each => each.slug === 'fr/new')?.data.title).toBe('Un')
    })

    const order: string[] = []
    const gate = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    let kept = [{ slug: 'kept', data: { title: 'Kept' }, html: '' }]
    // Each save waits for the gate, a create then refusing the entry another process wrote.
    const refusing = collection({ name: 'refusing', load: () => kept, save: async (entry) => {
      order.push(`save ${entry.slug}`)
      started.resolve()
      await gate.promise

      if (entry.create === true)
        throw new Error('kept by another editor')
    }, remove: (entry) => {
      order.push(`remove ${entry.slug}`)
      kept = kept.filter(each => each.slug !== entry.slug)
    } }, { schema: t.Object({ title: t.String() }) })
    const invalidated = spyOn(refusing, 'invalidate')
    const other = collection({ name: 'other', load: () => [], save: () => undefined }, { schema: t.Object({ title: t.String() }) })

    await exporting([['refusing', refusing], ['other', other]], async () => {
      const thrown = saveEntry('refusing', { slug: 'taken', data: { title: 'T' } }, { create: true })

      await started.promise
      const removed = removeEntry('refusing', 'kept')
      const next = saveEntry('refusing', { slug: 'taken', data: { title: 'T' } })

      // While the gate holds the save, an invalid save and another collection's resolve, and the remove and the save after the invalid one wait.
      expect(await saveEntry('refusing', { slug: 'bad', data: { title: 3 } })).toMatchObject({ issues: [{ path: 'title' }] })
      const later = saveEntry('refusing', { slug: 'later', data: { title: 'T' } })

      expect(await saveEntry('other', { slug: 'free', data: { title: 'T' } })).toEqual({})
      expect(order).toEqual(['save taken'])
      gate.resolve()

      // The remove after the save that threw runs, and the next save after it.
      expect(await rejection(thrown)).toMatchObject({ message: 'kept by another editor' })
      expect(await removed).toEqual({})
      expect(await next).toEqual({})
      expect(await later).toEqual({})
      expect(order).toEqual(['save taken', 'remove kept', 'save taken', 'save later'])
      expect(invalidated).toHaveBeenCalledTimes(3)
    })
  })

  it('passes the turn on from a save whose check throws', async () => {
    let failing = true
    const flaky = collection({ name: 'flaky', load: () => {
      if (failing)
        throw new Error('the CMS is down')

      return []
    }, save: () => undefined }, { schema: t.Object({ title: t.String() }) })

    await exporting([['flaky', flaky]], async () => {
      const thrown = saveEntry('flaky', { slug: 'a', data: { title: 'T' } }, { create: true })
      const next = saveEntry('flaky', { slug: 'b', data: { title: 'T' } })

      expect(await rejection(thrown)).toMatchObject({ message: 'kay: flaky\'s load threw: the CMS is down' })
      failing = false
      expect(await next).toEqual({})
    })
  })

  it('runs a collection\'s saves in the order they are called, keeping the later of two saves of one entry', async () => {
    let held: { slug: string, data: unknown, body?: string | undefined }[] = []
    const autosaved = collection({ name: 'autosaved', load: () => held.map(entry => ({ ...entry, body: entry.body ?? '' })), save: (entry) => {
      held = [...held.filter(each => each.slug !== entry.slug), entry]
    } }, { schema: t.Object({ title: t.String() }) })

    await exporting([['autosaved', autosaved]], async () => {
      // The first takes longer to check, its body compiled.
      const saves = [saveEntry('autosaved', { slug: 'draft', data: { title: 'First' }, body: '# First\n\nWith a body.' }), saveEntry('autosaved', { slug: 'draft', data: { title: 'Second' } })]

      expect(await Promise.all(saves)).toEqual([{}, {}])
      expect(held).toEqual([{ slug: 'draft', data: { title: 'Second' } }])
    })
  })

  it('refuses to give the file of a new entry the folder holds, in any format, locale or index file', async () => {
    const taken = (collection: string, slug: string, locale?: string) => ({ issues: [{ collection, slug, ...locale !== undefined && { locale }, path: '', key: 'slug' as const, message: 'names an entry the collection already holds' }] })

    expect(await entrySource('pages', 'about', { title: 'About', order: 2 }, { create: true })).toEqual(taken('pages', 'about'))
    expect(await entrySource('pages', 'contact', { title: 'Contact', order: 3 }, { create: true })).toEqual(taken('pages', 'contact'))
    expect(await entrySource('articles', 'hello', { title: 'Salut' }, { locale: 'fr', create: true })).toEqual(taken('articles', 'hello', 'fr'))
    expect(await entrySource('pages', 'fresh', { title: 'Fresh', order: 9 }, { create: true })).toMatchObject({ file: { path: 'tests/fixtures/cms/src/content/pages/fresh.md' } })

    const base = await scratchDir('cms-')

    await readingFrom(base, ['content/pages'], async () => {
      await mkdir(join(base, 'content/pages/guide'), { recursive: true })
      await writeFile(join(base, 'content/pages/guide/index.md'), '---\ntitle: Guide\norder: 5\n---\n')

      expect(await entrySource('pages', 'guide', { title: 'Guide', order: 5 }, { create: true })).toEqual(taken('pages', 'guide'))
    })
  })

  it('names the method a loader lacks to save or remove its entries', async () => {
    expect(await rejection(saveEntry('notes', { slug: 'hello', locale: 'en', data: { title: 'Hi' } }))).toMatchObject({ message: 'kay: notes\'s loader declares no save, which saveEntry() hands the entry to' })
    expect(await rejection(removeEntry('notes', 'hello', 'en'))).toMatchObject({ message: 'kay: notes\'s loader declares no remove, which removeEntry() hands the entry to' })
  })

  it('forgets the site a server registered once it stops', async () => {
    const before = registerEditSite(undefined)

    registerEditSite(before)

    const served = (await pages({ ...options, prebuilt: false })).listen(0)
    let running = true

    try {
      const registered = registerEditSite(undefined)

      registerEditSite(registered)
      expect(registered).toBeDefined()
      expect(registered).not.toBe(before)
      await served.stop()
      running = false
      expect(registerEditSite(undefined)).toBeUndefined()
    }
    finally {
      if (running)
        await served.stop()

      registerEditSite(before)
    }
  })
})

describe('preview mode', () => {
  it('lets in a signed link, and refuses any other, one carrying the secret itself included', async () => {
    const link = previewUrl('/news/roadmap')
    const entered = await app.handle(new Request(`http://localhost${link}`))

    expect(entered.status).toBe(307)
    expect(entered.headers.get('location')).toBe('/news/roadmap')
    expect(entered.headers.get('cache-control')).toBe('no-store')
    expect(entered.headers.get('set-cookie')).toMatch(/^kay_preview=\d+\.[\w-]+; Path=\/; Max-Age=3600; HttpOnly; SameSite=Lax$/)

    expect(link).toStartWith('/_kay/preview?path=%2Fnews%2Froadmap&until=')
    expect(await previewCookie(link)).toStartWith('kay_preview=')

    const refuse = async (path: string) => (await app.handle(new Request(`http://localhost${path}`))).status

    // A URL stays in histories and proxy logs, so the secret itself opens nothing.
    expect(await refuse(`/_kay/preview?path=/news&secret=${SECRET}`)).toBe(403)
    expect(await refuse(`/_kay/preview?path=/news&edit&secret=${SECRET}`)).toBe(403)
    expect(await refuse('/_kay/preview?path=/news')).toBe(403)
    expect(await refuse(link.replace('roadmap', 'launch'))).toBe(403)
    expect(await refuse(`/_kay/preview?path=//evil.example&secret=${SECRET}`)).toBe(400)

    setSystemTime(new Date(Date.now() + 2 * 60 * 60_000))
    expect(await refuse(link)).toBe(403)
  })

  it('puts a visitor in edit mode through a signed link or a guard, signed apart from preview mode so neither turns into it', async () => {
    const mode = (cookie: string) => {
      const request = new Request('http://localhost/', { headers: { cookie } })

      expect(editRequested(request)).toBe(previewRequested(request) === 'edit')

      return previewRequested(request)
    }
    const byLink = await previewCookie(previewUrl('/news', { edit: true }))
    const link = previewUrl('/news', { edit: true })
    const cookies = new Bun.CookieMap()

    enterPreview({ cookies, request: new Request('http://localhost/') }, { edit: true })

    expect(byLink).toMatch(/^kay_preview=\d+\.edit\.[\w-]+$/)
    expect(mode(byLink)).toBe('edit')
    expect(link).toContain('&edit=&sig=')
    expect(mode(await previewCookie(link))).toBe('edit')
    expect(mode(`kay_preview=${cookies.get('kay_preview')}`)).toBe('edit')
    expect(mode(await previewCookie(previewUrl('/news')))).toBe('preview')

    const preview = await previewCookie(previewUrl('/news'))
    const [until, sig] = preview.slice('kay_preview='.length).split('.')

    expect(mode(`kay_preview=${until}.edit.${sig}`)).toBeUndefined()
    expect(mode(byLink.replace('.edit.', '.'))).toBeUndefined()
    expect((await app.handle(new Request(`http://localhost${previewUrl('/news')}&edit`))).status).toBe(403)
    expect((await get('/news', byLink)).headers.get('cache-control')).toBe('private, no-store')
    expect([previewing(), editing()]).toEqual([false, false])
    expect(inPreview(() => [previewing(), editing()], true)).toEqual([true, true])
    expect(inPreview(() => [previewing(), editing()])).toEqual([true, false])
  })

  it('lets an edit cookie read only the entries the pages it rendered in edit mode read', async () => {
    // A second no other test's cookie was made in.
    setSystemTime(new Date(Date.now() + 10 * 60_000))

    const edit = await previewCookie(previewUrl('/news', { edit: true }))
    const asked = (cookie: string, slug = 'launch') => editedEntry(new Request('http://localhost/', { headers: { cookie } }), 'news', slug)

    expect(asked(edit)).toBe(false)
    await get('/marks/launch', edit)
    expect(asked(edit)).toBe(true)
    expect(asked(edit, 'roadmap')).toBe(false)
    setSystemTime(new Date(Date.now() + 2000))

    const other = await previewCookie(previewUrl('/news', { edit: true }))

    // Another cookie, a preview one and none at all share nothing of it.
    expect(asked(other)).toBe(false)
    expect(asked(await previewCookie(previewUrl('/news')))).toBe(false)
    expect(editedEntry(new Request('http://localhost/'), 'news', 'launch')).toBe(false)

    setSystemTime(new Date(Date.now() + 2 * 60 * 60_000))
    expect(asked(edit)).toBe(false)
  })

  it('marks in edit mode the markup each field and body renders, the same page byte for byte outside it', async () => {
    const edit = await previewCookie(previewUrl('/news', { edit: true }))
    const preview = await previewCookie(previewUrl('/news'))
    const { html } = await get('/marks/launch', edit)

    expect(html).toContain('<h1 data-kay-field="news:launch:title">Launch day</h1>')
    expect(html).toContain('<h2 class="headline" data-kay-field="news:launch:title">Launch day</h2>')
    expect(html).toContain('<p>Posted as <!--kay-field news:launch:title-->Launch day<!--/kay-field--></p>')
    expect(html).toContain('<img src="/cover.png" alt="Launch day" data-kay-field-alt="news:launch:title" loading="lazy" decoding="async">')
    expect(html).toContain('<ul data-kay-list="news:launch:tags"><li data-kay-field="news:launch:tags.0">launch</li></ul>')
    expect(html).toContain('<textarea>Draft: Launch day</textarea>')
    expect(html).toContain('<article data-kay-body="news:launch"><h2 id="what-ships">')
    expect(html).not.toMatch(/[\uE000-\uE004]/)
    // An island's markup and its static slots, which hydration claims node by node, stay unmarked.
    expect(html).toContain('<button class="island-title">Launch day</button><div class="island-slot"><!--kay-slot:0--><em class="slotted">Launch day</em><!--/kay-slot--></div></slot>')
    expect((await get('/news', edit)).html).toContain('<li data-kay-field="news:roadmap:title">Next year</li>')

    const article = (await get('/articles/hello', edit)).html

    expect(article).toContain('<h1 data-kay-field="articles:hello@fr:title">Bonjour</h1>')
    expect(article).toContain('<article data-kay-body="articles:hello@fr">')

    const plain = (await get('/marks/launch', preview)).html

    expect(plain).not.toContain('kay-field')
    expect(plain).not.toContain('kay-body')
    expect(plain).toBe((await get('/marks/launch')).html)
  })

  it('renders the extension\'s editor last in edit mode alone, kept alive across pages, given each entry the page read', async () => {
    const edit = await previewCookie(previewUrl('/news', { edit: true }))
    const preview = await previewCookie(previewUrl('/news'))
    const editor = `${FIXTURE}/src/components/draft-editor.kay`
    const slot = new RegExp(`<slot data-component="${editor}" data-props='[^']+' data-persist="${editor}"(?: data-chunk="[^"]+")?><button class="count">[\\s\\S]*<ul class="edited">(.*)</ul></slot></body></html>$`)
    const edited = async (path: string) => slot.exec((await get(path, edit)).html)?.[1]?.replaceAll(HYDRATION_MARK, '')

    expect(await edited('/marks/launch')).toBe('<li>news:launch</li>')
    expect(await edited('/news')).toBe('<li>news:launch</li><li>news:roadmap</li>')
    expect(await edited('/articles/hello')).toBe('<li>articles:hello@fr</li>')
    expect((await get('/marks/launch', preview)).html).not.toContain('draft-editor')
    // The editor's own extension's screens render none, nor do what they fail with, the app's error pages included; an app page replacing one of its screens and another extension's page do.
    const shown = async (path: string, text: string) => {
      const { html } = await get(path, edit)

      expect(html).toContain(text)

      return html.includes('draft-editor')
    }

    expect(await shown('/admin', '<h1>Admin</h1>')).toBe(false)
    expect(await shown('/admin/screens/broken', 'Screen failed')).toBe(false)
    expect(await shown('/admin/broken', 'Admin failed')).toBe(false)
    expect(await shown('/admin/locked', 'Admin failed')).toBe(false)
    // A URL no page serves is answered outside preview mode, under the prefix or not.
    expect(await shown('/admin/nope', 'Nothing here')).toBe(false)
    expect(await shown('/nope', 'Nothing here')).toBe(false)
    expect(await shown('/admin/settings', '<h1>Settings</h1>')).toBe(true)
    expect((await get('/admin/settings', edit)).html).not.toContain('extension')
    expect(await shown('/blog', '<h1>Blog</h1>')).toBe(true)
    // Its stylesheet comes with it, after the page's.
    const sheets = (html: string) => [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(link => link[1]!)
    const linked = sheets((await get('/marks/launch', edit)).html)

    expect(linked).toEqual([...sheets((await get('/marks/launch', preview)).html), expect.any(String)])
    expect(await (await app.handle(new Request(`http://localhost${linked.at(-1)!}`))).text()).toContain('dashed teal')
    expect(() => extensionEditor('.', [EDITOR, { name: 'other', editor: 'other.kay' }])).toThrow('kay: the extensions editor and other each give an editor')
    expect(await rejection(readClientSources(FIXTURE, { extensions: [{ name: 'static', editor: 'src/components/headline.kay' }] }))).toMatchObject({ message: expect.stringContaining('runs nothing in the browser') })
  })

  it('marks a number once, a body around what it holds, and nothing written into a tag some other way or rendered by an island', () => {
    inPreview(() => {
      const marks = editMarks()!
      const entry = editableEntry(marks, 'news', { slug: 'a', data: { title: 'T', count: 3, at: new Date(0) }, Content: () => renderedHtml('<p>x</p>') })
      const html = withFieldMarks(marks, () => `<div>${child(entry.data.title)}</div><div>${child(entry.data.count)} ${child(3)}</div><a title="${child(entry.data.title)}">${withFieldMarks(undefined, () => child(entry.data.title))}</a><section>${child(entry.Content())}</section>`)

      expect(entry.data.at).toBeInstanceOf(Date)
      expect(placeFieldMarks(html, marks)).toBe('<div data-kay-field="news:a:title">T</div><div><!--kay-field news:a:count-->3<!--/kay-field--> 3</div><a title="T">T</a><section data-kay-body="news:a"><p>x</p></section>')
    }, true)
  })

  it('marks a number only rendered right after its field is read, nothing else read or rendered between', () => {
    inPreview(() => {
      const marks = editMarks()!
      const entry = editableEntry(marks, 'news', { slug: 'a', data: { rating: 3, order: 1, label: 'L', tags: ['a', 'b', 'c'] }, Content: () => renderedHtml('') })
      const html = withFieldMarks(marks, () => {
        const shown = entry.data.rating >= 3 ? child(entry.data.tags.length) : ''
        const order = entry.data.order

        return `<p>${shown}</p><p>${child(order === 1 ? 'first' : 'later')}${child(1)}</p><p>${order === 1 ? child(entry.data.label) : ''}${child(1)}</p>`
      })

      expect(placeFieldMarks(html, marks)).toBe('<p>3</p><p>first1</p><p><!--kay-field news:a:label-->L<!--/kay-field-->1</p>')
    }, true)
  })

  it('marks a text rendered after the field read it, never a blank one, one already rendered, or a field\'s own private-use characters', () => {
    inPreview(() => {
      const marks = editMarks()!
      const entry = editableEntry(marks, 'news', { slug: 'a', data: { title: 'Same', subtitle: 'Same', note: '', icon: '\uE002\uE000f0\uE001' }, Content: () => renderedHtml('') })
      const html = withFieldMarks(marks, () => {
        const { note, title, subtitle, icon } = entry.data

        return `<p>${note === '' ? child('') : ''}x</p><h1>${child(title)}</h1><h2>${child(subtitle)}</h2><p>${child('Same')}</p><i>${child(icon)}</i>`
      })

      expect(placeFieldMarks(html, marks)).toBe('<p>x</p><h1 data-kay-field="news:a:title">Same</h1><h2 data-kay-field="news:a:subtitle">Same</h2><p>Same</p><i data-kay-field="news:a:icon">\uE002\uE000f0\uE001</i>')
    }, true)
  })

  it('marks a text once per render of its field, however often it was read', () => {
    inPreview(() => {
      const marks = editMarks()!
      const entry = editableEntry(marks, 'news', { slug: 'a', data: { title: 'Same' }, Content: () => renderedHtml('') })
      const html = withFieldMarks(marks, () => {
        const read = [entry.data.title, entry.data.title]

        return `<h1>${child(read[0]!)}</h1><p>${child('Same')}</p>`
      })

      expect(placeFieldMarks(html, marks)).toBe('<h1 data-kay-field="news:a:title">Same</h1><p>Same</p>')
    }, true)
  })

  it('places the marks of a long listing in one pass', () => {
    // The work placing the marks of `count` rows does, as the characters it copies out of the page and the regex scans it starts: a pass or a copy of the page per fence would multiply it by the rows.
    const placed = (count: number) => {
      let marked = ''
      let work = 0

      inPreview(() => {
        const marks = editMarks()!
        const entry = editableEntry(marks, 'news', { slug: 'a', data: { rows: Array.from({ length: count }, (_, index) => `Row ${index}`) }, Content: () => renderedHtml('') })
        const html = withFieldMarks(marks, () => `<title>Rows</title><ul>${loop(entry.data.rows, row => `<li>Row: ${child(row)}</li>`)}</ul>`)
        // eslint-disable-next-line ts/unbound-method -- called back on its string below
        const slice = String.prototype.slice
        // eslint-disable-next-line ts/unbound-method -- called back on its pattern below
        const exec = RegExp.prototype.exec
        const slices = spyOn(String.prototype, 'slice').mockImplementation(function (this: string, ...args: [number?, number?]) {
          const piece = slice.apply(this, args)

          work += piece.length

          return piece
        })
        const scans = spyOn(RegExp.prototype, 'exec').mockImplementation(function (this: RegExp, text: string) {
          work += 1

          return exec.call(this, text)
        })

        try {
          marked = placeFieldMarks(html, marks)
        }
        finally {
          slices.mockRestore()
          scans.mockRestore()
        }
      }, true)

      return { marked, work }
    }
    const small = placed(1000)
    const large = placed(3000)

    // Three times the rows, about three times the work, where a pass per fence would make it nine.
    expect(large.work).toBeLessThan(small.work * 4)
    expect(large.marked).toStartWith('<title>Rows</title><ul data-kay-list="news:a:rows"><li>Row: <!--kay-field news:a:rows.0-->Row 0<!--/kay-field--></li>')
    expect(large.marked).toEndWith('<li>Row: <!--kay-field news:a:rows.2999-->Row 2999<!--/kay-field--></li></ul>')
  })

  it('decodes the drafted entries alone, leaving those every other request shares as they are', async () => {
    const shared = await articles.get('hello', 'fr')
    const decoded = spyOn(validate, 'decodeEntries')

    try {
      const drafts = new Map([[articles.name, [{ slug: 'hello', locale: 'de', data: { title: 'Hallo' } }]]])
      const drafted = await inPreview(async () => Promise.all([articles.get('hello', 'fr'), articles.get('hello', 'de')]), true, drafts)

      expect(drafted.map(entry => [entry?.data.title, entry?.translations])).toEqual([['Bonjour', ['de', 'en', 'fr']], ['Hallo', ['de', 'en', 'fr']]])
      expect(decoded.mock.calls.map(([raw]) => raw.map(entry => entry.slug))).toEqual([['de/hello']])
    }
    finally {
      decoded.mockRestore()
    }

    expect((await articles.get('hello', 'fr'))?.translations).toEqual(shared?.translations)
    expect(shared?.translations).toEqual(['en', 'fr'])
  })

  it('renders a page with the entries an editor has not saved, for a visitor in edit mode alone, refusing a draft its schema refuses', async () => {
    const edit = await previewCookie(previewUrl('/news', { edit: true }))
    const preview = await previewCookie(previewUrl('/news'))
    const post = async (body: unknown, cookie = edit, headers: Record<string, string> = {}) => app.handle(new Request('http://localhost/_kay/draft', { method: 'POST', headers: { cookie, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }))
    const draft = { path: '/marks/launch', entries: [{ collection: 'news', slug: 'launch', data: { title: 'Draft title', published: true, tags: ['draft'] }, body: '## Drafted' }] }
    const drafted = await post(draft)
    const html = await drafted.text()

    expect(drafted.status).toBe(200)
    expect(drafted.headers.get('cache-control')).toBe('private, no-store')
    expect(html).toContain('<h1 data-kay-field="news:launch:title">Draft title</h1>')
    expect(html).toContain('<li data-kay-field="news:launch:tags.0">draft</li>')
    expect(html).toContain('<article data-kay-body="news:launch"><h2 id="drafted">')
    expect((await get('/marks/launch', edit)).html).toContain('>Launch day</h1>')
    expect(await (await post({ path: '/marks/later', entries: [{ collection: 'news', slug: 'later', data: { title: 'Later on', published: false, tags: [] } }] })).text()).toContain('>Later on</h1>')

    const refused = await post({ path: '/marks/launch', entries: [{ collection: 'news', slug: 'launch', data: { title: 3, published: true, tags: [1] } }, { collection: 'articles', slug: 'hello', locale: 'fr', data: {} }, { collection: 'posts', slug: 'first', data: {} }] })

    expect(refused.status).toBe(422)
    expect(await refused.json()).toEqual({ issues: [
      { collection: 'news', slug: 'launch', path: 'title', message: expect.any(String) },
      { collection: 'news', slug: 'launch', path: 'tags.0', message: expect.any(String) },
      { collection: 'articles', slug: 'hello', locale: 'fr', path: 'title', message: expect.any(String) },
      { collection: 'posts', slug: 'first', path: '', message: 'names no collection the content config exports' },
    ] })
    // A draft's data is an object of fields, as a save's is.
    const listed = await post({ path: '/marks/launch', entries: [{ collection: 'news', slug: 'launch', data: ['Draft title'] }] })

    expect(listed.status).toBe(422)
    expect(await listed.json()).toEqual({ issues: [{ collection: 'news', slug: 'launch', path: '', message: 'holds a list as its data, not an object of fields' }] })
    expect((await post(draft, preview)).status).toBe(403)
    expect((await post(draft, edit, { origin: 'https://evil.example' })).status).toBe(403)
    expect((await post(draft, edit, { 'sec-fetch-site': 'same-site' })).status).toBe(403)
    expect((await post(draft, edit, { 'sec-fetch-site': 'same-origin' })).status).toBe(200)
    expect((await post({ path: '//evil.example', entries: [] })).status).toBe(400)
    expect((await post({ ...draft, entries: [{ ...draft.entries[0]!, body: 'x'.repeat(1024 * 1024) }] })).status).toBe(413)
  })

  it('refuses a draft body using a component its collection does not name, and a locale a localized collection alone has', async () => {
    const edit = await previewCookie(previewUrl('/news', { edit: true }))
    const post = async (entries: unknown[], path = '/marks/launch') => app.handle(new Request('http://localhost/_kay/draft', { method: 'POST', headers: { 'cookie': edit, 'content-type': 'application/json' }, body: JSON.stringify({ path, entries }) }))
    const refused = await post([
      { collection: 'news', slug: 'launch', data: { title: 'T', published: true, tags: [] }, body: 'Hi\n\n<Nope />' },
      { collection: 'news', slug: 'roadmap', data: { title: 'T', published: true, tags: [] }, body: '<Callout>\nx' },
      { collection: 'news', slug: 'launch', locale: 'fr', data: { title: 'T', published: true, tags: [] } },
      { collection: 'articles', slug: 'hello', data: { title: 'T' } },
      { collection: 'pages', slug: 'guide/index', data: { title: 'T', order: 1 } },
    ])

    expect(refused.status).toBe(422)
    expect(await refused.json()).toEqual({ issues: [
      { collection: 'news', slug: 'launch', path: '', body: true, message: 'uses <Nope> on line 3, which the collection\'s components do not name' },
      { collection: 'news', slug: 'roadmap', path: '', body: true, message: '<Callout> is never closed: end it with </Callout>, or write <Callout /> on line 1' },
      { collection: 'news', slug: 'launch', locale: 'fr', path: '', key: 'locale', message: 'names a locale, which the collection is not localized by' },
      { collection: 'articles', slug: 'hello', path: '', key: 'locale', message: 'names no locale, which each entry of a localized collection has' },
      { collection: 'pages', slug: 'guide/index', path: '', key: 'slug', message: 'has a slug whose file, guide/index, reads back as guide: write the entry as guide' },
    ] })

    const created = await post([{ collection: 'articles', slug: 'nouveau', locale: 'fr', data: { title: 'Nouveau' }, body: 'Tout neuf.' }], '/articles/nouveau')

    expect(created.status).toBe(200)
    expect(await created.text()).toContain('<h1 data-kay-field="articles:nouveau@fr:title">Nouveau</h1>')
    expect((await get('/articles/nouveau', edit)).status).toBe(404)
  })

  it('forgets the drafts once their page is rendered, so the id naming them shows nothing again', async () => {
    const edit = await previewCookie(previewUrl('/news', { edit: true }))
    const id = '00000000-0000-4000-8000-000000000000'
    const uuid = spyOn(crypto, 'randomUUID').mockReturnValue(id)

    try {
      const drafted = await app.handle(new Request('http://localhost/_kay/draft', { method: 'POST', headers: { 'cookie': edit, 'content-type': 'application/json' }, body: JSON.stringify({ path: '/marks/launch', entries: [{ collection: 'news', slug: 'launch', data: { title: 'Draft title', published: true, tags: [] } }] }) }))

      expect(await drafted.text()).toContain('>Draft title</h1>')
    }
    finally {
      uuid.mockRestore()
    }

    const replayed = await app.handle(new Request('http://localhost/marks/launch', { headers: { 'cookie': edit, 'x-kay-draft': id } }))

    expect(requestDrafts(new Request('http://localhost/marks/launch', { headers: { 'x-kay-draft': id } }))).toBeUndefined()
    expect(await replayed.text()).toContain('>Launch day</h1>')
  })

  it('shows drafts to that visitor alone, from a fresh load no cache keeps, until the cookie runs out or they leave', async () => {
    const cookie = await previewCookie(previewUrl('/news'))

    await get('/news')
    cms.loads = []

    const previewed = await get('/news', cookie)

    expect(previewed.html).toContain('<li>Next year</li>')
    expect(previewed.headers.get('cache-control')).toBe('private, no-store')
    expect((await get('/news/roadmap', cookie)).status).toBe(200)
    // The list and the entry each load once, and only the preview asks for drafts.
    expect(cms.loads).toEqual([true, true])
    expect((await get('/news')).html).not.toContain('Next year')
    expect((await get('/news', 'kay_preview=99999999999.forged')).html).not.toContain('Next year')

    const left = await app.handle(new Request('http://localhost/_kay/preview?exit&path=/news'))

    expect(left.headers.get('set-cookie')).toMatch(/^kay_preview=; Path=\/; Expires=/)

    setSystemTime(new Date(Date.now() + 2 * 60 * 60_000))
    expect((await get('/news', cookie)).html).not.toContain('Next year')
  })

  it('reads past cached() for a visitor in preview mode, keeping nothing', async () => {
    let loads = 0
    const load = () => ++loads

    expect(await cached('preview-bypass', 60, load)).toBe(1)
    expect(await inPreview(async () => cached('preview-bypass', 60, load))).toBe(2)
    expect(await inPreview(async () => cached('preview-bypass', 60, load))).toBe(3)
    expect(await cached('preview-bypass', 60, load)).toBe(1)
  })

  it('renders a prerendered page afresh for a visitor in preview mode, the copy served to everyone else', async () => {
    const build = await scratchBuild()

    try {
      // The page visited below, and four that read nothing from a request.
      expect(await build.prerender(options)).toBe(5)

      const served = await build.serve(options)
      const visit = async (cookie?: string) => {
        const response = await served.handle(new Request('http://localhost/news/launch', { headers: cookie === undefined ? {} : { cookie } }))

        return { html: await response.text(), etag: response.headers.get('etag'), cache: response.headers.get('cache-control') }
      }
      const cookie = await previewCookie(previewUrl('/news'))

      cms.entries[0]!.title = 'Launch moved'

      expect(await visit()).toMatchObject({ html: expect.stringContaining('<h1>Launch day</h1>'), etag: expect.any(String), cache: 'public, max-age=0, must-revalidate' })
      expect(await visit(cookie)).toMatchObject({ html: expect.stringContaining('<h1>Launch moved</h1>'), etag: null, cache: 'private, no-store' })
      expect((await visit()).html).toContain('<h1>Launch day</h1>')

      expect((await served.handle(new Request('http://localhost/api/hook', { method: 'POST' }))).status).toBe(204)
      expect((await visit()).html).toContain('<h1>Launch moved</h1>')
    }
    finally {
      await build.remove()
    }
  })

  // Three builds of the fixture in a row, each several seconds on a loaded host.
  it('needs a long secret, and refuses its helpers without one', async () => {
    await expect(pages({ routes: options.routes, prebuilt: false, preview: { secret: 'short' } })).rejects.toThrow('kay: preview.secret in kay.config.ts is 5 characters long')
    await pages({ routes: options.routes, prebuilt: false })

    try {
      expect(() => previewUrl('/news')).toThrow('kay: previewUrl() needs preview in kay.config.ts')
      expect(() => enterPreview({ cookies: new Bun.CookieMap(), request: new Request('http://localhost/') })).toThrow('kay: enterPreview() needs preview in kay.config.ts')
      expect((await app.handle(new Request('http://localhost/news', { headers: { cookie: 'kay_preview=1.x' } }))).status).toBe(200)
    }
    finally {
      await pages({ ...options, prebuilt: false })
    }
  }, 60_000)
})

describe('showDraft', () => {
  const globals = globalThis as unknown as Record<string, unknown>

  // Answers the draft with `status`, a navigation starting while it is in flight when `overtaken`.
  async function drafted(status: number, overtaken: boolean): Promise<unknown> {
    const current = navigation.current
    const fetched = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      if (overtaken)
        navigation.current++

      return new Response(status === 422 ? JSON.stringify({ issues: [{ collection: 'news', slug: 'launch', path: 'title', message: 'Expected string' }] }) : 'Broken', { status })
    }) as unknown as typeof fetch)

    globals.document = { activeElement: null, querySelector: () => null }
    globals.location = new URL('http://localhost/marks/launch')

    try {
      return await showDraft([{ collection: 'news', slug: 'launch', data: { title: 3 } }])
    }
    catch (error) {
      return error
    }
    finally {
      fetched.mockRestore()
      navigation.current = current
      delete globals.document
      delete globals.location
    }
  }

  it('resolves where the draft fails, or throws when refused, unless a navigation overtook it', async () => {
    expect(await drafted(422, false)).toEqual({ issues: [{ collection: 'news', slug: 'launch', path: 'title', message: 'Expected string' }] })
    expect(await drafted(500, false)).toMatchObject({ message: 'kay: showDraft was answered 500: Broken' })
    expect(await drafted(422, true)).toEqual({})
    expect(await drafted(500, true)).toEqual({})
  })
})
