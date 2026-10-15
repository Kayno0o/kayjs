import type { StoredReport } from '../src/build/report'
import type { DevSizes } from '../src/server/dev-sizes'
import { mkdir, rm, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { testWorker } from '../src/build/assets'
import { pages } from '../src/server'
import { DEV_SIZES } from '../src/server/dev'
import { scratchDir } from './scratch'

const report = (exported: boolean, routes: StoredReport['routes']): StoredReport => ({ version: 1, exported, islands: {}, routes })

// One project for the file: a process serves one, and each test writes the reports it needs.
const rooted = (async () => {
  const root = await scratchDir('dev-sizes-')

  await Promise.all([
    Bun.write(join(root, 'src/routes/index.kay'), 'h1 Home\n'),
    Bun.write(join(root, 'src/routes/about.kay'), 'h1 About\n'),
    Bun.write(join(root, 'src/routes/[slug].kay'), 'h1 Slug\n'),
    Bun.write(join(root, 'src/routes/docs/[...rest].kay'), 'h1 Docs\n'),
    Bun.write(join(root, 'src/routes/blog/[...rest].kay'), 'h1 Rest\n'),
    Bun.write(join(root, 'src/routes/blog/[post].kay'), 'h1 Post\n'),
    Bun.write(join(root, 'src/routes/[section]/new.kay'), 'h1 New\n'),
  ])
  await mkdir(join(root, '.kay'), { recursive: true })

  return root
})()

// The reports the last builds left, each `age` ms old.
async function site(reports: { server?: StoredReport, exported?: StoredReport } = {}, age = 0) {
  const root = await rooted

  for (const [name, stored] of [['report', reports.server], ['report-static', reports.exported]] as const) {
    const file = join(root, '.kay', `${name}${testWorker()}.json`)

    await rm(file, { force: true })

    if (stored === undefined)
      continue

    await Bun.write(file, JSON.stringify(stored))
    await utimes(file, new Date(Date.now() - age), new Date(Date.now() - age))
  }

  return root
}

async function ask(root: string, path: string, headers: Record<string, string> = { 'x-kay-dev': '1' }, options: Partial<Parameters<typeof pages>[0]> = {}): Promise<{ status: number, sizes?: DevSizes | undefined }> {
  const dev = await pages({ root, prebuilt: false, security: false, dev: true, ...options })
  const response = await dev.handle(new Request(`http://localhost${DEV_SIZES}?path=${encodeURIComponent(path)}`, { headers }))

  return { status: response.status, sizes: response.ok ? (await response.json() as { sizes?: DevSizes }).sizes : undefined }
}

describe('the dev tool\'s production sizes', () => {
  it('reads the route serving the page from the last build\'s report, an exact route before a param one, with its age', async () => {
    const root = await site({ server: report(false, { '/': { js: 2048, css: 512 }, '/about': { js: 4096, css: 0, estimated: true }, '/:slug': { js: 1, css: 1 }, '/docs/*': { js: 9000, css: 100 } }) }, 3_600_000)
    const about = (await ask(root, '/about')).sizes!

    expect(about).toMatchObject({ route: '/about', js: 4096, css: 0, estimated: true, exported: false })
    expect(Date.now() - about.built).toBeGreaterThan(3_000_000)
    expect((await ask(root, '/')).sizes).toMatchObject({ route: '/', js: 2048, estimated: false })
    expect((await ask(root, '/other')).sizes).toMatchObject({ route: '/:slug', js: 1 })
    expect((await ask(root, '/docs/a/b')).sizes).toMatchObject({ route: '/docs/*', js: 9000 })
  })

  it('picks the route the router would, whatever the order of the files', async () => {
    const root = await site({ server: report(false, { '/blog/*': { js: 1, css: 0 }, '/blog/:post': { js: 2, css: 0 }, '/:slug': { js: 3, css: 0 }, '/:section/new': { js: 4, css: 0 } }) })

    // A param before a catch-all, though the catch-all's file sorts first; a static segment before a param.
    expect((await ask(root, '/blog/x')).sizes).toMatchObject({ route: '/blog/:post' })
    expect((await ask(root, '/blog/x/y')).sizes).toMatchObject({ route: '/blog/*' })
    expect((await ask(root, '/anything/new')).sizes).toMatchObject({ route: '/:section/new' })
  })

  it('takes the newest of a server build and a static export, under a base, and says nothing without a report or a route in it', async () => {
    const root = await site({ server: report(false, { '/about': { js: 1, css: 1 } }), exported: report(true, { '/about': { js: 2, css: 2 } }) })

    expect((await ask(root, '/shop/about', undefined, { base: '/shop' })).sizes).toMatchObject({ route: '/about' })
    // Written after the server build's, so the export's sizes are the last made.
    await utimes(join(root, '.kay', `report-static${testWorker()}.json`), new Date(), new Date(Date.now() + 5000))
    expect((await ask(root, '/about')).sizes).toMatchObject({ js: 2, exported: true })
    expect((await ask(await site({ server: report(false, {}) }), '/about')).sizes).toBeUndefined()
    expect((await ask(await site(), '/about')).sizes).toBeUndefined()
  })

  it('says nothing for a report with no routes, a path no route serves or a malformed one, and answers 400 without a path', async () => {
    const root = await site({ server: { version: 1, exported: false, islands: {} } as unknown as StoredReport })

    expect((await ask(root, '/about')).sizes).toBeUndefined()

    await site({ server: report(false, { '/about': { js: 1, css: 1 } }) })

    expect((await ask(root, '/a/b/c/d')).sizes).toBeUndefined()
    expect((await ask(root, '/%E0%A4%A')).sizes).toBeUndefined()

    const dev = await pages({ root, prebuilt: false, security: false, dev: true })

    expect((await dev.handle(new Request(`http://localhost${DEV_SIZES}`, { headers: { 'x-kay-dev': '1' } }))).status).toBe(400)
  })

  it('is not served in production', async () => {
    const prod = await pages({ root: await site(), prebuilt: false, security: false, dev: false })

    expect((await prod.handle(new Request(`http://localhost${DEV_SIZES}?path=%2Fabout`, { headers: { 'x-kay-dev': '1' } }))).status).toBe(404)
  })

  it('refuses a request the dev tool did not make', async () => {
    const root = await site({ server: report(false, { '/about': { js: 1, css: 1 } }) })

    expect((await ask(root, '/about', {})).status).toBe(403)
    expect((await ask(root, '/about', { 'x-kay-dev': '1', 'sec-fetch-site': 'cross-site' })).status).toBe(403)
  })
})
