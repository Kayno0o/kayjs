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

    expect(match.posted(org, '/orgs/acme')).toEqual({ params: { org: 'acme' }, path: '/orgs/acme' })
    expect(match.posted(org, '/fr/organisations/acme/')).toEqual({ params: { org: 'acme' }, path: '/fr/organisations/acme' })
    expect(match.posted(org, '/fr/orgs/acme')).toEqual({ params: { org: 'acme' }, path: undefined })
    expect(match.posted(about, '/%61bout')).toEqual({ params: {}, path: '/about' })
    expect(match.posted(about, '/orgs/acme')).toBeUndefined()
    expect(match.served(org)).toBe('/orgs/:org')

    const prefixed = routeMatch(routeTable([about], localeSettings({ locales: ['en', 'fr'], defaultLocale: 'en', prefixDefault: true })), new Map())

    expect(prefixed.posted(about, '/about')).toEqual({ params: {}, path: undefined })
    expect(prefixed.posted(about, '/en/about')).toEqual({ params: {}, path: '/en/about' })
    expect(prefixed.served(about)).toBe('/en/about')

    const rest = served('[...path].kay')
    const caught = routeMatch(routeTable([rest], localeSettings({ locales: ['en', 'fr'], defaultLocale: 'en', prefixDefault: true })), new Map())

    expect(caught.posted(rest, '/en/docs/x')).toEqual({ params: { path: 'docs/x' }, path: '/en/docs/x' })
  })

  it('tries the pages a matcher checks before the one without, then by file path in UTF-16 code unit order, upper case first', () => {
    const plain = served('items/[id].kay')
    const even = served('items/[id=even].kay')
    const admin = served('(admin)/items/[id=odd].kay')
    const site = served('(Site)/items/[id=prime].kay')
    const table = routeTable([plain, admin, even, site], undefined)

    expect(table.paths.get('/items/:p2')!.get(undefined)!.candidates.map(candidate => candidate.route)).toEqual([site, admin, even, plain])
  })
})

