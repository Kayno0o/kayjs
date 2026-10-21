import type { ScratchBuild } from './prerendered'
import { join } from 'node:path'
import { afterEach, describe, expect, it, setSystemTime } from 'bun:test'
import { invalidate, onKeysInvalidated } from '../src/runtime/cache'
import { schedule, talks } from './fixtures/scheduled/src/content.config'
import { scratchBuild } from './prerendered'

const FIXTURE = 'tests/fixtures/scheduled/src'
const OPTIONS = { routes: `${FIXTURE}/routes`, content: `${FIXTURE}/content.config.ts`, security: false as const, site: 'https://talks.example', log: false as const }
const NOW = new Date('2026-10-19T12:00:00Z')

// The servers a test started, stopped as it ends, so none keeps watching the dates of the next test's entries.
const servers: Awaited<ReturnType<ScratchBuild['serve']>>[] = []

async function serve(scratch: ScratchBuild) {
  const app = await scratch.serve(OPTIONS)

  servers.push(app)

  return app
}

async function build<T>(run: (build: ScratchBuild) => Promise<T>): Promise<T> {
  const scratch = await scratchBuild()

  try {
    return await run(scratch)
  }
  finally {
    for (const app of servers.splice(0)) {
      if (!app.server)
        app.listen(0)

      await app.stop()
    }

    await scratch.remove()
  }
}

// Visits a path, for the body and the status.
async function visit(app: { handle: (request: Request) => Response | Promise<Response> }, path: string): Promise<{ status: number, text: string }> {
  const response = await app.handle(new Request(`http://localhost${path}`))

  return { status: response.status, text: await response.text() }
}

// Visits again until the body holds `wanted`, for a timer in the server to fire.
async function until(app: Parameters<typeof visit>[0], path: string, wanted: string): Promise<string> {
  let text = (await visit(app, path)).text

  for (let wait = 0; !text.includes(wanted) && wait < 60; wait++) {
    await Bun.sleep(50)
    text = (await visit(app, path)).text
  }

  return text
}

afterEach(() => {
  setSystemTime()
  schedule.items = []
  schedule.loads = 0
  schedule.afterRead = undefined
  schedule.delay = undefined
  talks.invalidate()
  invalidate(() => true)
})

// A server for a site built with its talks scheduled for the year 2999, then given dates for the talks `after` milliseconds ahead, as a CMS saving them does.
async function schedulesAfter(scratch: ScratchBuild, ...after: number[]) {
  schedule.items = [{ slug: 'now', title: 'Now' }, ...after.map((_, index) => ({ slug: `soon${index}`, title: `Soon${index}`, at: '2999-01-01' }))]
  await scratch.prerender(OPTIONS)

  const app = await serve(scratch)

  expect((await visit(app, '/talks')).text).toContain('Now')
  schedule.items = [{ slug: 'now', title: 'Now' }, ...after.map((wait, index) => ({ slug: `soon${index}`, title: `Soon${index}`, at: new Date(Date.now() + wait).toISOString() }))]
  talks.invalidate()

  return app
}

