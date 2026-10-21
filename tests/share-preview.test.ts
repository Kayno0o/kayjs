import { afterEach, describe, expect, it, setSystemTime } from 'bun:test'
import { t } from 'elysia'
import { collection } from '../src/content'
import { cached } from '../src/runtime/cache'
import { pages, previewUrl } from '../src/server'
import { inSharedDraft } from '../src/server/preview'
import { cms, resetCms } from './fixtures/cms/src/cms'
import { news } from './fixtures/cms/src/content.config'

const FIXTURE = 'tests/fixtures/cms'
const SECRET = 'a-preview-secret-long-enough-for-kay-0123456789'
const options = { routes: `${FIXTURE}/src/routes`, content: `${FIXTURE}/src/content.config.ts`, api: `${FIXTURE}/src/api`, site: 'https://news.example', inlineStyles: false, security: false as const, preview: { secret: SECRET } }
const roadmap = { collection: 'news', slug: 'roadmap' }

afterEach(() => {
  resetCms()
  news.invalidate()
  setSystemTime()
})

// The app built last owns the preview settings, so each describe builds its own.
async function visit(app: Awaited<ReturnType<typeof pages>>, path: string, headers: Record<string, string> = {}): Promise<{ status: number, html: string, headers: Headers }> {
  const response = await app.handle(new Request(`http://localhost${path}`, { headers }))

  return { status: response.status, html: await response.text(), headers: response.headers }
}

