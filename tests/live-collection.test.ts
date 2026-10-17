import type { LivePage, LiveRequest } from '../src/runtime/live-value'
import type { TestSite } from '../src/test'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { chromium } from 'playwright-core'
import { removeEntry, saveEntry } from '../src/content'
import { CACHE_LIVE_ID } from '../src/runtime/cache-live-id'
import { browserPath, testSite } from '../src/test'
import { posts, tales } from './fixtures/live-collection/src/content.config'
import { rows } from './fixtures/live-collection/src/data'
import { Feed, JSON_POST, pagesOf, proofsOf } from './live-helpers'
import { fixtureCopy } from './scratch'

const ROOT = 'tests/fixtures/live-collection'
const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')
const TALES = 'kay:content:tales'
const POSTS = 'kay:content:content/posts'

// The cache keys a page follows.
function followed(pages: LivePage[]): string[] {
  return pages.flatMap(page => page.values.filter(([id]) => id === CACHE_LIVE_ID).map(([, key]) => key))
}

describe('a collection a page follows', () => {
  let site: TestSite

  async function open(page: string, watch: string[]): Promise<Response> {
    const { html } = await site.visit(page)

    return site.fetch('/_kay/live', { ...JSON_POST, body: JSON.stringify({ proofs: proofsOf(pagesOf(html)), watch: watch.map(key => [CACHE_LIVE_ID, key]) } satisfies LiveRequest) })
  }

  beforeAll(async () => {
    site = await testSite({ root: ROOT })
  })

  afterAll(async () => site.close())

  it('is written into the page by the key of the collection, a loader\'s and a folder\'s', async () => {
    const tale = await site.visit('/tales')
    const post = await site.visit('/')

    expect(followed(pagesOf(tale.html))).toEqual([TALES])
    expect(followed(pagesOf(post.html))).toEqual([POSTS])
    expect(tale.html).toContain('<script type="application/json" data-kay-live data-kay-cache>')
    expect(tale.html).toContain('<li>First</li>')
  })

  it('follows a single entry read with get() as the list', async () => {
    expect(followed(pagesOf((await site.visit('/one')).html))).toEqual([TALES])
  })

  it('writes nothing into a page reading a collection without live', async () => {
    const { html } = await site.visit('/quiet')

    expect(html).toContain('<li>Calm</li>')
    expect(html).not.toContain('data-kay-live')
    expect(html).not.toContain('data-kay-cache')
  })

  it('names each collection once however often a page reads it', async () => {
    expect(followed(pagesOf((await site.visit('/both')).html)).toSorted()).toEqual([POSTS, TALES].toSorted())
  })

  it('has a stream send the time of each invalidate of the collection, 0 first', async () => {
    const feed = new Feed(await open('/tales', [TALES]))

    expect(await feed.next()).toEqual([[CACHE_LIVE_ID, TALES, 0]])

    const before = Date.now()

    tales.invalidate()

    const [[, , changed]] = await feed.next() as [[string, string, number]]

    expect(changed).toBeGreaterThanOrEqual(before)
    await feed.close()
  })

  it('has a stream send an entry the CMS saved or removed, and the page shows it', async () => {
    const feed = new Feed(await open('/tales', [TALES]))

    await feed.next()
    expect((await saveEntry('tales', { slug: 'second', data: { title: 'Second' } })).issues).toBeUndefined()
    expect((await feed.next())[0]![1]).toBe(TALES)
    expect((await site.visit('/tales')).html).toContain('<li>Second</li>')

    expect(await removeEntry('tales', 'second')).toEqual({})
    expect((await feed.next())[0]![1]).toBe(TALES)
    expect((await site.visit('/tales')).html).not.toContain('Second')
    await feed.close()
  })

  it('has a stream send the invalidate of a folder collection', async () => {
    const feed = new Feed(await open('/', [POSTS]))

    await feed.next()
    posts.invalidate()
    expect((await feed.next())[0]![1]).toBe(POSTS)
    await feed.close()
  })

  it('refuses a collection the proof does not cover', async () => {
    const { html } = await site.visit('/tales')
    const ask = async (key: string) => site.fetch('/_kay/live', { ...JSON_POST, body: JSON.stringify({ proofs: proofsOf(pagesOf(html)), watch: [[CACHE_LIVE_ID, key]] } satisfies LiveRequest) })

    expect((await ask(POSTS)).status).toBe(403)
    expect((await ask('kay:content:quiet')).status).toBe(403)
  })

  it.each([
    ['a base path and a trailing slash', { base: '/shop', trailingSlash: 'always' as const }],
    ['no base', {}],
  ])('gets its proof and its stream with %s', async (_, options) => {
    const shop = await testSite({ root: ROOT, ...options })

    try {
      const { html } = await shop.visit('/tales')
      const feed = new Feed(await shop.fetch('/_kay/live', { ...JSON_POST, body: JSON.stringify({ proofs: proofsOf(pagesOf(html)), watch: [[CACHE_LIVE_ID, TALES]] } satisfies LiveRequest) }))

      expect(followed(pagesOf(html))).toEqual([TALES])
      expect((await feed.next())[0]![1]).toBe(TALES)
      await feed.close()
    }
    finally {
      await shop.close()
    }
  })
})

describe('a page following a collection', () => {
  it('cannot be exported as a file, as it is rendered for each visitor', async () => {
    const fixture = await fixtureCopy('live-collection')

    await Bun.write(join(fixture, 'src/routes/kept.kay'), '--- server\nimport { posts } from \'../content.config\'\n\nexport const page = { prerender: true }\n\nconst list = await posts.all()\n---\nh1 Kept\np {list.length}\n')

    const child = Bun.spawn([process.execPath, CLI, 'build', fixture, '--no-check', '--static', '--outdir', join(fixture, 'out')], { stdout: 'pipe', stderr: 'pipe' })
    const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

    expect(code).not.toBe(0)
    expect(errors).toContain('export-server-render')
  })
})

const chrome = browserPath() ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined)

describe.skipIf(chrome === undefined && (process.env.CI ?? '') === '')('a collection a page follows, in a browser', () => {
  let site: TestSite

  const lists = (count: number) => [(expected: number) => document.querySelectorAll('ul.tales li').length === expected, { timeout: 5000 }, count] as const

  beforeAll(async () => {
    site = await testSite({ root: ROOT, browser: { path: chrome } })
  }, 120_000)

  afterAll(async () => site?.close())

  it('shows an entry the CMS saved in every open tab', async () => {
    rows.tales = [{ slug: 'first', title: 'First' }]
    tales.invalidate()

    await using first = await site.open('/tales')
    await using second = await site.open('/tales')

    await first.waitUntil(...lists(1))
    await saveEntry('tales', { slug: 'browser', data: { title: 'Browser' } })
    await first.waitUntil(...lists(2))
    await second.waitUntil(...lists(2))
    expect(first.errors).toEqual([])
    expect(second.errors).toEqual([])
  })

  it('opens no connection for a page reading a collection without live', async () => {
    await using page = await site.open('/quiet')

    await Bun.sleep(300)
    expect(await page.evaluate(() => performance.getEntriesByType('resource').some(entry => entry.name.includes('/_kay/live')))).toBe(false)
  })
})
