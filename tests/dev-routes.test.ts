import type { DevRoute, DevRoutes } from '../src/server/dev'
import type { PlumbingServed } from '../src/server/plumbing'
import { join, relative } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { t } from 'elysia'
import { pages } from '../src/server'
import { analytics, vitals } from '../src/server/analytics'
import { DEV_ROUTES } from '../src/server/dev'
import { plumbing } from '../src/server/plumbing'
import { ServedPaths } from '../src/server/served-paths'
import { scratchDir } from './scratch'

const NONE: PlumbingServed = { actions: false, publicEnv: false, preview: false, cspReports: false, buildFiles: [], mounted: [] }
const ALWAYS = ['GET /_kay/*', 'GET /_kay/image', 'GET /_kay/card', 'GET /_kay/files/*', 'POST /_kay/live', 'POST /_kay/error']

const line = ({ method, path }: { method: string, path: string }) => `${method} ${path}`

async function site(files: Record<string, string> = {}) {
  const dir = await scratchDir('dev-routes-')

  await Promise.all(Object.entries({ 'routes/index.kay': 'h1 Home\n', ...files }).map(async ([name, text]) => Bun.write(join(dir, name), text)))

  return { routes: relative(process.cwd(), join(dir, 'routes')), publicDir: relative(process.cwd(), join(dir, 'public')) }
}

async function listed(options: Parameters<typeof pages>[0]): Promise<DevRoutes> {
  const dev = await pages({ prebuilt: false, security: false, dev: true, ...options })

  return await (await dev.handle(new Request(`http://localhost${DEV_ROUTES}`))).json() as DevRoutes
}

const plumbed = (routes: DevRoute[]) => routes.filter(route => route.kind === 'plumbing')

