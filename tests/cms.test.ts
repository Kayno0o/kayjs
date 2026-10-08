import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, setSystemTime } from 'bun:test'
import { t } from 'elysia'
import { collection } from '../src/content'
import { ContentError } from '../src/content/validate'
import { cached } from '../src/runtime/cache'
import { enterPreview, pages, previewUrl } from '../src/server'
import { readClient, readManifest, writeManifest } from '../src/server/client'
import { prerenderPages } from '../src/server/prerender'
import { inPreview } from '../src/server/preview'
import { cms, resetCms } from './fixtures/cms/src/cms'
import { news } from './fixtures/cms/src/content.config'

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
      expect(await prerenderPages(root, options, (await readClient(root))!)).toBe(1)

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
      await rm(join(root, '.kay/client/pages/news'), { recursive: true, force: true })
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
