import type { ServedRoute } from '../src/server/guards'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, setSystemTime, spyOn } from 'bun:test'
import { t } from 'elysia'
import { outputDir } from '../src/build/assets'
import { collection, collections, entries, entrySource, removeEntry, saveEntry } from '../src/content'
import { ContentError } from '../src/content/validate'
import { resolveProject } from '../src/project'
import { cached } from '../src/runtime/cache'
import { editableEntry, editMarks, placeFieldMarks, withFieldMarks } from '../src/runtime/fields'
import { child, loop } from '../src/runtime/html'
import { editing, previewing } from '../src/runtime/preview'
import { editRequested, enterPreview, pages, previewUrl } from '../src/server'
import { readClient, readManifest, writeManifest } from '../src/server/client'
import { entryUrls } from '../src/server/entry-urls'
import { prerenderPages } from '../src/server/prerender'
import { inPreview, previewRequested, requestDrafts } from '../src/server/preview'
import { cms, resetCms } from './fixtures/cms/src/cms'
import { articles, news } from './fixtures/cms/src/content.config'

const FIXTURE = 'tests/fixtures/cms'
const SECRET = 'a-preview-secret-long-enough-for-kay-0123456789'
const options = { routes: `${FIXTURE}/src/routes`, content: `${FIXTURE}/src/content.config.ts`, api: `${FIXTURE}/src/api`, site: 'https://news.example', security: false as const, preview: { secret: SECRET } }
const app = await pages({ ...options, prebuilt: false })
const COOKIE = /^kay_preview=([^;]+);/

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
    const repoRoot = process.cwd()
    const articles = found.find(each => each.name === 'articles')!

    expect(found.map(each => each.name)).toEqual(['articles', 'news'])
    expect(found[1]).toEqual({ name: 'news', kind: 'loaded', schema: expect.objectContaining({ type: 'object', required: ['title', 'published', 'tags'] }), body: { kind: 'markdown' }, localized: false, repoRoot })
    expect(articles).toMatchObject({ kind: 'folder', body: { kind: 'markdown' }, localized: true, dir: 'tests/fixtures/cms/src/content/articles', draftField: 'hidden', repoRoot })
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
    expect(await rejection(entries('posts'))).toMatchObject({ message: 'kay: no collection is exported from the content config as posts; it exports articles, news' })
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
      { collection: 'articles', slug: '../escape', path: '', message: 'has a slug naming no file of the collection: its parts are neither empty, . nor ..' },
      { collection: 'articles', slug: '../escape', path: '', message: 'names no locale, which each entry of a localized collection has' },
      { collection: 'articles', slug: '../escape', path: 'title', message: expect.any(String) },
    ] })
    expect(await rejection(entrySource('news', 'launch', {}))).toMatchObject({ message: expect.stringContaining('saveEntry()') })
  })

  it('hands a loaded entry to its loader\'s save and remove, then reads the collection afresh', async () => {
    expect(await saveEntry('news', { slug: 'later', data: { title: 'Later on', published: true, tags: [] }, body: 'Soon.' })).toEqual({})
    expect((await news.get('later'))?.data.title).toBe('Later on')
    expect(await saveEntry('news', { slug: 'later', data: { title: 3 } })).toMatchObject({ issues: [{ collection: 'news', slug: 'later', path: 'published' }, { path: 'tags' }, { path: 'title' }] })
    expect(await removeEntry('news', 'later')).toEqual({})
    expect(await news.get('later')).toBeUndefined()
    expect(await rejection(saveEntry('articles', { slug: 'hello', locale: 'fr', data: { title: 'T' } }))).toMatchObject({ message: expect.stringContaining('entrySource()') })
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
      { collection: 'news', slug: 'launch', locale: 'fr', data: { title: 'T', published: true, tags: [] } },
      { collection: 'articles', slug: 'hello', data: { title: 'T' } },
    ])

    expect(refused.status).toBe(422)
    expect(await refused.json()).toEqual({ issues: [
      { collection: 'news', slug: 'launch', path: '', body: true, message: 'uses <Nope> on line 3, which the collection\'s components do not name' },
      { collection: 'news', slug: 'launch', locale: 'fr', path: '', message: 'names a locale, which the collection is not localized by' },
      { collection: 'articles', slug: 'hello', path: '', message: 'names no locale, which each entry of a localized collection has' },
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
