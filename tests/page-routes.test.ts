import type { ServedPage } from '../src/server/render'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { pages } from '../src/server'
import { readClient } from '../src/server/client'
import { loadGuards } from '../src/server/guards'
import { localeSettings } from '../src/server/i18n'
import { pageResponder } from '../src/server/page-routes'
import { routeMatch, routeTable } from '../src/server/route-table'
import { routeOf, scanRoutes } from '../src/server/routes'
import { configHead } from '../src/server/seo'
import { scratchDir } from './scratch'

describe('routeTable', () => {
  const served = (file: string) => ({ ...routeOf('/r', `/r/${file}`)!, layouts: [], special: {}, guards: [] })

  it('serves each route under each locale\'s path, its untranslated path sending there, and reads an action\'s params under any of them', () => {
    const org = served('orgs/[org].kay')
    const about = served('about.kay')
    const settings = localeSettings({ locales: ['en', 'fr'], defaultLocale: 'en', paths: { '/orgs/:org': { fr: '/organisations/:org' } } })
    const table = routeTable([org, about], settings)

    expect([...table.paths.keys()].sort()).toEqual(['/about', '/fr/about', '/fr/organisations/:p3', '/fr/orgs/:p3', '/orgs/:p2'])
    expect(table.paths.get('/fr/organisations/:p3')!.get('fr')).toMatchObject({ prefix: '/fr', candidates: [{ route: org }] })
    expect(table.paths.get('/fr/orgs/:p3')!.get('fr')).toMatchObject({ prefix: '/fr', untranslated: { path: '/fr/orgs/:p3', kind: 'page' }, candidates: [{ route: org }] })
    expect(table.paths.get('/about')!.get('en')!.candidates).toEqual([{ route: about, shape: expect.objectContaining({ path: '/about' }) }])

    const match = routeMatch(table, new Map())

    expect(match(org, '/orgs/acme')).toEqual({ org: 'acme' })
    expect(match(org, '/fr/organisations/acme')).toEqual({ org: 'acme' })
    expect(match(org, '/fr/orgs/acme')).toEqual({ org: 'acme' })
    expect(match(about, '/orgs/acme')).toBeUndefined()
  })

  it('tries the pages a matcher checks before the one without, then by file', () => {
    const plain = served('items/[id].kay')
    const even = served('items/[id=even].kay')
    const table = routeTable([plain, even], undefined)

    expect(table.paths.get('/items/:p2')!.get(undefined)!.candidates.map(candidate => candidate.route)).toEqual([even, plain])
  })
})

describe('pageResponder', () => {
  const root = process.cwd()
  const built = (path: string): Map<string, ServedPage> => new Map([[path, { html: '<p>Built</p>', encoded: {}, headers: [], status: 200, etag: '"built"', renderedAt: Date.now() }]])

  it('serves the copy kay build rendered, and renders afresh for a visitor coming back from a form post, kept by no cache', async () => {
    // Boots the site, which builds the browser bundle the responder reads.
    await pages({ routes: 'tests/fixtures/site/src/routes', prebuilt: false })
    const about = { ...(await scanRoutes(join(root, 'tests/fixtures/site/src/routes'))).find(route => route.pattern === '/about')!, guards: [] }
    const respond = pageResponder({ client: (await readClient(root))!, renderOptions: {}, prerendered: new Map([['/about', built('/about')]]), settings: undefined, transforms: [], pageFile: async () => undefined })
    const visit = async (path: string, headers: Record<string, string> = {}) => {
      const response = await respond(about, {}, { request: new Request(`http://localhost${path}`, { headers }) }, new URL(`http://localhost${path}`))

      return { html: await response.text(), cache: response.headers.get('cache-control'), etag: response.headers.get('etag') }
    }

    expect(await visit('/about')).toEqual({ html: '<p>Built</p>', cache: 'public, max-age=0, must-revalidate', etag: '"built"' })
    expect(await visit('/about', { cookie: 'kay_flash=x' })).toMatchObject({ html: expect.stringContaining('<h1>About</h1>'), cache: 'private, no-store', etag: null })
    // A path the build did not render renders per request, as any cache may keep it.
    expect(await visit('/about/')).toMatchObject({ html: '<p>Built</p>' })
    expect(await visit('/elsewhere')).toMatchObject({ html: expect.stringContaining('<h1>About</h1>'), cache: null })
  })

  it('answers a visitor the guard of a prerendered page turns away with the error page, under the mount point', async () => {
    const dir = await scratchDir('guarded-')
    const guard = (body: string) => `import { guard } from 'kay'\n\nexport default guard(${body})\n`

    await Promise.all([
      Bun.write(join(dir, 'vip/index.kay'), 'h1 VIP\n'),
      Bun.write(join(dir, 'vip/_guard.ts'), guard('({ deny }) => deny(403, \'Members only\')')),
      Bun.write(join(dir, 'gone/index.kay'), 'h1 Gone\n'),
      Bun.write(join(dir, 'gone/_guard.ts'), guard('({ notFound }) => notFound()')),
      Bun.write(join(dir, '_error.kay'), '--- server\nconst { status } = ctx.error\n---\nh1 Error {status}\na(href="/home") Home\n'),
    ])
    await pages({ routes: dir, prebuilt: false })

    const client = (await readClient(root))!
    const routes = await Promise.all((await scanRoutes(dir)).map(loadGuards))
    const { head } = await configHead(root, {}, client.dir)
    const respond = pageResponder({ client, renderOptions: { base: '/b', head }, prerendered: new Map([['/vip', built('/vip')], ['/gone', built('/gone')]]), settings: undefined, transforms: [], pageFile: async () => undefined })

    for (const [path, status] of [['/vip', 403], ['/gone', 404]] as const) {
      const response = await respond(routes.find(route => route.pattern === path)!, {}, { request: new Request(`http://localhost${path}`) }, new URL(`http://localhost${path}`))
      const html = await response.text()

      expect({ path, status: response.status }).toEqual({ path, status })
      expect(html).toContain(`<h1>Error ${status}</h1>`)
      expect(html).toContain('<a href="/b/home">Home</a>')
      expect(html).toContain('href="/b/favicon.ico"')
    }
  })
})
