import type { Collection } from '../src/content'
import type { ServedRoute } from '../src/server/guards'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, setSystemTime, spyOn } from 'bun:test'
import { t } from 'elysia'
import { outputDir } from '../src/build/assets'
import { readClientSources } from '../src/build/client'
import { collection, collections, entries, entrySource, removeEntry, saveEntry } from '../src/content'
import { entryIssues, registerCollections, registerEditSite } from '../src/content/edit'
import { contentPlace, parseEntry, setContentPlace } from '../src/content/load'
import { MarkdownError } from '../src/content/markdown'
import { ContentError } from '../src/content/validate'
import { resolveProject } from '../src/project'
import { cached } from '../src/runtime/cache'
import { showDraft } from '../src/runtime/edit'
import { editableEntry, editMarks, placeFieldMarks, withFieldMarks } from '../src/runtime/fields'
import { child, loop } from '../src/runtime/html'
import { navigation } from '../src/runtime/navigation'
import { editing, previewing } from '../src/runtime/preview'
import { editRequested, enterPreview, pages, previewUrl } from '../src/server'
import { readClient, readManifest, writeManifest } from '../src/server/client'
import { entryUrls } from '../src/server/entry-urls'
import { prerenderPages } from '../src/server/prerender'
import { inPreview, previewRequested, requestDrafts } from '../src/server/preview'
import { extensionEditor } from '../src/server/routes'
import { cms, resetCms } from './fixtures/cms/src/cms'
import { articles, news, pages as pagesCollection } from './fixtures/cms/src/content.config'
import { scratchDir } from './scratch'