describe('a prerendered site with a scheduled entry', () => {
  it('shows it at its time in the listing, its own page, the sitemap and the feed, with no request to rebuild anything', async () => {
    await build(async (scratch) => {
      const app = await schedulesAfter(scratch, 1500)

      expect((await visit(app, '/talks')).text).not.toContain('Soon0')
      expect((await visit(app, '/talks/soon0')).status).toBe(404)
      expect((await visit(app, '/sitemap.xml')).text).not.toContain('/talks/soon0')
      expect((await visit(app, '/talks.xml')).text).not.toContain('Soon0')
      expect(await until(app, '/talks', 'Soon0')).toContain('Soon0')
      expect(await visit(app, '/talks/soon0')).toEqual({ status: 200, text: expect.stringContaining('<h1>Soon0</h1>') })
      expect((await visit(app, '/sitemap.xml')).text).toContain('https://talks.example/talks/soon0')
      expect((await visit(app, '/talks.xml')).text).toContain('Soon0')
    })
  })

  it('lists an entry a CMS saved in the sitemap at once, not up to an hour later', async () => {
    await build(async (scratch) => {
      const app = await schedulesAfter(scratch, 60_000)

      expect((await visit(app, '/sitemap.xml')).text).not.toContain('/talks/added')
      schedule.items = [...schedule.items, { slug: 'added', title: 'Added', at: new Date(Date.now() - 1000).toISOString() }]
      talks.invalidate()
      expect((await visit(app, '/sitemap.xml')).text).toContain('https://talks.example/talks/added')
    })
  })

  it('keeps the sitemap through an invalidation of a key it did not read, and tells a CDN to revalidate it', async () => {
    await build(async (scratch) => {
      const app = await schedulesAfter(scratch, 60_000)
      const first = await app.handle(new Request('http://localhost/sitemap.xml'))
      const etag = first.headers.get('etag')!

      expect(first.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
      expect(etag).toMatch(/^W\//)
      schedule.items = [...schedule.items, { slug: 'added', title: 'Added', at: new Date(Date.now() - 1000).toISOString() }]
      invalidate('somewhere-else')
      expect(await visit(app, '/sitemap.xml')).not.toHaveProperty('text', expect.stringContaining('/talks/added'))

      const same = await app.handle(new Request('http://localhost/sitemap.xml', { headers: { 'if-none-match': etag } }))

      expect([same.status, same.headers.get('etag')]).toEqual([304, etag])
      talks.invalidate()

      const changed = await app.handle(new Request('http://localhost/sitemap.xml', { headers: { 'if-none-match': etag } }))

      expect(changed.status).toBe(200)
      expect(changed.headers.get('etag')).not.toBe(etag)
      expect(await changed.text()).toContain('/talks/added')
    })
  })

  it('takes an ending entry down at its time from the listing, its prerendered page, the sitemap and the feed, the page then answering 410 Gone', async () => {
    await build(async (scratch) => {
      schedule.items = [{ slug: 'now', title: 'Now' }, { slug: 'ending', title: 'Ending', ends: '2999-01-01' }]
      await scratch.prerender(OPTIONS)

      const app = await serve(scratch)

      expect(await visit(app, '/talks/ending')).toEqual({ status: 200, text: expect.stringContaining('<h1>Ending</h1>') })
      schedule.items = [{ slug: 'now', title: 'Now' }, { slug: 'ending', title: 'Ending', ends: new Date(Date.now() + 1200).toISOString() }]
      talks.invalidate()
      expect((await visit(app, '/talks')).text).toContain('Ending')

      let text = (await visit(app, '/talks')).text

      for (let wait = 0; text.includes('Ending') && wait < 60; wait++) {
        await Bun.sleep(50)
        text = (await visit(app, '/talks')).text
      }

      expect(text).not.toContain('Ending')
      expect((await visit(app, '/talks/ending')).status).toBe(410)
      expect((await visit(app, '/talks/now')).status).toBe(200)
      expect((await visit(app, '/sitemap.xml')).text).not.toContain('/talks/ending')
      expect((await visit(app, '/talks.xml')).text).not.toContain('Ending')
    })
  })

  it('renders a page again on its first visit when the server was down at the end time', async () => {
    await build(async (scratch) => {
      setSystemTime(NOW)
      schedule.items = [{ slug: 'ending', title: 'Ending', ends: '2026-10-19T13:00:00Z' }]
      await scratch.prerender(OPTIONS)
      expect(await Bun.file(join(scratch.pages, 'talks.html')).text()).toContain('Ending')
      setSystemTime(new Date('2026-10-19T14:00:00Z'))

      const app = await serve(scratch)

      expect((await visit(app, '/talks')).text).not.toContain('Ending')
      expect((await visit(app, '/talks/ending')).status).toBe(410)
    })
  })

  it('waits for each date in turn, the nearest first', async () => {
    await build(async (scratch) => {
      const app = await schedulesAfter(scratch, 2400, 800)

      expect(await until(app, '/talks', 'Soon1')).toContain('Soon1')
      expect((await visit(app, '/talks')).text).not.toContain('Soon0')
      expect(await until(app, '/talks', 'Soon0')).toContain('Soon0')
    })
  })

  it('renders a page again on its first visit when the server was down at the time, whether the build is older or the date was past at the build', async () => {
    await build(async (scratch) => {
      setSystemTime(NOW)
      schedule.items = [{ slug: 'late', title: 'Late', at: '2026-10-19T13:00:00Z' }, { slug: 'old', title: 'Old', at: '2026-10-01' }]
      await scratch.prerender(OPTIONS)
      setSystemTime(new Date('2026-10-19T14:00:00Z'))

      const app = await serve(scratch)
      const listing = (await visit(app, '/talks')).text

      expect(listing).toContain('Late')
      expect(listing).toContain('Old')
    })
  })

  it('renders a page again when its date falls between the start of its render and its end', async () => {
    await build(async (scratch) => {
      setSystemTime(NOW)
      schedule.items = [{ slug: 'edge', title: 'Edge', at: '2026-10-19T12:00:01Z' }]
      schedule.afterRead = () => setSystemTime(new Date('2026-10-19T12:00:05Z'))
      await scratch.prerender(OPTIONS)
      schedule.afterRead = undefined
      expect(await Bun.file(join(scratch.pages, 'talks.html')).text()).not.toContain('Edge')

      const app = await serve(scratch)

      expect((await visit(app, '/talks')).text).toContain('Edge')
    })
  })

  it('renders a page again once a first read slower than the start ends, though the server answered before', async () => {
    await build(async (scratch) => {
      setSystemTime(NOW)
      schedule.items = [{ slug: 'late', title: 'Late', at: '2026-10-19T13:00:00Z' }]
      await scratch.prerender(OPTIONS)
      setSystemTime(new Date('2026-10-19T14:00:00Z'))
      schedule.delay = 1300
      talks.invalidate()

      const app = await serve(scratch)

      schedule.delay = undefined
      expect((await visit(app, '/talks')).text).not.toContain('Late')
      expect(await until(app, '/talks', 'Late')).toContain('Late')
    })
  })

  it('leaves a page rendered after the date alone', async () => {
    await build(async (scratch) => {
      setSystemTime(new Date('2026-10-19T14:00:00Z'))
      schedule.items = [{ slug: 'past', title: 'Past', at: '2026-10-19T13:00:00Z' }]
      await scratch.prerender(OPTIONS)

      const app = await serve(scratch)
      const loads = schedule.loads

      expect((await visit(app, '/talks')).text).toContain('Past')
      expect(schedule.loads).toBe(loads)
    })
  })

  it('publishes in every replica by itself, none of them dropping what the others hold', async () => {
    await build(async (scratch) => {
      schedule.items = [{ slug: 'now', title: 'Now' }, { slug: 'soon0', title: 'Soon0', at: '2999-01-01' }]
      await scratch.prerender(OPTIONS)

      const [first, second] = [await serve(scratch), await serve(scratch)]

      schedule.items = [{ slug: 'soon0', title: 'Soon0', at: new Date(Date.now() + 1200).toISOString() }]
      talks.invalidate()
      expect((await visit(first, '/talks')).text).not.toContain('Soon0')

      const loads = schedule.loads

      expect(await until(first, '/talks', 'Soon0')).toContain('Soon0')
      expect(await until(second, '/talks', 'Soon0')).toContain('Soon0')
      expect(schedule.loads).toBe(loads)
    })
  })

  it('goes on publishing when the server stops and listens again', async () => {
    await build(async (scratch) => {
      const app = await schedulesAfter(scratch, 1500)

      expect((await visit(app, '/sitemap.xml')).text).not.toContain('/talks/soon0')
      app.listen(0)
      await app.stop()
      app.listen(0)
      expect(await until(app, '/talks', 'Soon0')).toContain('Soon0')
      expect((await visit(app, '/sitemap.xml')).text).toContain('https://talks.example/talks/soon0')
    })
  })

  it('refreshes nothing once the server stopped', async () => {
    await build(async (scratch) => {
      const app = await schedulesAfter(scratch, 700)
      let heard = 0
      const stopHearing = onKeysInvalidated((matches) => {
        if (matches('kay:content:talks'))
          heard++

        return []
      })

      try {
        app.listen(0)
        await app.stop()
        await Bun.sleep(1200)
        expect(heard).toBe(0)
      }
      finally {
        stopHearing()
      }
    })
  })

  it('refreshes the pages once when the date passes', async () => {
    await build(async (scratch) => {
      const app = await schedulesAfter(scratch, 700)
      let heard = 0
      const stopHearing = onKeysInvalidated((matches) => {
        if (matches('kay:content:talks'))
          heard++

        return []
      })

      try {
        await until(app, '/talks', 'Soon0')
        await Bun.sleep(300)
        expect(heard).toBe(1)
      }
      finally {
        stopHearing()
      }
    })
  })
})
