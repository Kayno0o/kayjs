import type { DevRequest, DevRoute } from '../src/server/dev'
import { join, relative } from 'node:path'
import process from 'node:process'
import { describe, expect, it, spyOn } from 'bun:test'
import { pages } from '../src/server'
import { DEV_ROUTES } from '../src/server/dev'
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

      const listed = await (await dev.handle(new Request(`http://localhost${DEV_ROUTES}`))).json() as DevRoute[]

      expect(listed.map(route => `${route.kind} ${route.method} ${route.path} ${route.file} ${route.href ?? '-'}`).toSorted()).toEqual([
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