describe('kay\'s plumbing in the dev tool\'s routes', () => {
  it('lists what every app serves, and nothing a setting turns on while the setting is off', () => {
    expect(plumbing(NONE).map(line)).toEqual(ALWAYS)
  })

  it('lists each endpoint only when the app serves it', () => {
    const lines = (served: Partial<PlumbingServed>) => plumbing({ ...NONE, ...served }).map(line).filter(entry => !ALWAYS.includes(entry))

    expect(lines({ actions: true })).toEqual(['POST /_kay/action/<file>/<name>'])
    expect(lines({ cspReports: true })).toEqual(['POST /_kay/csp'])
    expect(lines({ preview: true })).toEqual(['GET /_kay/preview', 'POST /_kay/draft'])
    expect(lines({ publicEnv: true })).toEqual(['GET /_kay/env.js'])
    expect(lines({ buildFiles: ['/_kay/search.json', '/_kay/search/ab12/0.json', '/_kay/THIRD-PARTY-LICENSES.txt', '/_kay/images/hero-640.webp', '/_kay/assets/logo-2k1v9.png', '/_kay/main-abc.js'] })).toEqual(['GET /_kay/assets/*', 'GET /_kay/images/*', 'GET /_kay/search.json', 'GET /_kay/search/*', 'GET /_kay/THIRD-PARTY-LICENSES.txt'])
    expect(lines({ mounted: [{ method: 'GET', path: '/_kay/analytics.js' }, { method: 'GET', path: '/_kay/analytics/notice.js' }, { method: 'POST', path: '/_kay/analytics' }, { method: 'GET', path: '/_kay/mail' }] })).toEqual(['GET /_kay/analytics.js', 'GET /_kay/analytics/notice.js', 'POST /_kay/analytics'])
    expect(lines({ mounted: [{ method: 'GET', path: '/_kay/analytics/script.js' }, { method: 'POST', path: '/_kay/analytics/collect' }] })).toEqual(['GET /_kay/analytics/script.js', 'POST /_kay/analytics/collect'])
  })

  it('lists the vitals beacon and its route once vitals() mounted them', () => {
    const lines = plumbing({ ...NONE, mounted: [{ method: 'GET', path: '/_kay/vitals.js' }, { method: 'POST', path: '/_kay/vitals' }] }).map(line).filter(entry => !ALWAYS.includes(entry))

    expect(lines).toEqual(['GET /_kay/vitals.js', 'POST /_kay/vitals'])
  })

  it('gives each a purpose and a page of the docs', () => {
    const every = plumbing({ actions: true, publicEnv: true, preview: true, cspReports: true, buildFiles: ['/_kay/search.json', '/_kay/search/a/0.json', '/_kay/THIRD-PARTY-LICENSES.txt', '/_kay/images/a.webp', '/_kay/assets/a.png'], mounted: [['GET', '/_kay/analytics.js'], ['GET', '/_kay/analytics/notice.js'], ['POST', '/_kay/analytics'], ['GET', '/_kay/analytics/script.js'], ['POST', '/_kay/analytics/collect'], ['GET', '/_kay/vitals.js'], ['POST', '/_kay/vitals']].map(([method, path]) => ({ method: method!, path: path! })) })

    expect(every).toHaveLength(23)

    for (const { purpose, docs } of every) {
      expect(purpose).not.toBe('')
      expect(docs).toMatch(/^\/llms\/[a-z-]+$/)
      expect(Bun.file(join(import.meta.dir, '..', `${docs}.md`)).size).toBeGreaterThan(0)
    }
  })

  it('leaves out a path an app file took over, for its method alone', () => {
    const served = new ServedPaths()

    served.claim({ path: '/_kay/live', owner: 'src/routes/_kay/live.ts', kind: 'endpoint' })
    served.claim({ path: '/_kay/error', owner: 'src/api/error.ts', kind: 'api', method: 'GET' })
    served.claim({ path: '/_kay/card', owner: 'the card', kind: 'kay' })

    const taken = (path: string, method: string) => served.heldByApp(path, method)

    expect(taken('/_kay/live', 'GET')).toBe(true)
    expect(taken('/_kay/live', 'POST')).toBe(false)
    expect(taken('/_kay/error', 'POST')).toBe(false)
    expect(taken('/_kay/card', 'GET')).toBe(false)
    expect(plumbing(NONE, taken).map(line)).toContain('POST /_kay/live')
  })

  it('lists what a booted app serves, in the Routes tab\'s answer apart from the pages kay serves', async () => {
    const { routes: bare } = await listed(await site())

    // The dev build always has an asset of its own.
    expect(plumbed(bare).map(line)).toEqual([...ALWAYS.slice(0, 1), 'GET /_kay/assets/*', ...ALWAYS.slice(1)])
    expect(plumbed(bare).find(route => route.path === '/_kay/image')).toMatchObject({ kind: 'plumbing', owner: expect.any(String), docs: '/llms/images', href: '/_kay/image' })
    expect(plumbed(bare).find(route => route.path === '/_kay/live')!.href).toBeUndefined()
    expect(plumbed(bare).find(route => route.path === '/_kay/files/*')!.href).toBeUndefined()
  })

  it('lists the actions, previews, reports, public env and analytics an app turns on, each once', async () => {
    const paths = await site({ 'routes/form.kay': '--- server\nimport { t } from \'elysia\'\nimport { action } from \'kay\'\n\nexport const add = action(t.Object({}), async () => 1)\n---\nh1 Form\n' })

    process.env.KAY_TEST_MAP_KEY = 'x'

    const { routes: found } = await listed({
      ...paths,
      security: { reports: true },
      preview: { secret: 'a'.repeat(32) },
      publicEnv: t.Object({ KAY_TEST_MAP_KEY: t.String() }),
      extensions: [analytics({ provider: 'plausible', domain: 'example.com' }), vitals()],
    }).finally(() => {
      delete process.env.KAY_TEST_MAP_KEY
    })
    const lines = plumbed(found).map(line)

    for (const expected of ['POST /_kay/action/<file>/<name>', 'POST /_kay/csp', 'GET /_kay/preview', 'POST /_kay/draft', 'GET /_kay/env.js', 'GET /_kay/analytics.js', 'POST /_kay/analytics', 'GET /_kay/vitals.js', 'POST /_kay/vitals'])
      expect(lines).toContain(expected)

    expect(lines.filter(entry => entry === 'GET /_kay/env.js')).toHaveLength(1)
    expect(found.filter(route => route.kind === 'kay').map(line)).not.toContain('GET /_kay/env.js')
    expect(found.filter(route => route.kind === 'kay').map(route => route.owner)).not.toContain('the extension kay-analytics')
  })

  it('shows none of them for an app with none of the settings', async () => {
    const { routes: found } = await listed(await site())
    const lines = plumbed(found).map(line)

    expect(lines.filter(entry => (/csp|preview|draft|env\.js|analytics|search|action/).test(entry))).toEqual([])
  })

  it('links the GET paths under the base, the others naming no link', async () => {
    const { routes: found } = await listed({ ...await site(), base: '/shop', security: { reports: true } })

    expect(plumbed(found).filter(route => route.href !== undefined).map(route => route.href)).toEqual(['/shop/_kay/image', '/shop/_kay/card'])
  })

  it('shows a path an app file took over as the app\'s', async () => {
    const { routes: found } = await listed(await site({ 'public/_kay/card': 'mine' }))

    expect(plumbed(found).map(line)).not.toContain('GET /_kay/card')
    expect(plumbed(found).map(line)).toContain('GET /_kay/image')
  })
})
