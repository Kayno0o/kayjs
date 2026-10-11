import type { ServedPage } from '../src/server/render'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { files, memoryFiles, pages } from '../src/server'
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
    const routes = await Promise.all((await scanRoutes(dir)).map(async route => loadGuards(route)))
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

describe('over a listening server', () => {
  it('serves kay\'s files and a catch-all page where a page of params would take them from Bun\'s router, as app.handle() does', async () => {
    const dir = await scratchDir('wildcards-')
    const storage = memoryFiles()

    await Promise.all([
      Bun.write(join(dir, '[section]/[page].kay'), '--- server\nconst { section, page } = ctx.params\n---\np.page {section} {page}\n'),
      Bun.write(join(dir, '[a]/[b]/[c].kay'), 'p.deep Deep\n'),
      Bun.write(join(dir, 'docs/[...rest].kay'), '--- server\nconst rest = ctx.params.rest\n---\np.docs {rest}\n'),
      Bun.write(join(dir, 'counter.kay'), '--- script\nimport { signal } from \'kay\'\n\nconst count = signal(0)\n---\nbutton(onClick={() => count.set(count() + 1)}) Clicked {count()}\n'),
    ])

    const app = new Elysia().use(await pages({ routes: dir, prebuilt: false, storage }))
    const client = (await readClient(process.cwd()))!
    const asset = (await readdir(client.dir)).find(file => file.endsWith('.js'))!
    const key = await files.put(new File(['hello'], 'hello.txt'))

    app.listen({ port: 0, hostname: 'localhost' })

    try {
      const paths = [`/_kay/${asset}`, `/_kay/files/${key}`, '/docs/intro', '/docs/a/b', '/guide/start', '/x/y/z']
      const answers = async (get: (path: string) => Promise<Response>) => Promise.all(paths.map(async (path) => {
        const response = await get(path)
        const text = await response.text()

        return [path, response.status, text.match(/<p class="(\w+)">([^<]*)/)?.slice(1).join(' ') ?? text.slice(0, 5)]
      }))
      const served = await answers(async path => fetch(`http://localhost:${app.server!.port}${path}`))

      expect(served).toEqual(await answers(async path => app.handle(new Request(`http://localhost${path}`))))
      expect(served.map(([path, status, text]) => [path, status, String(text).replace(/^[^ ]*$/, 'file')])).toEqual([
        [`/_kay/${asset}`, 200, 'file'],
        [`/_kay/files/${key}`, 200, 'file'],
        ['/docs/intro', 200, 'docs intro'],
        ['/docs/a/b', 200, 'docs a/b'],
        ['/guide/start', 200, 'page guide start'],
        ['/x/y/z', 200, 'deep Deep'],
      ])
    }
    finally {
      await app.stop()
    }
  }, 60_000)
})