const FIXTURE = 'tests/fixtures/cms'
const SECRET = 'a-preview-secret-long-enough-for-kay-0123456789'
const EDITOR = { name: 'editor', editor: `${FIXTURE}/src/components/draft-editor.kay` }
const options = { routes: `${FIXTURE}/src/routes`, content: `${FIXTURE}/src/content.config.ts`, api: `${FIXTURE}/src/api`, site: 'https://news.example', security: false as const, preview: { secret: SECRET }, extensions: [EDITOR] }
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
    expect(first).toMatchObject({ slug: 'a', data: { title: 'First' }, headings: [], file: 'notes-compiled/a' })
    expect(String((first!.Content as () => { t: string })().t)).toBe('<p>From the CMS</p>')
    expect(second!.headings).toEqual([{ depth: 1, id: 'intro', text: 'Intro' }])
    expect((second!.Content as () => { t: string })().t).toContain('<strong>bold</strong>')
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
    expect(found[1]).toEqual({ name: 'news', kind: 'loaded', schema: expect.objectContaining({ type: 'object', required: ['title', 'published', 'tags'] }), body: { kind: 'markdown' }, components: [], localized: false })
    expect(found[2]).toEqual({ name: 'notes', kind: 'loaded', schema: expect.objectContaining({ type: 'object' }), components: [], localized: true })
    expect(articles).toMatchObject({ kind: 'folder', body: { kind: 'markdown' }, components: [], localized: true, dir: 'tests/fixtures/cms/src/content/articles', draftField: 'hidden' })
    expect(articles).not.toHaveProperty('repoRoot')
    expect(articles.schema.properties).toMatchObject({ author: { 'type': 'string', 'x-kay': { kind: 'reference', collection: 'news' } }, cover: { 'type': 'string', 'x-kay': { kind: 'image' } } })
    expect(JSON.stringify(articles.schema)).not.toContain('"Date"')
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

    for (const entry of await entries('pages')) {
      const written = await entrySource('pages', entry.slug, entry.data, entry.body === undefined ? {} : { body: entry.body })

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

      expect((await entries('pages')).find(entry => entry.slug === 'broken')).toEqual({ slug: 'broken', path: expect.stringMatching(/content\/pages\/broken\.json$/), data: undefined, draft: false, problem: expect.stringContaining('content/pages/broken.json:1 the JSON does not parse') })
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
    const broken = collection({ name: 'broken', load: () => {
      throw new Error('the CMS is down')
    } }, { schema })
    const titled = collection({ name: 'titled', load: () => [{ slug: 'good', data: { title: 'Good' }, html: '' }, { slug: 'bad', data: { title: 3 }, html: '' }] }, { schema, url: entry => `/t/${entry.data.title.toLowerCase()}` })
    const failing = collection({ name: 'failing', load: () => [{ slug: 'one', data: { title: 'One' }, html: '' }] }, { schema, url: () => {
      throw new Error('no page')
    } })

    await exporting([['odd', odd], ['slugless', slugless], ['broken', broken], ['titled', titled], ['failing', failing]], async () => {
      expect(await rejection(entries('odd'))).toMatchObject({ message: 'kay: odd\'s load gave string, not an array of entries' })
      expect(await rejection(entries('slugless'))).toMatchObject({ message: 'kay: slugless\'s load gave an entry with no slug: {"data":{}}' })
      expect((await collections()).find(each => each.name === 'broken')).toMatchObject({ body: { kind: 'markdown' }, problem: 'kay: broken\'s load threw: the CMS is down' })
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
  it('lets in a CMS link carrying the secret, or a signed link, and refuses any other', async () => {
    const entered = await app.handle(new Request(`http://localhost/_kay/preview?path=${encodeURIComponent('/news/roadmap')}&secret=${SECRET}`))

    expect(entered.status).toBe(307)
    expect(entered.headers.get('location')).toBe('/news/roadmap')
    expect(entered.headers.get('cache-control')).toBe('no-store')
    expect(entered.headers.get('set-cookie')).toMatch(/^kay_preview=\d+\.[\w-]+; Path=\/; Max-Age=3600; HttpOnly; SameSite=Lax$/)

    const link = previewUrl('/news/roadmap')

    expect(link).toStartWith('/_kay/preview?path=%2Fnews%2Froadmap&until=')
    expect(await previewCookie(link)).toStartWith('kay_preview=')

    const refuse = async (path: string) => (await app.handle(new Request(`http://localhost${path}`))).status

    expect(await refuse(`/_kay/preview?path=/news&secret=${SECRET.slice(0, -1)}x`)).toBe(403)
    expect(await refuse('/_kay/preview?path=/news')).toBe(403)
    expect(await refuse(link.replace('roadmap', 'launch'))).toBe(403)
    expect(await refuse(`/_kay/preview?path=//evil.example&secret=${SECRET}`)).toBe(400)

    setSystemTime(new Date(Date.now() + 2 * 60 * 60_000))
    expect(await refuse(link)).toBe(403)
  })

  it('puts a visitor in edit mode through the secret, a signed link or a guard, signed apart from preview mode so neither turns into it', async () => {
    const mode = (cookie: string) => {
      const request = new Request('http://localhost/', { headers: { cookie } })

      expect(editRequested(request)).toBe(previewRequested(request) === 'edit')

      return previewRequested(request)
    }
    const bySecret = await previewCookie(`/_kay/preview?path=/news&edit&secret=${SECRET}`)
    const link = previewUrl('/news', { edit: true })
    const cookies = new Bun.CookieMap()

    enterPreview({ cookies, request: new Request('http://localhost/') }, { edit: true })

    expect(bySecret).toMatch(/^kay_preview=\d+\.edit\.[\w-]+$/)
    expect(mode(bySecret)).toBe('edit')
    expect(link).toContain('&edit=&sig=')
    expect(mode(await previewCookie(link))).toBe('edit')
    expect(mode(`kay_preview=${cookies.get('kay_preview')}`)).toBe('edit')
    expect(mode(await previewCookie(`/_kay/preview?path=/news&secret=${SECRET}`))).toBe('preview')

    const preview = await previewCookie(previewUrl('/news'))
    const [until, sig] = preview.slice('kay_preview='.length).split('.')

    expect(mode(`kay_preview=${until}.edit.${sig}`)).toBeUndefined()
    expect(mode(bySecret.replace('.edit.', '.'))).toBeUndefined()
    expect((await app.handle(new Request(`http://localhost${previewUrl('/news')}&edit`))).status).toBe(403)
    expect((await get('/news', bySecret)).headers.get('cache-control')).toBe('private, no-store')
    expect([previewing(), editing()]).toEqual([false, false])
    expect(inPreview(() => [previewing(), editing()], true)).toEqual([true, true])
    expect(inPreview(() => [previewing(), editing()])).toEqual([true, false])
  })

  it('marks in edit mode the markup each field and body renders, the same page byte for byte outside it', async () => {
    const edit = await previewCookie(`/_kay/preview?path=/news&edit&secret=${SECRET}`)
    const preview = await previewCookie(`/_kay/preview?path=/news&secret=${SECRET}`)
    const { html } = await get('/marks/launch', edit)

    expect(html).toContain('<h1 data-kay-field="news:launch:title">Launch day</h1>')
    expect(html).toContain('<h2 class="headline" data-kay-field="news:launch:title">Launch day</h2>')
    expect(html).toContain('<p>Posted as <!--kay-field news:launch:title-->Launch day<!--/kay-field--></p>')
    expect(html).toContain('<img src="/cover.png" alt="Launch day" data-kay-field-alt="news:launch:title">')
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
    const edit = await previewCookie(`/_kay/preview?path=/news&edit&secret=${SECRET}`)
    const preview = await previewCookie(`/_kay/preview?path=/news&secret=${SECRET}`)
    const editor = `${FIXTURE}/src/components/draft-editor.kay`
    const slot = new RegExp(`<slot data-component="${editor}" data-props="[^"]+" data-persist="${editor}"><button class="count">[\\s\\S]*<ul class="edited">(.*)</ul></slot></body></html>$`)
    const edited = async (path: string) => slot.exec((await get(path, edit)).html)?.[1]?.replaceAll(HYDRATION_MARK, '')

    expect(await edited('/marks/launch')).toBe('<li>news:launch</li>')
    expect(await edited('/news')).toBe('<li>news:launch</li><li>news:roadmap</li>')
    expect(await edited('/articles/hello')).toBe('<li>articles:hello@fr</li>')
    expect((await get('/marks/launch', preview)).html).not.toContain('draft-editor')
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
      const entry = editableEntry(marks, 'news', { slug: 'a', data: { title: 'T', count: 3, at: new Date(0) }, Content: () => ({ t: '<p>x</p>' }) })
      const html = withFieldMarks(marks, () => `<div>${child(entry.data.title)}</div><div>${child(entry.data.count)} ${child(3)}</div><a title="${child(entry.data.title)}">${withFieldMarks(undefined, () => child(entry.data.title))}</a><section>${child(entry.Content())}</section>`)

      expect(entry.data.at).toBeInstanceOf(Date)
      expect(placeFieldMarks(html, marks)).toBe('<div data-kay-field="news:a:title">T</div><div><!--kay-field news:a:count-->3<!--/kay-field--> 3</div><a title="T">T</a><section data-kay-body="news:a"><p>x</p></section>')
    }, true)
  })

  it('marks a number only rendered right after its field is read, nothing else read or rendered between', () => {
    inPreview(() => {
      const marks = editMarks()!
      const entry = editableEntry(marks, 'news', { slug: 'a', data: { rating: 3, order: 1, label: 'L', tags: ['a', 'b', 'c'] }, Content: () => ({ t: '' }) })
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
      const entry = editableEntry(marks, 'news', { slug: 'a', data: { title: 'Same', subtitle: 'Same', note: '', icon: '\uE002\uE000f0\uE001' }, Content: () => ({ t: '' }) })
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
      const entry = editableEntry(marks, 'news', { slug: 'a', data: { title: 'Same' }, Content: () => ({ t: '' }) })
      const html = withFieldMarks(marks, () => {
        const read = [entry.data.title, entry.data.title]

        return `<h1>${child(read[0]!)}</h1><p>${child('Same')}</p>`
      })

      expect(placeFieldMarks(html, marks)).toBe('<h1 data-kay-field="news:a:title">Same</h1><p>Same</p>')
    }, true)
  })

  it('places the marks of a long listing in one pass', () => {
    inPreview(() => {
      const marks = editMarks()!
      const entry = editableEntry(marks, 'news', { slug: 'a', data: { rows: Array.from({ length: 3000 }, (_, index) => `Row ${index}`) }, Content: () => ({ t: '' }) })
      const html = withFieldMarks(marks, () => `<title>Rows</title><ul>${loop(entry.data.rows, row => `<li>Row: ${child(row)}</li>`)}</ul>`)
      const started = performance.now()
      const marked = placeFieldMarks(html, marks)

      expect(performance.now() - started).toBeLessThan(200)
      expect(marked).toStartWith('<title>Rows</title><ul data-kay-list="news:a:rows"><li>Row: <!--kay-field news:a:rows.0-->Row 0<!--/kay-field--></li>')
      expect(marked).toEndWith('<li>Row: <!--kay-field news:a:rows.2999-->Row 2999<!--/kay-field--></li></ul>')
    }, true)
  })

  it('renders a page with the entries an editor has not saved, for a visitor in edit mode alone, refusing a draft its schema refuses', async () => {
    const edit = await previewCookie(`/_kay/preview?path=/news&edit&secret=${SECRET}`)
    const preview = await previewCookie(`/_kay/preview?path=/news&secret=${SECRET}`)
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
    expect((await post(draft, preview)).status).toBe(403)
    expect((await post(draft, edit, { origin: 'https://evil.example' })).status).toBe(403)
    expect((await post(draft, edit, { 'sec-fetch-site': 'same-site' })).status).toBe(403)
    expect((await post(draft, edit, { 'sec-fetch-site': 'same-origin' })).status).toBe(200)
    expect((await post({ path: '//evil.example', entries: [] })).status).toBe(400)
    expect((await post({ ...draft, entries: [{ ...draft.entries[0]!, body: 'x'.repeat(1024 * 1024) }] })).status).toBe(413)
  })

  it('refuses a draft body using a component its collection does not name, and a locale a localized collection alone has', async () => {
    const edit = await previewCookie(`/_kay/preview?path=/news&edit&secret=${SECRET}`)
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
    const edit = await previewCookie(`/_kay/preview?path=/news&edit&secret=${SECRET}`)
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
    const cookie = await previewCookie(`/_kay/preview?path=/news&secret=${SECRET}`)

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
    const root = process.cwd()
    const manifest = (await readManifest(root))!

    try {
      expect(await prerenderPages(resolveProject(root, options), (await readClient(root))!)).toBe(1)

      const served = await pages({ ...options, prebuilt: true })
      const visit = async (cookie?: string) => {
        const response = await served.handle(new Request('http://localhost/news/launch', { headers: cookie === undefined ? {} : { cookie } }))

        return { html: await response.text(), etag: response.headers.get('etag'), cache: response.headers.get('cache-control') }
      }
      const cookie = await previewCookie(`/_kay/preview?path=/news&secret=${SECRET}`)

      cms.entries[0]!.title = 'Launch moved'

      expect(await visit()).toMatchObject({ html: expect.stringContaining('<h1>Launch day</h1>'), etag: expect.any(String), cache: 'public, max-age=0, must-revalidate' })
      expect(await visit(cookie)).toMatchObject({ html: expect.stringContaining('<h1>Launch moved</h1>'), etag: null, cache: 'private, no-store' })
      expect((await visit()).html).toContain('<h1>Launch day</h1>')

      expect((await served.handle(new Request('http://localhost/api/hook', { method: 'POST' }))).status).toBe(204)
      expect((await visit()).html).toContain('<h1>Launch moved</h1>')
    }
    finally {
      await rm(join(outputDir(root), 'pages/news'), { recursive: true, force: true })
      await writeManifest(root, manifest)
    }
  })

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
  })
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
