import type { DevRequest, DevResponse, DevRoutes } from '../src/server/dev'
import { rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import process from 'node:process'
import { describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { pages } from '../src/server'
import { DEV_REQUEST, DEV_ROUTES } from '../src/server/dev'
import { redirectedBy } from '../src/server/dev-notes'
import { scratchDir } from './scratch'

const cli = join(import.meta.dir, '..', 'src', 'cli.ts')

describe('kay routes', () => {
  it('lists each route with the file serving it, its methods, layouts and guards, the prerendered pages, each locale\'s copy, the libraries\' and kay\'s own, in order', async () => {
    const root = await scratchDir('routes-')
    const config = [
      'import { Elysia } from \'elysia\'\n',
      'const lib = { name: \'lib\', api: { dir: \'lib/api\', prefix: \'lib\' }, server: new Elysia().get(\'/hooked\', () => 1) }',
      'const built = { name: \'built\', server: () => new Elysia() }\n',
      'export default { requireGuards: true, publicEnv: {}, extensions: [lib, built, { name: \'modular\', serverModule: { path: \'./plugin\' } }], i18n: { locales: [\'en\', \'fr\'], defaultLocale: \'en\', paths: { \'/about\': { fr: \'/a-propos\' } } }, redirects: { \'/old\': \'/\', \'/tmp\': { to: \'/\', permanent: false }, \'/gone\': { to: \'/\', status: 301 } } }\n',
    ]

    await Promise.all([
      Bun.write(join(root, 'kay.config.ts'), config.join('\n')),
      Bun.write(join(root, 'src/server.ts'), 'export {}\n'),
      Bun.write(join(root, 'src/routes/about.kay'), '--- server\nexport const page = { guards: false }\n---\nh1 About\n'),
      Bun.write(join(root, 'src/routes/items/[id=integer].kay'), '--- server\nconst ids = [{ id: 1 }]\n\nexport const page = { guards: false, prerender: ids }\n---\nh1 Item\n'),
      Bun.write(join(root, 'src/api/chat.ts'), 'import { Elysia } from \'elysia\'\n\nconsole.log(\'connecting\')\nconsole.debug(\'debugging\')\nconsole.dir({ ok: 1 })\nprocess.stdout.write(\'written\\n\')\n\nexport default new Elysia().ws(\'/\', { message() {} }).options(\'/\', () => \'\')\n'),
      Bun.write(join(root, 'src/api/exits.ts'), 'process.exit(7)\n'),
      Bun.write(join(root, 'lib/api/_guard.ts'), 'import { guard } from \'kay\'\n\nexport default guard(() => {})\n'),
      Bun.write(join(root, 'lib/api/session.ts'), 'import { Elysia } from \'elysia\'\n\nexport default new Elysia().get(\'/\', () => 1)\n'),
      Bun.write(join(root, 'src/routes/_layout.kay'), 'slot\n'),
      Bun.write(join(root, 'src/routes/index.kay'), '--- server\nimport { action } from \'kay/server\'\n\nexport const page = { guards: false }\nexport const add = action(() => {})\n---\nh1 Home\n'),
      Bun.write(join(root, 'src/routes/admin/_guard.ts'), 'import { guard } from \'kay\'\n\nexport default guard(() => {})\n'),
      Bun.write(join(root, 'src/routes/admin/report.kay'), '--- server\nexport const page = { prerender: true }\n---\nh1 Report\n'),
      Bun.write(join(root, 'src/routes/posts/[slug].kay'), 'h1 Post\n'),
      Bun.write(join(root, 'src/routes/llms.txt.ts'), 'export function GET() {\n  return \'hi\'\n}\n'),
      Bun.write(join(root, 'src/api/items.ts'), 'import { Elysia } from \'elysia\'\nimport { api } from \'kay/server\'\n\napi({ guards: false })\n\nexport default new Elysia().get(\'/\', () => []).post(\'/:id\', () => 1)\n'),
      Bun.write(join(root, 'src/api/broken.ts'), 'throw new Error(\'no database\')\n'),
      Bun.write(join(root, 'src/api/Status.ts'), 'import { Elysia } from \'elysia\'\n\nexport default new Elysia().get(\'/\', () => \'ok\')\n'),
      Bun.write(join(root, 'src/routes/greet.kay'), '--- server\nimport Hello from \'../components/hello.kay\'\n\nexport const page = { guards: false }\n---\nHello(server)\n'),
      Bun.write(join(root, 'src/components/hello.kay'), 'p Hi\n'),
    ])

    try {
      const child = Bun.spawn([process.execPath, cli, 'routes'], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
      const [listing, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      const lines = listing.trim().split('\n').map(line => line.trim().replaceAll(/ {2,}/g, ' | '))

      expect(errors).toBe('connecting\ndebugging\n{ ok: 1 }\nwritten\n')
      expect(code).toBe(0)
      expect(lines).toEqual([
        'GET | /about | page | src/routes/about.kay, en, open',
        'layouts src/routes/_layout.kay',
        'GET | /fr/a-propos | page | src/routes/about.kay, fr, open',
        'GET | /admin/report | page | src/routes/admin/report.kay, en, prerendered',
        'layouts src/routes/_layout.kay',
        'guards | src/routes/admin/_guard.ts',
        'GET | /fr/admin/report | page | src/routes/admin/report.kay, fr, prerendered',
        'GET | /greet | page | src/routes/greet.kay, en, prerendered, open',
        'layouts src/routes/_layout.kay',
        'GET | /fr/greet | page | src/routes/greet.kay, fr, prerendered, open',
        'GET | / | page | src/routes/index.kay, en, open',
        'layouts src/routes/_layout.kay',
        'GET | /fr | page | src/routes/index.kay, fr, open',
        'POST | /_kay/action/src/routes/index.kay/add | action | src/routes/index.kay add',
        'GET | /items/:id=integer | page | src/routes/items/[id=integer].kay, en, prerendered as its prerender setting lists, open',
        'layouts src/routes/_layout.kay',
        'GET | /fr/items/:id=integer | page | src/routes/items/[id=integer].kay, fr, prerendered as its prerender setting lists, open',
        'GET | /posts/:slug | page | src/routes/posts/[slug].kay, en, 403: no guard under requireGuards',
        'layouts src/routes/_layout.kay',
        'GET | /fr/posts/:slug | page | src/routes/posts/[slug].kay, fr, 403: no guard under requireGuards',
        'GET | /llms.txt | endpoint | src/routes/llms.txt.ts, 403: no guard under requireGuards',
        'GET | /api/lib/session | api | lib/api/session.ts',
        'guards | lib/api/_guard.ts',
        'GET | /api/Status | api | src/api/Status.ts, 403: no guard under requireGuards',
        '? | /api/broken/* | api | src/api/broken.ts, not loaded: no database, 403: no guard under requireGuards',
        'WS | /api/chat | api | src/api/chat.ts, 403: no guard under requireGuards',
        'OPTIONS | /api/chat | api | src/api/chat.ts, 403: no guard under requireGuards',
        '? | /api/exits/* | api | src/api/exits.ts, not loaded: it calls process.exit(7), 403: no guard under requireGuards',
        'GET | /api/items | api | src/api/items.ts, open',
        'POST | /api/items/:id | api | src/api/items.ts, open',
        'GET | /hooked | plugin | the extension lib',
        'GET | /old | redirect | 308 to /',
        'GET | /tmp | redirect | 307 to /',
        'GET | /gone | redirect | 301 to /',
        'GET | /_kay/health | kay | health check',
        'GET | /_kay/env.js | kay | public environment',
        'GET | /_kay/* | kay | build files',
        'GET | /_kay/image | kay | image variants',
        'GET | /_kay/card | kay | share cards',
        'GET | /_kay/files/* | kay | stored files',
        'POST | /_kay/error | kay | browser error reports',
        'POST | /_kay/live | kay | live values',
        'GET | /favicon.ico | kay | favicon, unless the app serves it',
        'GET | /apple-touch-icon.png | kay | favicon, unless the app serves it',
        'GET | /icon-192.png | kay | favicon, unless the app serves it',
        'GET | /icon-512.png | kay | favicon, unless the app serves it',
        'GET | /manifest.webmanifest | kay | favicon, unless the app serves it',
        'GET | /favicon.svg | kay | favicon, unless the app serves it',
        'GET | /sw.js | kay | service worker',
        '',
        'Not listed: the routes src/server.ts and the extension built\'s server plugin and the extension modular\'s server plugin add when the server starts.',
      ])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('lists a page once per locale\'s host with domains', async () => {
    const root = await scratchDir('routes-domains-')

    await Promise.all([
      Bun.write(join(root, 'kay.config.ts'), 'export default { i18n: { locales: [\'en\', \'fr\'], defaultLocale: \'en\', domains: { en: \'example.com\', fr: \'example.fr\' }, paths: { \'/about\': { fr: \'/a-propos\' } } } }\n'),
      Bun.write(join(root, 'src/routes/about.kay'), 'h1 About\n'),
    ])

    try {
      const child = Bun.spawn([process.execPath, cli, 'routes'], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
      const [listing, code] = await Promise.all([new Response(child.stdout).text(), child.exited])

      expect(code).toBe(0)
      expect(listing.split('\n').slice(0, 2).map(line => line.trim().replaceAll(/ {2,}/g, ' | '))).toEqual([
        'GET | /about | page | src/routes/about.kay, en at example.com',
        'GET | /a-propos | page | src/routes/about.kay, fr at example.fr',
      ])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})

const REQUEST_BLOCK = /<script type="application\/json" id="kay-dev-request">(.*?)<\/script>/

// A site with a layout, a page of params, a page that fails, an endpoint and an API module, its paths from where tests run.
async function site() {
  const dir = await scratchDir('dev-routes-')
  const routes = join(dir, 'routes')
  const api = join(dir, 'api')

  await Promise.all([
    Bun.write(join(routes, '_layout.kay'), '--- server\nconst site = \'Shop\'\n---\nmain\n  slot\n'),
    Bun.write(join(routes, 'index.kay'), 'p Home\n'),
    Bun.write(join(routes, 'items/[id].kay'), '--- server\nawait Bun.sleep(5)\nconst id = ctx.params.id\n---\np {id}\n'),
    Bun.write(join(routes, 'broken.kay'), '--- server\nthrow new Error(\'No stock\')\n---\np Never\n'),
    Bun.write(join(routes, '_error.kay'), 'p Failed\n'),
    Bun.write(join(routes, 'llms.txt.ts'), 'export function GET() {\n  return \'# Shop\'\n}\n'),
    Bun.write(join(api, 'stock.ts'), 'import { api } from \'kay/server\'\n\nexport default api().get(\'/\', () => []).post(\'/:id\', () => null)\n'),
  ])

  return { routes: relative(process.cwd(), routes), api: relative(process.cwd(), api) }
}

describe('the dev tool\'s data', () => {
  it('says in each dev page what served it: the route, the files, the params and how long each load took, the failed route\'s on its error page', async () => {
    const { routes, api } = await site()
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const dev = await pages({ routes, api, dev: true })
      const request = async (path: string) => {
        const html = await (await dev.handle(new Request(`http://localhost${path}`))).text()

        return JSON.parse(REQUEST_BLOCK.exec(html)![1]!) as DevRequest
      }

      const item = await request('/items/a%3C1')

      expect(item).toMatchObject({ route: '/items/:id', page: `${routes}/items/[id].kay`, layouts: [`${routes}/_layout.kay`], params: { id: 'a<1' }, locale: 'en', status: 200 })
      expect(item.loads.map(load => load.file)).toEqual([`${routes}/_layout.kay`, `${routes}/items/[id].kay`])
      expect(item.loads[1]!.ms).toBeGreaterThanOrEqual(4)

      expect(await request('/broken')).toMatchObject({ route: '/broken', page: `${routes}/_error.kay`, status: 500, error: 'No stock', loads: [{ file: `${routes}/_layout.kay` }, { file: `${routes}/broken.kay` }] })
      expect(await request('/nowhere')).toMatchObject({ page: `${routes}/_error.kay`, status: 404, loads: [] })
      expect((await request('/nowhere')).route).toBeUndefined()

      const listed = await (await dev.handle(new Request(`http://localhost${DEV_ROUTES}`))).json() as DevRoutes

      expect(listed.routes.filter(route => route.kind !== 'kay').map(route => `${route.kind} ${route.method} ${route.path} ${route.file} ${route.href ?? '-'}`).toSorted()).toEqual([
        `api GET /api/stock ${api}/stock.ts /api/stock`,
        `api POST /api/stock/:id ${api}/stock.ts -`,
        `endpoint GET /llms.txt ${routes}/llms.txt.ts /llms.txt`,
        `page GET / ${routes}/index.kay /`,
        `page GET /broken ${routes}/broken.kay /broken`,
        `page GET /items/:id ${routes}/items/[id].kay -`,
      ])

      // An app sending no `Server-Timing` still sees its loads timed in the dev tool.
      const untimed = await pages({ routes, api, dev: true, serverTiming: false })
      const response = await untimed.handle(new Request('http://localhost/items/1'))

      expect(response.headers.has('server-timing')).toBe(false)
      expect((JSON.parse(REQUEST_BLOCK.exec(await response.text())![1]!) as DevRequest).loads[1]!.ms).toBeGreaterThanOrEqual(4)

      const served = await pages({ routes, api })

      expect(await (await served.handle(new Request('http://localhost/items/1'))).text()).not.toContain('kay-dev-request')
      expect((await served.handle(new Request(`http://localhost${DEV_ROUTES}`))).status).toBe(404)
    }
    finally {
      logged.mockRestore()
    }
  })
})

const CONTENT = 'tests/fixtures/content'
const FAVICON = 'tests/fixtures/seo/src/favicon.png'

async function listedBy(options: Parameters<typeof pages>[0]): Promise<DevRoutes> {
  const dev = await pages({ prebuilt: false, security: false, dev: true, ...options })

  return await (await dev.handle(new Request(`http://localhost${DEV_ROUTES}`))).json() as DevRoutes
}

describe('the dev tool\'s routes served by kay', () => {
  it('lists the sitemap, robots.txt, a feed, the manifest and a library\'s pages, each GET path linked', async () => {
    const library = new Elysia().get('/_kay/lib', () => 'lib').post('/_kay/lib/clear', () => 'cleared')
    const { routes, notes } = await listedBy({
      routes: `${CONTENT}/src/routes`,
      content: `${CONTENT}/src/content.config.ts`,
      site: 'https://blog.example',
      favicon: FAVICON,
      seo: { name: 'Blog' },
      manifest: { shortName: 'Blog' },
      extensions: [{ name: 'kayjs-lib', server: library }],
    })
    const kay = routes.filter(route => route.kind === 'kay')
    const at = (path: string) => kay.find(route => route.path === path)

    expect(notes).toEqual([])
    expect(at('/sitemap.xml')).toMatchObject({ method: 'GET', file: '', owner: 'the sitemap', href: '/sitemap.xml' })
    expect(at('/robots.txt')).toMatchObject({ owner: 'robots.txt', href: '/robots.txt' })
    expect(at('/manifest.webmanifest')).toMatchObject({ owner: 'the web app manifest', href: '/manifest.webmanifest' })
    expect(kay.filter(route => route.owner?.startsWith('the feed of the collection ')).length).toBeGreaterThan(0)
    expect(at('/_kay/health')).toMatchObject({ owner: 'the health check' })
    expect(at('/_kay/lib')).toMatchObject({ owner: 'the extension kayjs-lib', href: '/_kay/lib' })
    expect(at('/_kay/lib/clear')).toBeUndefined()
    expect(kay.every(route => route.method === 'GET' && route.href !== undefined)).toBe(true)
  })

  it('lists a path an app file took over as the app\'s, not kay\'s', async () => {
    const dir = await scratchDir('dev-routes-own-')

    await Bun.write(join(dir, 'routes/index.kay'), 'p Home\n')
    await Bun.write(join(dir, 'routes/robots.txt.ts'), 'export function GET() {\n  return \'User-agent: *\'\n}\n')

    const { routes } = await listedBy({ routes: relative(process.cwd(), join(dir, 'routes')), site: 'https://x.example' })

    expect(routes.filter(route => route.path === '/robots.txt').map(route => route.kind)).toEqual(['endpoint'])
    expect(routes.find(route => route.path === '/sitemap.xml')?.kind).toBe('kay')
  })

  it('says why there is no sitemap or robots.txt when `seo` is set with no origin, and nothing when there is one', async () => {
    const dir = await scratchDir('dev-routes-origin-')
    const routes = relative(process.cwd(), join(dir, 'routes'))

    await Bun.write(join(dir, 'routes/index.kay'), 'p Home\n')

    const without = await listedBy({ routes, seo: { name: 'Shop' } })

    expect(without.notes).toHaveLength(1)
    expect(without.notes[0]).toContain('no sitemap or robots.txt')
    expect(without.routes.some(route => route.path === '/sitemap.xml')).toBe(false)
    expect((await listedBy({ routes, seo: { name: 'Shop' }, site: 'https://shop.example' })).notes).toEqual([])
    expect((await listedBy({ routes })).notes).toEqual([])
  })

  it('answers a path the Routes tab lists as the app\'s with the app\'s route, not the health check', async () => {
    const dir = await scratchDir('dev-routes-health-')
    const routes = relative(process.cwd(), join(dir, 'routes'))

    await Bun.write(join(dir, 'routes/index.kay'), 'p Home\n')
    await Bun.write(join(dir, 'routes/health.kay'), 'p Mine\n')
    await Bun.write(join(dir, 'routes/up.txt.ts'), 'export function GET() {\n  return \'mine\'\n}\n')

    const own = await pages({ routes, dev: true, health: { path: '/health' } })
    const listed = (await (await own.handle(new Request(`http://localhost${DEV_ROUTES}`))).json() as DevRoutes).routes

    expect(listed.filter(route => route.path === '/health').map(route => route.kind)).toEqual(['page'])
    expect(await (await own.handle(new Request('http://localhost/health'))).text()).toContain('Mine')

    const endpoint = await pages({ routes, dev: true, health: { path: '/up.txt' } })

    expect(await (await endpoint.handle(new Request('http://localhost/up.txt'))).text()).toBe('mine')

    const custom = await pages({ routes, dev: true, health: { path: '/ping' } })
    const standard = await pages({ routes, dev: true })

    expect((await custom.handle(new Request('http://localhost/ping'))).status).toBe(200)
    expect((await standard.handle(new Request('http://localhost/_kay/health'))).status).toBe(200)
  })

  it('says how a page was answered: the guards that ran and their outcome, a redirect before it, what `kay build` does with it, the headers and the time', async () => {
    const dir = await scratchDir('dev-routes-answered-')
    const routes = relative(process.cwd(), join(dir, 'routes'))
    const members = 'import { guard } from \'kay\'\n\nexport default guard(({ request, redirect, deny }) => {\n  if (request.headers.has(\'x-banned\'))\n    deny(403)\n\n  if (!request.headers.has(\'x-member\'))\n    redirect(\'/login\')\n})\n'
    const vip = 'import { guard } from \'kay\'\n\nexport default guard(({ request, deny }) => {\n  if (!request.headers.has(\'x-vip\'))\n    deny(403, \'VIPs only\')\n})\n'

    await Promise.all([
      Bun.write(join(dir, 'routes/index.kay'), 'p Home\n'),
      Bun.write(join(dir, 'routes/login.kay'), 'p Login\n'),
      Bun.write(join(dir, 'routes/_error.kay'), 'p Failed\n'),
      Bun.write(join(dir, 'routes/static.kay'), '--- server\nexport const page = { prerender: true }\n---\np Static\n'),
      Bun.write(join(dir, 'routes/cookie.kay'), '--- server\nctx.cookies.set(\'sid\', \'secret\')\n---\np Cookie\n'),
      Bun.write(join(dir, 'routes/members/_guard.ts'), members),
      Bun.write(join(dir, 'routes/members/index.kay'), 'p Members\n'),
      Bun.write(join(dir, 'routes/members/vip/_guard.ts'), vip),
      Bun.write(join(dir, 'routes/members/vip/index.kay'), 'p VIP\n'),
    ])

    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const dev = await pages({ routes, dev: true, redirects: { '/old': '/static', '/away': 'https://other.example/static' } })
      const visit = async (path: string, headers: Record<string, string> = {}) => {
        const response = await dev.handle(new Request(`http://localhost${path}`, { headers, redirect: 'manual' }))
        const block = REQUEST_BLOCK.exec(await response.text())

        return { response, request: block ? JSON.parse(block[1]!) as DevRequest : undefined }
      }
      const recorded = async (id: string) => (await dev.handle(new Request(`http://localhost${DEV_REQUEST}?id=${id}`, { headers: { 'x-kay-dev': '1' } }))).json() as Promise<DevResponse>

      expect((await visit('/')).request).toMatchObject({ guards: [] })
      expect((await visit('/static')).request).toMatchObject({ prerender: 'page' })
      expect((await visit('/login')).request!.prerender).toBeUndefined()
      expect((await visit('/members/vip')).request).toBeUndefined()
      expect((await visit('/members/vip', { 'x-banned': '1' })).request).toMatchObject({ status: 403, guards: [{ outcome: expect.stringContaining('denied with 403') }, { outcome: 'did not run' }] })
      expect((await visit('/members/vip', { 'x-member': '1', 'x-vip': '1' })).request).toMatchObject({ guards: [{ outcome: 'passed' }, { outcome: 'passed' }] })
      const member = await visit('/members', { 'x-member': '1' })

      expect(member.request).toMatchObject({ guards: [{ file: `${routes}/members/_guard.ts`, outcome: 'passed' }] })
      // The dev tool reads the phases off the `Server-Timing` header the server recorded.
      expect(Object.fromEntries((await recorded(member.request!.id)).headers)['server-timing']).toMatch(/^guards;dur=\d+\.\d, import;dur=\d+\.\d, loads;dur=\d+\.\d, (?:\S+, )*render;dur=\d+\.\d$/)
      expect((await visit('/members/vip', { 'x-member': '1' })).request).toMatchObject({ status: 403, guards: [{ outcome: 'passed' }, { file: `${routes}/members/vip/_guard.ts`, outcome: 'denied with 403: VIPs only' }] })

      // A guard that redirects: the page it sends the visitor to knows where they came from, and by which guard.
      const refused = await visit('/members')

      expect(refused.response.status).toBeGreaterThanOrEqual(300)
      expect(refused.request).toBeUndefined()

      const login = await visit('/login')
      const answered = await recorded(login.request!.id)

      expect(answered.redirects).toEqual([{ from: '/members', status: refused.response.status, by: `the guard ${routes}/members/_guard.ts` }])
      expect(answered.ms).toBeGreaterThan(0)
      expect(answered.headers.map(([name]) => name)).toContain('x-request-id')

      // The redirect is told once, to the request that follows it.
      expect((await recorded((await visit('/login')).request!.id)).redirects).toEqual([])

      // A setting redirect, then the page.
      await visit('/old')

      expect((await recorded((await visit('/static')).request!.id)).redirects).toEqual([{ from: '/old', status: 308, by: 'the redirect from /old' }])
      // A redirect to another site leads to no page of this one, and a cookie's value stays out of the record.
      await visit('/away')

      expect((await recorded((await visit('/static')).request!.id)).redirects).toEqual([])

      const cookie = await recorded((await visit('/cookie')).request!.id)

      expect(cookie.headers.filter(([name]) => name === 'set-cookie').map(([, value]) => value.slice(0, value.indexOf(';')))).toEqual(['sid=...'])
      expect(cookie.headers.map(([name]) => name)).toContain('content-security-policy')
      expect(cookie.headers.map(([name]) => name)).toContain('cache-control')

      expect((await dev.handle(new Request(`http://localhost${DEV_REQUEST}?id=nothing`, { headers: { 'x-kay-dev': '1' } }))).status).toBe(404)
      expect((await dev.handle(new Request(`http://localhost${DEV_REQUEST}?id=nothing`))).status).toBe(403)
    }
    finally {
      logged.mockRestore()
    }
  })

  it('notes no redirect in a production server, and answers the health check past an extension\'s global hooks', async () => {
    const dir = await scratchDir('dev-routes-production-')
    const routes = relative(process.cwd(), join(dir, 'routes'))
    const guarded = 'import { guard } from \'kay\'\n\nexport default guard(({ redirect }) => {\n  redirect(\'/login\')\n})\n'

    await Promise.all([
      Bun.write(join(dir, 'routes/index.kay'), 'p Home\n'),
      Bun.write(join(dir, 'routes/login.kay'), 'p Login\n'),
      Bun.write(join(dir, 'routes/members/_guard.ts'), guarded),
      Bun.write(join(dir, 'routes/members/index.kay'), 'p Members\n'),
    ])

    // A global hook refusing a request to the health route, as an auth extension's would the routes after it.
    const closed = new Elysia().onBeforeHandle({ as: 'global' }, ({ request }) => new URL(request.url).pathname === '/_kay/health' ? new Response('closed', { status: 401 }) : undefined)
    const settings = { routes, redirects: { '/old': '/login' }, trailingSlash: 'never' as const }
    const outcomes = async (dev: boolean, extensions: NonNullable<Parameters<typeof pages>[0]>['extensions'] = []) => {
      const app = await pages({ ...settings, dev, extensions })
      const noted: (string | undefined)[] = []

      for (const path of ['/old', '/login/', '/members']) {
        const request = new Request(`http://localhost${path}`, { redirect: 'manual' })

        await app.handle(request)
        noted.push(redirectedBy(request))
      }

      return { noted, health: (await app.handle(new Request('http://localhost/_kay/health'))).status }
    }

    expect((await outcomes(false)).noted).toEqual([undefined, undefined, undefined])
    expect((await outcomes(true)).noted[0]).toBe('the redirect from /old')
    expect((await outcomes(true)).noted[2]).toBe(`the guard ${routes}/members/_guard.ts`)
    expect((await (await pages({ ...settings, extensions: [{ name: 'closed', server: closed }] })).handle(new Request('http://localhost/_kay/health/'))).status).toBe(200)
    expect((await outcomes(false, [{ name: 'closed', server: closed }])).health).toBe(200)
    expect((await outcomes(true, [{ name: 'closed', server: closed }])).health).toBe(200)
  })
})

describe('the dev tool\'s i18n tab data', () => {
  const MESSAGES = 'tests/fixtures/layout-query/src/messages'

  it('lists the page in each locale under the base and the locale paths, and leaves a site without i18n, or with one locale, out', async () => {
    const { routes } = await site()
    const request = async (options: Parameters<typeof pages>[0], path: string) => {
      const dev = await pages({ routes, dev: true, security: false, ...options })
      const html = await (await dev.handle(new Request(`http://localhost${path}`))).text()

      return JSON.parse(REQUEST_BLOCK.exec(html)![1]!) as DevRequest
    }
    const i18n = { locales: ['en', 'fr'], defaultLocale: 'en', messages: MESSAGES }

    expect((await request({ i18n }, '/'))).toMatchObject({ locale: 'en', locales: [{ locale: 'en', href: '/' }, { locale: 'fr', href: '/fr' }] })
    expect((await request({ i18n }, '/fr/broken')).locales).toEqual([{ locale: 'en', href: '/broken' }, { locale: 'fr', href: '/fr/broken' }])
    expect((await request({ i18n, base: '/shop' }, '/')).locales).toEqual([{ locale: 'en', href: '/shop/' }, { locale: 'fr', href: '/shop/fr' }])
    expect((await request({ i18n: { ...i18n, domains: { en: 'example.com', fr: 'example.fr' } } }, '/')).locales).toEqual([{ locale: 'en', href: '//example.com/' }, { locale: 'fr', href: '//example.fr/' }])
    expect((await request({}, '/')).locales).toBeUndefined()
    expect((await request({ i18n: { locales: ['en'], defaultLocale: 'en', messages: MESSAGES } }, '/')).locales).toBeUndefined()
  })
})