describe('an entry-scoped preview link', () => {
  it('shows the entry\'s draft on its own page, and puts the visitor in no mode', async () => {
    const app = await pages({ ...options, prebuilt: false })
    const link = previewUrl('/news/roadmap', { entry: roadmap })

    expect(link).toStartWith('/news/roadmap?kay_preview=')
    expect((await visit(app, '/news/roadmap')).status).toBe(404)

    const shared = await visit(app, link)

    expect(shared.status).toBe(200)
    expect(shared.html).toContain('<h1>Next year</h1>')
    expect(shared.headers.get('set-cookie')).toBeNull()
    expect(shared.headers.get('cache-control')).toBe('private, no-store')
    expect(shared.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    expect(shared.headers.get('referrer-policy')).toBe('no-referrer')
    // Nothing of it stays for the next visitor.
    expect((await visit(app, '/news/roadmap')).status).toBe(404)
    expect((await visit(app, '/news')).html).not.toContain('Next year')
    // A published page is the one everyone gets, with no mark of edit mode.
    expect((await visit(app, `/marks/launch?${link.slice(link.indexOf('?') + 1)}`)).html).toBe((await visit(app, '/marks/launch')).html)
  })

  it('keeps the query a path already has', () => {
    expect(previewUrl('/news/roadmap?a=1#top', { entry: roadmap })).toMatch(/^\/news\/roadmap\?a=1&kay_preview=[\w.-]+#top$/)
  })

  it('shows no other entry\'s draft, on any page', async () => {
    const app = await pages({ ...options, prebuilt: false })

    cms.entries.push({ slug: 'secret', title: 'Secret plan', published: false, body: 'Hidden.' })
    news.invalidate()

    const link = previewUrl('/news/roadmap', { entry: roadmap })
    const token = link.slice(link.indexOf('?') + 1)

    expect((await visit(app, `/news/secret?${token}`)).status).toBe(404)

    const list = (await visit(app, `/news?${token}`)).html

    // The link is for the entry's own page.
    expect(list).not.toContain('Next year')
    expect(list).not.toContain('Secret plan')
  })

  it('is refused when it expired, was changed, or names no entry', async () => {
    const app = await pages({ ...options, prebuilt: false })
    const link = previewUrl('/news/roadmap', { entry: roadmap })
    const [until, entry, sig] = new URL(link, 'http://localhost').searchParams.get('kay_preview')!.split('.') as [string, string, string]
    const other = Buffer.from(JSON.stringify(['news', 'secret', ''])).toString('base64url')
    const refused = async (token: string) => (await visit(app, `/news/roadmap?kay_preview=${token}`)).status

    expect(await refused(`${until}.${entry}.${sig}`)).toBe(200)
    expect(await refused(`${until}.${other}.${sig}`)).toBe(404)
    expect(await refused(`${Number(until) + 3600}.${entry}.${sig}`)).toBe(404)
    expect(await refused(`${until}.${entry}.${sig.slice(0, -2)}xx`)).toBe(404)
    expect(await refused(`${until}.${entry}`)).toBe(404)
    expect(await refused(`${until}.${entry}.${sig}.more`)).toBe(404)
    expect(await refused('garbage')).toBe(404)
    expect(await refused('')).toBe(404)
    // A preview link's signature does not sign a scoped one.
    expect(await refused(`${until}.${entry}.${new URL(previewUrl('/news/roadmap'), 'http://localhost').searchParams.get('sig')}`)).toBe(404)

    setSystemTime(new Date(Date.now() + 8 * 24 * 3600_000))
    expect(await refused(`${until}.${entry}.${sig}`)).toBe(404)
  })

  it('follows no rename: the link names the slug it was made for', async () => {
    const app = await pages({ ...options, prebuilt: false })
    const link = previewUrl('/news/roadmap', { entry: roadmap })

    cms.entries = cms.entries.map(entry => entry.slug === 'roadmap' ? { ...entry, slug: 'plan' } : entry)
    news.invalidate()
    expect((await visit(app, link)).status).toBe(404)
    expect((await visit(app, link.replace('/news/roadmap', '/news/plan'))).status).toBe(404)
  })

  it('names the collection by its export name and the locale of a localized entry, a folder collection\'s draft included', async () => {
    const app = await pages({ ...options, prebuilt: false })
    const hello = (locale: string) => previewUrl('/articles-en/hello', { entry: { collection: 'articles', slug: 'hello', locale } })

    expect((await visit(app, '/articles-en/hello')).status).toBe(404)
    expect((await visit(app, hello('en'))).html).toContain('<h1>Hello</h1>')
    expect((await visit(app, hello('fr'))).status).toBe(404)
    expect((await visit(app, previewUrl('/articles-en/hello', { entry: { collection: 'articles', slug: 'hello' } }))).status).toBe(404)
    expect((await visit(app, previewUrl('/articles-en/hello', { entry: { collection: 'content/articles', slug: 'hello', locale: 'en' } }))).status).toBe(404)
  })

  it('reads a loader\'s preview data for the shared entry alone', async () => {
    await pages({ ...options, prebuilt: false })

    const loads: boolean[] = []
    const revisions = collection({
      name: 'revisions',
      load: ({ preview }) => {
        loads.push(preview)

        return preview ? [{ slug: 'a', data: { title: 'A, edited', draft: false } }, { slug: 'b', data: { title: 'B, edited', draft: false } }] : [{ slug: 'a', data: { title: 'A', draft: false } }, { slug: 'b', data: { title: 'B', draft: false } }]
      },
    }, { schema: t.Object({ title: t.String(), draft: t.Boolean() }), draft: 'draft' })
    const titles = async () => (await revisions.all()).map(entry => entry.data.title)

    expect(await titles()).toEqual(['A', 'B'])
    expect(await inSharedDraft(titles, { collection: 'revisions', slug: 'a' })).toEqual(['A, edited', 'B'])
    expect(await inSharedDraft(titles, { collection: 'other', slug: 'a' })).toEqual(['A', 'B'])
    expect(await titles()).toEqual(['A', 'B'])
  })

  it('goes through the site\'s base, which a proxy strips before the request reaches the app', async () => {
    const app = await pages({ ...options, base: '/blog', prebuilt: false })
    const link = previewUrl('/news/roadmap', { entry: roadmap })

    expect(link).toStartWith('/blog/news/roadmap?kay_preview=')
    expect((await visit(app, link.replace('/blog', ''))).html).toContain('<h1>Next year</h1>')
    expect((await visit(app, '/news/roadmap')).status).toBe(404)
  })

  it('renders past every cache, as a draft must not be kept for the next visitor', async () => {
    await pages({ ...options, prebuilt: false })

    let loads = 0
    const read = async () => cached('share-preview-key', '1h', () => ++loads)

    expect([await read(), await read()]).toEqual([1, 1])
    expect([await inSharedDraft(read, roadmap), await inSharedDraft(read, roadmap)]).toEqual([2, 3])
  })

  it('is not an edit link', () => {
    expect(() => previewUrl('/news/roadmap', { entry: roadmap, edit: true })).toThrow('does not open edit mode')
  })
})
