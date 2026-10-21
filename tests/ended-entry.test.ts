import type { ScratchBuild } from './prerendered'
import { afterEach, describe, expect, it, setSystemTime } from 'bun:test'
import { t } from 'elysia'
import { collection } from '../src/content'
import { runInLocale } from '../src/runtime/locale-state'
import { addRuntimeRedirect, clearMissing, removeRuntimeRedirect } from '../src/server/library'
import { missingPaths } from '../src/server/not-found'
import { askedForEndedEntry, withEndedEntries } from '../src/server/scope'
import { schedule } from './fixtures/scheduled/src/content.config'
import { scratchBuild } from './prerendered'

const FIXTURE = 'tests/fixtures/scheduled/src'
const ENDING = '2026-10-19T13:00:00Z'
const servers: Awaited<ReturnType<ScratchBuild['serve']>>[] = []

function optionsFor(base: string, redirects: Record<string, string> = {}, trailingSlash?: 'always') {
  return { routes: `${FIXTURE}/routes`, content: `${FIXTURE}/content.config.ts`, security: false as const, site: 'https://talks.example', log: false as const, base, redirects, ...trailingSlash && { trailingSlash } }
}

// The app answers paths with the base already stripped, as a proxy under it passes them, and writes it into the locations it sends.
// A site built while the talk is running, then served once it ended.
async function endedSite(base: string, redirects?: Record<string, string>, trailingSlash?: 'always') {
  const scratch = await scratchBuild(optionsFor(base, redirects, trailingSlash))

  setSystemTime(new Date('2026-10-19T12:00:00Z'))
  schedule.items = [{ slug: 'now', title: 'Now' }, { slug: 'ending', title: 'Ending', ends: ENDING }, { slug: 'later', title: 'Later', at: '2999-01-01' }, { slug: 'inverted', title: 'Inverted', at: '2999-01-01', ends: '2020-01-01' }]
  await scratch.prerender(optionsFor(base, redirects, trailingSlash))
  setSystemTime(new Date('2026-10-19T14:00:00Z'))

  const app = await scratch.serve(optionsFor(base, redirects, trailingSlash))

  servers.push(app)

  return { scratch, app }
}

async function visit(app: { handle: (request: Request) => Response | Promise<Response> }, path: string): Promise<{ status: number, location: string | null, text: string }> {
  const response = await app.handle(new Request(`http://localhost${path}`, { redirect: 'manual' }))

  return { status: response.status, location: response.headers.get('location'), text: await response.text() }
}

// The count is written after the answer went out, so the paths are read once they have been, or once nothing more is coming.
async function listed(expected: number): Promise<string[]> {
  for (let attempt = 0; attempt < 100 && missingPaths().length < expected; attempt++)
    await Bun.sleep(10)

  await Bun.sleep(expected === 0 ? 100 : 0)

  return missingPaths().map(row => row.path).toSorted()
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
  it('answers its page with 410 Gone, a missing entry, one not yet published and one whose window never opened staying 404', async () => {
    const { scratch, app } = await endedSite(base)

    try {
      expect((await visit(app, `/talks/ending`)).status).toBe(410)
      expect((await visit(app, `/talks/now`)).status).toBe(200)
      expect((await visit(app, `/talks/nobody`)).status).toBe(404)
      expect((await visit(app, `/talks/later`)).status).toBe(404)
      expect((await visit(app, `/talks/inverted`)).status).toBe(404)
    }
    finally {
      await scratch.remove()
    }
  })

  it('lets a redirect from config win over the 410', async () => {
    const { scratch, app } = await endedSite(base, { '/talks/ending': '/talks' })

    try {
      expect(await visit(app, `/talks/ending`)).toMatchObject({ status: 308, location: `${base}/talks` })
    }
    finally {
      await scratch.remove()
    }
  })

  it('lets a redirect added while the site runs win over the 410', async () => {
    const { scratch, app } = await endedSite(base)

    addRuntimeRedirect('/talks/ending', '/talks')

    try {
      expect(await visit(app, `/talks/ending`)).toMatchObject({ status: 307, location: `${base}/talks` })
    }
    finally {
      removeRuntimeRedirect('/talks/ending')
      await scratch.remove()
    }
  })
})