describe('pageResponder', () => {
  const root = process.cwd()
  const built = (path: string): Map<string, ServedPage> => new Map([[path, { html: '<p>Built</p>', encoded: {}, headers: [], status: 200, etag: '"built"', renderedAt: Date.now() }]])

  it('serves the copy kay build rendered, and renders afresh for a visitor coming back from a form post, kept by no cache', async () => {
    // Boots the site, which builds the browser bundle the responder reads.
    await pages({ routes: 'tests/fixtures/site/src/routes', prebuilt: false })
    const about = { ...(await scanRoutes(join(root, 'tests/fixtures/site/src/routes'))).find(route => route.pattern === '/about')!, guards: [] }
    const respond = pageResponder({ client: (await readClient(root))!, renderOptions: {}, prerendered: new Map([['/about', built('/about')]]), settings: undefined, transforms: [], pageFile: async () => undefined, writes: { count: 0 } })
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
    const respond = pageResponder({ client, renderOptions: { base: '/b', head }, prerendered: new Map([['/vip', built('/vip')], ['/gone', built('/gone')]]), settings: undefined, transforms: [], pageFile: async () => undefined, writes: { count: 0 } })

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
  it('serves kay\'s files, catch-all pages, redirects and API routes ending in * where a page of params would take them from Bun\'s router, as app.handle() does', async () => {
    const dir = await scratchDir('wildcards-')
    const storage = memoryFiles()
    const routes = join(dir, 'routes')

    await Promise.all([
      Bun.write(join(routes, '[section]/[page].kay'), '--- server\nconst { section, page } = ctx.params\n---\np.page {section} {page}\n'),
      Bun.write(join(routes, '[a]/[b]/[c].kay'), 'p.deep Deep\n'),
      Bun.write(join(routes, 'docs/[...rest].kay'), '--- server\nconst rest = ctx.params.rest\n---\np.docs {rest}\n'),
      Bun.write(join(routes, '[z]/files/[...q].kay'), '--- server\nconst q = ctx.params.q\n---\np.files {q}\n'),
      Bun.write(join(routes, 'counter.kay'), '--- script\nimport { signal } from \'kay\'\n\nconst count = signal(0)\n---\nbutton(onClick={() => count.set(count() + 1)}) Clicked {count()}\n'),
      Bun.write(join(dir, 'api/_guard.ts'), 'import { guard } from \'kay\'\n\nexport default guard(({ request, deny }) => {\n  if (!request.headers.has(\'x-admin\'))\n    deny(401, \'Admins only\')\n})\n'),
      Bun.write(join(dir, 'api/files.ts'), 'import { api } from \'kay/server\'\n\nexport default api().get(\'/*\', ({ params }) => \'<p class="api">\' + params[\'*\'])\n'),
    ])

    const app = new Elysia().use(await pages({ routes, api: join(dir, 'api'), redirects: { '/old/*': '/new/*' }, prebuilt: false, storage }))
    const client = (await readClient(process.cwd()))!
    const asset = (await readdir(client.dir)).find(file => file.endsWith('.js'))!
    const key = await files.put(new File(['hello'], 'hello.txt'))

    app.listen({ port: 0, hostname: 'localhost' })

    try {
      const admin = { headers: { 'x-admin': '1' } }
      const requests: [string, RequestInit?][] = [[`/_kay/${asset}`], [`/_kay/files/${key}`], ['/docs/intro'], ['/docs/a/b'], ['/guide/start'], ['/x/y/z'], ['/blog/files/a'], ['/old/x/y'], ['/old/x/y', { method: 'HEAD' }], ['/api/files/x'], ['/api/files/x', admin]]
      const answers = async (get: (path: string, init?: RequestInit) => Promise<Response>) => Promise.all(requests.map(async ([path, init]) => {
        const response = await get(path, init)
        const text = await response.text()

        return [`${init?.method ?? 'GET'} ${path}`, response.status, response.headers.get('location') ?? text.match(/<p class="(\w+)">([^<]*)/)?.slice(1).join(' ') ?? text.slice(0, 12)]
      }))
      const served = await answers(async (path, init) => fetch(`http://localhost:${app.server!.port}${path}`, { ...init, redirect: 'manual' }))

      expect(served).toEqual(await answers(async (path, init) => app.handle(new Request(`http://localhost${path}`, init))))
      expect(served.map(([path, status, text]) => [path, status, String(path).startsWith('GET /_kay/') ? 'file' : text])).toEqual([
        [`GET /_kay/${asset}`, 200, 'file'],
        [`GET /_kay/files/${key}`, 200, 'file'],
        ['GET /docs/intro', 200, 'docs intro'],
        ['GET /docs/a/b', 200, 'docs a/b'],
        ['GET /guide/start', 200, 'page guide start'],
        ['GET /x/y/z', 200, 'deep Deep'],
        ['GET /blog/files/a', 200, 'files a'],
        ['GET /old/x/y', 308, '/new/x/y'],
        ['HEAD /old/x/y', 308, '/new/x/y'],
        ['GET /api/files/x', 401, 'Admins only'],
        ['GET /api/files/x', 200, 'api x'],
      ])
    }
    finally {
      await app.stop()
    }
  }, 60_000)

  it('keeps the methods an app names in its own serve.routes for a path a route ending in * wins', async () => {
    const dir = await scratchDir('wildcards-serve-')
    const routes = join(dir, 'routes')

    await Bun.write(join(routes, '[section]/[page].kay'), 'p.page Page\n')

    // kay registers a page of params as `/:p1/:p2`.
    const own = { '/:p1/:p2': { POST: new Response('posted') } }
    const app = new Elysia({ serve: { routes: own } as never }).use(await pages({ routes, redirects: { '/old/*': '/new/*' }, prebuilt: false, storage: memoryFiles() }))

    app.listen({ port: 0, hostname: 'localhost' })

    try {
      const url = `http://localhost:${app.server!.port}/old/x`
      const read = await fetch(url, { redirect: 'manual' })
      const post = await fetch(url, { method: 'POST' })

      expect([read.status, read.headers.get('location'), post.status, await post.text()]).toEqual([308, '/new/x', 200, 'posted'])
    }
    finally {
      await app.stop()
    }
  }, 60_000)
})
