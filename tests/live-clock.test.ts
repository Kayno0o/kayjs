import type { Subprocess } from 'bun'
import type { LiveRequest } from '../src/runtime/live-value'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { CACHE_LIVE_ID } from '../src/runtime/cache-live-id'
import { Feed, JSON_POST, pagesOf, proofsOf } from './live-helpers'
import { fixtureCopy, scratchDir } from './scratch'

const SECRET = 'a-secret-both-replicas-share-0123456789'
// How far behind the second replica's clock is, within the few seconds a proof tolerates.
const BEHIND_MS = 3000
const SERVER = `
import { join } from 'node:path'
const { ROOT, STORE, BEHIND, SRC } = process.env
const real = Date.now
Date.now = () => real() - Number(BEHIND)
const { testSite } = await import(join(SRC, 'src', 'test', 'index.ts'))
const { invalidate, sqliteCache } = await import(join(SRC, 'src', 'runtime', 'cache.server.ts'))
sqliteCache(STORE)
const site = await testSite({ root: ROOT })
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const { pathname } = new URL(request.url)
    if (pathname === '/__invalidate') {
      invalidate('orders')
      return new Response('ok')
    }
    const body = request.method === 'GET' ? undefined : await request.text()
    return site.fetch(pathname, { method: request.method, headers: request.headers, body })
  },
})
console.log(server.port)
`

interface Replica {
  url: string
  child: Subprocess
}

async function start(script: string, store: string, behind: number): Promise<Replica> {
  const root = await fixtureCopy('live-cache')
  const child = Bun.spawn([process.execPath, script], {
    env: { ...process.env, ROOT: root, STORE: store, BEHIND: String(behind), SRC: join(import.meta.dir, '..'), KAY_SECRET: SECRET },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const reader = child.stdout.getReader()
  const { value } = await reader.read()

  reader.releaseLock()

  return { url: `http://127.0.0.1:${new TextDecoder().decode(value).trim()}`, child }
}

describe('replicas whose clocks disagree', () => {
  const replicas: Replica[] = []

  beforeAll(async () => {
    const dir = await scratchDir('live-clock-')
    const script = join(dir, 'replica.ts')
    const store = join(dir, 'cache.sqlite')

    await Bun.write(script, SERVER)
    replicas.push(await start(script, store, 0), await start(script, store, BEHIND_MS))
  }, 60_000)

  afterAll(async () => {
    for (const replica of replicas) {
      replica.child.kill()
      await replica.child.exited
    }
  })

  it('stamps an invalidation after the read of a page another replica rendered, whose clock is ahead', async () => {
    const [reader, invalidator] = replicas as [Replica, Replica]
    const html = await (await fetch(`${reader.url}/`)).text()
    const [[, key, readAt]] = pagesOf(html).flatMap(page => page.values.filter(([id]) => id === CACHE_LIVE_ID)) as [[string, string, number]]
    const watch: LiveRequest['watch'] = [[CACHE_LIVE_ID, key]]
    const feed = new Feed(await fetch(`${invalidator.url}/_kay/live`, { ...JSON_POST, body: JSON.stringify({ proofs: proofsOf(pagesOf(html)), watch } satisfies LiveRequest) }))

    expect(await feed.next()).toEqual([[CACHE_LIVE_ID, key, 0]])
    // The replicas hear each other every half second.
    await Bun.sleep(1200)
    await fetch(`${invalidator.url}/__invalidate`)

    const [[, , stamp]] = await feed.next() as [[string, string, number]]

    expect(stamp).toBeGreaterThanOrEqual(readAt)
    await feed.close()
  }, 30_000)
})