describe('an ended entry\'s page', () => {
  it('shows the 404 page of the app the status 410, and a missing entry 404', async () => {
    const { scratch, app } = await endedSite('')

    try {
      expect(await visit(app, '/talks/ending')).toMatchObject({ status: 410, text: expect.stringContaining('Missing 410') })
      expect(await visit(app, '/talks/nobody')).toMatchObject({ status: 404, text: expect.stringContaining('Missing 404') })
    }
    finally {
      await scratch.remove()
    }
  })

  it('answers 410 under trailingSlash always, the path counted without its slash', async () => {
    const { scratch, app } = await endedSite('', undefined, 'always')

    clearMissing()

    try {
      expect((await visit(app, '/talks/ending/')).status).toBe(410)
      expect((await visit(app, '/talks/nobody/')).status).toBe(404)
      expect(await listed(2)).toEqual(['/talks/ending', '/talks/nobody'])
    }
    finally {
      await scratch.remove()
    }
  })

  it('lists a visit to it among the missing paths, an editor\'s 410 for the path answering without listing it again', async () => {
    const { scratch, app } = await endedSite('')

    clearMissing()

    try {
      expect((await visit(app, '/talks/ending')).status).toBe(410)
      expect(await listed(1)).toEqual(['/talks/ending'])

      addRuntimeRedirect('/talks/ending', '', { status: 410 })
      expect(await listed(0)).toEqual([])
      expect((await visit(app, '/talks/ending')).status).toBe(410)
      expect(await listed(0)).toEqual([])
    }
    finally {
      removeRuntimeRedirect('/talks/ending')
      await scratch.remove()
    }
  })
})

const FRENCH = { locale: 'fr', messages: new Map(), path: '/', settings: { locales: ['en', 'fr'], defaultLocale: 'en', prefixDefault: false } }

interface Row { slug: string, ends?: string, draft?: boolean }

// A localized collection whose entries are listed as `en/<slug>` and `fr/<slug>`.
function localized(rows: Record<string, Row>) {
  return collection({ name: `ended-${crypto.randomUUID()}`, load: () => Object.entries(rows).map(([id, { slug, ends, draft }]) => ({ slug: `${id}/${slug}`, data: { title: id, ends, draft } })) }, {
    schema: t.Object({ title: t.String(), ends: t.Optional(t.Date()), draft: t.Optional(t.Boolean()) }),
    localized: true,
    unpublishAt: 'ends',
    draft: 'draft',
  })
}

// Whether reading the entry for a visitor in French found it, and whether the request was told an ended entry was asked for.
async function ask(rows: Record<string, Row>, state?: typeof FRENCH) {
  const talk = localized(rows)

  return withEndedEntries(async () => {
    const found = await (state ? runInLocale(state, async () => talk.get('hello', 'fr')) : talk.get('hello', 'fr'))

    return { found: found?.data.title, ended: askedForEndedEntry() }
  })
}

describe('get() on an ended entry of a localized collection', () => {
  const PAST = '2026-10-19T13:00:00Z'

  it('notes it for the wanted locale ended with no default locale to fall back to', async () => {
    setSystemTime(new Date('2026-10-19T14:00:00Z'))
    expect(await ask({ fr: { slug: 'hello', ends: PAST } })).toEqual({ found: undefined, ended: true })
  })

  it('does not note it when the default locale stands in for the ended wanted one', async () => {
    setSystemTime(new Date('2026-10-19T14:00:00Z'))
    expect(await ask({ en: { slug: 'hello' }, fr: { slug: 'hello', ends: PAST } }, FRENCH)).toEqual({ found: 'en', ended: false })
  })

  it('notes it when the wanted locale is a draft and the default locale\'s entry ended', async () => {
    setSystemTime(new Date('2026-10-19T14:00:00Z'))
    expect(await ask({ en: { slug: 'hello', ends: PAST }, fr: { slug: 'hello', draft: true } }, FRENCH)).toEqual({ found: undefined, ended: true })
  })

  it('does not note an ended entry that is also a draft, which may come back', async () => {
    setSystemTime(new Date('2026-10-19T14:00:00Z'))
    expect(await ask({ fr: { slug: 'hello', ends: PAST, draft: true } })).toEqual({ found: undefined, ended: false })
  })

  it('does not note an entry that never existed', async () => {
    expect(await ask({ fr: { slug: 'other' } })).toEqual({ found: undefined, ended: false })
  })
})
