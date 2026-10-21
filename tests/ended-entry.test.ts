import type { ScratchBuild } from './prerendered'
import { afterEach, describe, expect, it, setSystemTime } from 'bun:test'
import { addRuntimeRedirect, removeRuntimeRedirect } from '../src/server/library'
import { schedule } from './fixtures/scheduled/src/content.config'
import { scratchBuild } from './prerendered'

const FIXTURE = 'tests/fixtures/scheduled/src'
const ENDING = '2026-10-19T13:00:00Z'
const servers: Awaited<ReturnType<ScratchBuild['serve']>>[] = []

function optionsFor(base: string, redirects: Record<string, string> = {}) {
  return { routes: `${FIXTURE}/routes`, content: `${FIXTURE}/content.config.ts`, security: false as const, site: 'https://talks.example', log: false as const, base, redirects }
}

// The app answers paths with the base already stripped, as a proxy under it passes them, and writes it into the locations it sends.
// A site built while the talk is running, then served once it ended.
async function endedSite(base: string, redirects?: Record<string, string>) {
  const scratch = await scratchBuild()

  setSystemTime(new Date('2026-10-19T12:00:00Z'))
  schedule.items = [{ slug: 'now', title: 'Now' }, { slug: 'ending', title: 'Ending', ends: ENDING }, { slug: 'later', title: 'Later', at: '2999-01-01' }]
  await scratch.prerender(optionsFor(base, redirects))
  setSystemTime(new Date('2026-10-19T14:00:00Z'))

  const app = await scratch.serve(optionsFor(base, redirects))

  servers.push(app)

  return { scratch, app }
}

async function visit(app: { handle: (request: Request) => Response | Promise<Response> }, path: string): Promise<{ status: number, location: string | null }> {
  const response = await app.handle(new Request(`http://localhost${path}`, { redirect: 'manual' }))

  await response.text()

  return { status: response.status, location: response.headers.get('location') }
}

afterEach(async () => {
  setSystemTime()

  for (const app of servers.splice(0)) {
    if (!app.server)
      app.listen(0)

    await app.stop()
  }
})

describe.each(['', '/docs'])('an entry whose unpublishAt passed, under base %p', (base) => {
  it('answers its page with 410 Gone, a missing or not yet published entry staying 404', async () => {
    const { scratch, app } = await endedSite(base)

    try {
      expect((await visit(app, `/talks/ending`)).status).toBe(410)
      expect((await visit(app, `/talks/now`)).status).toBe(200)
      expect((await visit(app, `/talks/nobody`)).status).toBe(404)
      expect((await visit(app, `/talks/later`)).status).toBe(404)
    }
    finally {
      await scratch.remove()
    }
  })

  it('lets a redirect from config win over the 410', async () => {
    const { scratch, app } = await endedSite(base, { '/talks/ending': '/talks' })

    try {
      expect(await visit(app, `/talks/ending`)).toEqual({ status: 308, location: `${base}/talks` })
    }
    finally {
      await scratch.remove()
    }
  })

  it('lets a redirect added while the site runs win over the 410', async () => {
    const { scratch, app } = await endedSite(base)

    addRuntimeRedirect('/talks/ending', '/talks')

    try {
      expect(await visit(app, `/talks/ending`)).toEqual({ status: 307, location: `${base}/talks` })
    }
    finally {
      removeRuntimeRedirect('/talks/ending')
      await scratch.remove()
    }
  })
})
