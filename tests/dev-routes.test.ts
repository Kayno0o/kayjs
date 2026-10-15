import type { DevRequest, DevResponse, DevRoutes } from '../src/server/dev'
import { join, relative } from 'node:path'
import process from 'node:process'
import { describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { pages } from '../src/server'
import { DEV_REQUEST, DEV_ROUTES } from '../src/server/dev'
import { scratchDir } from './scratch'

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
      expect((await visit('/members', { 'x-member': '1' })).request).toMatchObject({ guards: [{ file: `${routes}/members/_guard.ts`, outcome: 'passed' }] })
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
})
