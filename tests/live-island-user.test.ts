import type { LiveRequest } from '../src/runtime/live-value'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { liveId } from '../src/build/live-ids'
import { ISLAND_HEADER } from '../src/runtime/server-islands'
import { nameUser } from '../src/server/request-user'
import { Feed, JSON_POST, pagesOf, proofsOf } from './live-helpers'
import { scratchBuild } from './prerendered'
import { pages } from './shared-pages'

const ROOT = 'tests/fixtures/live-island-user'
const UNREAD = liveId('/app/src/live.ts', '/app', 'unread')

type Values = typeof import('./fixtures/live-island-user/src/live')

// Names the visitor from a header as kayjs-auth does, and throws what the request's headers ask: the namer (`x-namer-fails`) or a hook before any page is chosen (`x-throw`).
function hooks({ request }: { request: Request }): void {
  nameUser(request, () => {
    if (request.headers.has('x-namer-fails'))
      throw new Error('the session store is down')

    return request.headers.get('x-user') ?? undefined
  })

  if (request.headers.has('x-throw'))
    throw new Error('a hook failed')
}

describe('a value of each user in a deferred island and on the error pages', () => {
  let build: Awaited<ReturnType<typeof scratchBuild>>
  let app: Elysia
  let live: Values

  const as = (user: string | undefined, more: Record<string, string> = {}): Record<string, string> => ({ ...user === undefined ? {} : { 'x-user': user }, ...more })
  const visit = async (path: string, user?: string, more: Record<string, string> = {}) => app.handle(new Request(`http://localhost${path}`, { headers: { accept: 'text/html', ...as(user, more) } }))
  const island = async (user?: string) => (await visit('/?kay_island=0', user, { [ISLAND_HEADER]: '1' })).text()
  const open = async (proofs: LiveRequest['proofs'], user: string | undefined) => app.handle(new Request('http://localhost/_kay/live', { ...JSON_POST, headers: { ...JSON_POST.headers, ...as(user) }, body: JSON.stringify({ proofs, watch: [[UNREAD, '']] } satisfies LiveRequest) }))

  beforeAll(async () => {
    await pages({ root: ROOT, prebuilt: false })
    build = await scratchBuild({}, false, join(process.cwd(), ROOT))
    await build.prerender({})
    app = new Elysia().onRequest(hooks).use(await build.serve({ security: false }))
    live = await import(join(process.cwd(), ROOT, 'src/live.ts')) as Values
    live.unread.set('alice', 3)
    live.unread.set('bob', 5)
  }, 120_000)

  afterAll(async () => {
    live.unread.delete('alice')
    live.unread.delete('bob')
    await build?.remove()
  })

  it('has the island carry the value it read, with a proof bound to the user it was rendered for', async () => {
    const page = await (await visit('/', 'alice')).text()

    expect(page).toContain('<slot data-kay-server=')
    expect(page).not.toContain('data-kay-live')

    const html = await island('alice')
    const [proof, ...others] = pagesOf(html)

    expect(html).toContain('3<!--]--> unread')
    expect(html).toContain('<script type="application/json" data-kay-live data-kay-island data-kay-cache>')
    expect(others).toEqual([])
    expect(proof!.values).toEqual([[UNREAD, '', 3]])
    expect(proof!.sig).toMatch(/\|alice$/)
    expect(html).not.toContain('bob')
  })

  it('carries nothing for a visitor nobody signed in', async () => {
    const html = await island()

    expect(html).toContain('0<!--]--> unread')
    expect(html).not.toContain('data-kay-')
  })

  it('sends the island\'s user their own value and refuses its proof to another user and to nobody', async () => {
    const proofs = proofsOf(pagesOf(await island('alice')))
    const feed = new Feed(await open(proofs, 'alice'))

    expect(await feed.next()).toEqual([[UNREAD, '', 3]])
    live.unread.set('alice', 4)
    expect(await feed.next()).toEqual([[UNREAD, '', 4]])
    live.unread.set('alice', 3)
    await feed.close()
    expect((await open(proofs, 'bob')).status).toBe(403)
    expect((await open(proofs, undefined)).status).toBe(403)
  })

  it('renders the 404 page for the visitor as a page does, following their value', async () => {
    const response = await visit('/nowhere', 'bob')
    const html = await response.text()

    expect(response.status).toBe(404)
    expect(html).toContain('5<!--]--> unread')
    expect(pagesOf(html)[0]!.sig).toMatch(/\|bob$/)
  })

  it('gives a visitor nobody signed in the starting value on the 404 page, with no script', async () => {
    const html = await (await visit('/nowhere')).text()

    expect(html).toContain('0<!--]--> unread')
    expect(html).not.toContain('data-kay-live')
  })

  it('renders the error page of a hook that threw for the visitor too', async () => {
    const response = await visit('/inbox', 'alice', { 'x-throw': '1' })
    const html = await response.text()

    expect(response.status).toBe(500)
    expect(html).toContain('Broke')
    expect(html).toContain('3<!--]--> unread')
    expect(pagesOf(html)[0]!.sig).toMatch(/\|alice$/)
  })

  it('renders a page through the error page when asking who is signed in fails, for the first request of the page and the next', async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await visit('/inbox', 'alice', { 'x-namer-fails': '1' })
      const html = await response.text()

      expect(response.status).toBe(500)
      expect(html).toContain('Broke')
      expect(html).toContain('0<!--]--> unread')
      expect(html).not.toContain('alice')
    }

    expect(await (await visit('/inbox', 'alice')).text()).toContain('3<!--]--> unread')
  })
})
