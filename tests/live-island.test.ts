import type { LiveRequest } from '../src/runtime/live-value'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { invalidate } from '../src/runtime/cache'
import { CACHE_LIVE_ID } from '../src/runtime/cache-live-id'
import { ISLAND_HEADER } from '../src/runtime/server-islands'
import { db } from './fixtures/live-island/src/data'
import { Feed, JSON_POST, pagesOf, proofsOf } from './live-helpers'
import { scratchBuild } from './prerendered'
import { pages } from './shared-pages'

const ROOT = 'tests/fixtures/live-island'
const SLOT = '<slot data-kay-server='

describe('a deferred server island following a cached value', () => {
  let build: Awaited<ReturnType<typeof scratchBuild>>
  let app: Awaited<ReturnType<typeof build.serve>>
  // What the build warned of.
  const warned: string[] = []

  const visit = async (path: string, headers: Record<string, string> = {}) => app.handle(new Request(`http://localhost${path}`, { headers }))
  const island = async (path = '/') => (await visit(`${path}?kay_island=0`, { [ISLAND_HEADER]: '1' })).text()
  const watch = async (request: Partial<LiveRequest>) => app.handle(new Request('http://localhost/_kay/live', { ...JSON_POST, body: JSON.stringify({ proofs: [], watch: [[CACHE_LIVE_ID, 'stock']], ...request }) }))

  beforeAll(async () => {
    await pages({ root: ROOT, prebuilt: false })
    build = await scratchBuild({}, false, join(process.cwd(), ROOT))
    const warn = spyOn(console, 'warn').mockImplementation((message: string) => {
      warned.push(message)
    })

    try {
      await build.prerender({})
    }
    finally {
      warn.mockRestore()
    }

    app = await build.serve({ security: false })
    db.stock = 5
  }, 120_000)

  afterAll(async () => {
    db.stock = 5
    invalidate(() => true)
    await build?.remove()
  })

  it('warns once, naming the page and the key, when the build drops the live scripts of a page holding the island', () => {
    expect(warned.filter(message => message.includes('reads'))).toEqual([expect.stringContaining('/ reads \'stock\' with `live: true`')])
  })

  it('carries the proof of what the island read inside the island, and the prerendered page carries none', async () => {
    const page = await (await visit('/')).text()

    expect(page).toContain(SLOT)
    expect(page).not.toContain('data-kay-live')
    expect(page).not.toContain('data-kay-cache')

    const html = await island()

    expect(html).toContain('<p class="stock">')
    expect(html).toContain('<script type="application/json" data-kay-island data-kay-cache>')
    expect(pagesOf(html).flatMap(({ values }) => values.map(([id, key]) => [id, key]))).toEqual([[CACHE_LIVE_ID, 'stock']])
  })

  it('carries none either once an invalidation had the prerendered page rendered again', async () => {
    db.stock = 8
    invalidate('stock')

    // The first visit after an invalidation renders the page afresh.
    const page = await (await visit('/')).text()

    expect(page).toContain(SLOT)
    expect(page).not.toContain('data-kay-cache')
    db.stock = 5
    invalidate('stock')
  })

  it('shows the value as it is when the island is fetched', async () => {
    db.stock = 7
    invalidate('stock')
    expect(await island()).toContain('7<!--]--> left')
    db.stock = 5
    invalidate('stock')
  })

  it('carries nothing for an island that read no live value', async () => {
    const html = await island('/quiet')

    expect(html).toContain('<p class="stock">')
    expect(html).not.toContain('data-kay-island')
  })

  it('sends the island its key\'s invalidation time, then each invalidation, to the holder of its proof', async () => {
    const feed = new Feed(await watch({ proofs: proofsOf(pagesOf(await island())) }))

    expect(await feed.next()).toEqual([[CACHE_LIVE_ID, 'stock', expect.any(Number)]])
    invalidate('stock')
    expect((await feed.next())[0]![1]).toBe('stock')
    await feed.close()
  })

  it('refuses a proof edited to another key, one signed for other keys and no proof at all', async () => {
    const [page] = pagesOf(await island())
    const proofs = proofsOf([page!])

    expect((await watch({ proofs: [{ ...proofs[0]!, keys: [[CACHE_LIVE_ID, 'secret']] }], watch: [[CACHE_LIVE_ID, 'secret']] })).status).toBe(403)
    expect((await watch({ proofs: [{ ...proofs[0]!, sig: 'forged' }] })).status).toBe(403)
    expect((await watch({ proofs: [] })).status).toBe(403)
    expect((await watch({ proofs: [{ ...proofs[0]!, at: proofs[0]!.at - 2 * 3_600_000 }] })).status).toBe(403)
  })

  it('leaves a page rendered per request with the script of its own, outside any island', async () => {
    const html = await (await visit('/page')).text()

    expect(html).toContain('<script type="application/json" data-kay-live data-kay-cache>')
    expect(html).not.toContain(SLOT)
    expect(pagesOf(html).flatMap(({ values }) => values.map(([id, key]) => [id, key]))).toEqual([[CACHE_LIVE_ID, 'stock']])
  })

  it('answers an island that does not exist as before', async () => {
    expect((await visit('/?kay_island=9', { [ISLAND_HEADER]: '1' })).status).toBe(404)
  })
})
