import type { ServedPage } from '../src/server/render'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { readClient } from '../src/server/client'
import { localeSettings } from '../src/server/i18n'
import { registerLoader } from '../src/server/loader'
import { pageResponder } from '../src/server/page-routes'
import { routeMatch, routeTable } from '../src/server/route-table'
import { routeOf, scanRoutes } from '../src/server/routes'

describe('routeTable', () => {
  const served = (file: string) => ({ ...routeOf('/r', `/r/${file}`)!, layouts: [], special: {}, guards: [] })

  it('serves each route under each locale\'s path, its untranslated path sending there, and reads an action\'s params under any of them', () => {
    const org = served('orgs/[org].kay')
    const about = served('about.kay')
    const settings = localeSettings({ locales: ['en', 'fr'], defaultLocale: 'en', paths: { '/orgs/:org': { fr: '/organisations/:org' } } })
    const table = routeTable([org, about], settings)

    expect([...table.paths.keys()].sort()).toEqual(['/about', '/fr/about', '/fr/organisations/:p3', '/fr/orgs/:p3', '/orgs/:p2'])
    expect(table.paths.get('/fr/organisations/:p3')!.get('fr')).toMatchObject({ prefix: '/fr', candidates: [{ route: org }] })
    expect(table.paths.get('/fr/orgs/:p3')!.get('fr')).toMatchObject({ prefix: '/fr', untranslated: true, candidates: [{ route: org }] })
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
  it('serves the copy kay build rendered, and renders afresh for a visitor coming back from a form post, kept by no cache', async () => {
    const root = process.cwd()

    await registerLoader(root)
    const about = { ...(await scanRoutes(join(root, 'tests/fixtures/site/src/routes'))).find(route => route.pattern === '/about')!, guards: [] }
    const page: ServedPage = { html: '<p>Built</p>', encoded: {}, headers: [], status: 200, etag: '"built"', renderedAt: Date.now() }
    const respond = pageResponder({ client: (await readClient(root))!, renderOptions: {}, prerendered: new Map([['/about', new Map([['/about', page]])]]), settings: undefined, transforms: [], pageFile: async () => undefined })
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
})
