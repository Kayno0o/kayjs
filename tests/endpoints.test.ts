import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { pages } from '../src/server'
import { claimEndpoints } from '../src/server/endpoint-claims'
import { exportedEndpoints } from '../src/server/endpoints'
import { claimPublic } from '../src/server/public'
import { refuseClashes } from '../src/server/route-table'
import { scanEndpoints, scanRoutes } from '../src/server/routes'
import { ServedPaths } from '../src/server/served-paths'
import { parsingRoutes, routePaths } from './elysia'

const FIXTURE = 'tests/fixtures/endpoints'
const routes = resolve(FIXTURE, 'src/routes')
const app = await pages({ routes, publicDir: `${FIXTURE}/public`, prebuilt: false, security: false })

async function get(path: string, headers: Record<string, string> = {}) {
  const response = await app.handle(new Request(`http://localhost${path}`, { headers }))

  return { status: response.status, type: response.headers.get('content-type'), body: await response.text(), headers: response.headers }
}

async function scanned(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'kay-endpoints-'))

  await Promise.all(Object.entries(files).map(async ([name, text]) => Bun.write(join(dir, name), text)))

  try {
    return await scanEndpoints(dir)
  }
  finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('endpoint files', () => {
  it('serve what their GET returns at their path, a string typed by its extension', async () => {
    expect(await get('/llms.txt')).toMatchObject({ status: 200, type: 'text/plain;charset=utf-8', body: '# Site\n\nServed at /llms.txt\n' })
    expect((await get('/format')).status).toBe(404)
  })

  it('leave Elysia parsing no cookie, query or header for them', () => {
    expect(routePaths(app)).toContain('/llms.txt')
    expect(parsingRoutes(app)).toEqual([])
  })

  it('take their last param before its extension, a Response going out as it is and a Blob typed by the extension', async () => {
    const json = await get('/feeds/first.json')
    const xml = await get('/feeds/an%20entry.xml')

    expect([json.status, json.type, json.body, json.headers.get('cache-control')]).toEqual([200, 'application/json;charset=utf-8', '{"slug":"first"}', 'max-age=60'])
    expect([xml.status, xml.type, xml.body]).toEqual([200, 'application/xml', '<feed>an entry</feed>'])
    expect((await get('/feeds/first.csv')).status).toBe(404)
    expect((await get('/feeds/.json')).status).toBe(404)
  })

  it('run the guards of their directory first, what those set going out with the answer', async () => {
    expect(await get('/admin/export.csv')).toMatchObject({ status: 401, body: 'Sign in first' })

    const allowed = await get('/admin/export.csv', { authorization: 'Bearer x' })

    expect([allowed.status, allowed.type, allowed.body, allowed.headers.get('x-guarded')]).toEqual([200, 'text/csv;charset=utf-8', 'id,name\n1,Ada\n', 'yes'])
  })

  it('list the paths a static export writes them to, and what keeps one out', async () => {
    const endpoints = await scanEndpoints(routes)

    const { paths, problems } = await exportedEndpoints(process.cwd(), endpoints)

    expect(paths.toSorted()).toEqual(['/feeds/first.json', '/feeds/first.xml', '/feeds/second.json', '/llms.txt'])
    expect(problems).toEqual([`${FIXTURE}/src/routes/admin/export.csv.ts: a guard covers it, and only a server can run one per request`])
  })

  it('refuse a name the router cannot serve, a param it cannot fill, or a path a page or a public file serves', async () => {
    await expect(scanned({ '[...rest].json.ts': '' })).rejects.toThrow('each of its params is a plain [name] segment')
    await expect(scanned({ 'a[b].json.ts': '' })).rejects.toThrow('has a [, ], :, * or \' in its name outside a [name] param')

    const endpoints = await scanEndpoints(routes)
    const pages = await scanRoutes(routes)
    // Claimed as the server claims them: the pages, the public files, then the endpoints.
    const claimed = (claims: typeof endpoints, pageClaims: typeof pages, urls: string[]) => () => {
      const paths = new ServedPaths()

      refuseClashes(routes, pageClaims, paths)
      claimPublic(paths, urls.map(url => ({ path: url.slice(1), url })))
      claimEndpoints(paths, claims, process.cwd())
    }

    expect(claimed(endpoints, pages, ['/llms.txt'])).toThrow('llms.txt.ts and the public file /llms.txt both serve /llms.txt; drop one')
    expect(claimed(endpoints, [...pages, { ...pages[0]!, pattern: '/feeds/:id', file: 'feeds/[id].kay' }], [])).toThrow('feeds/[id].kay and ')
    expect(claimed([...endpoints, { ...endpoints.find(endpoint => endpoint.suffix === '.json')!, file: 'other.json.ts' }], pages, [])).toThrow('both serve /feeds/:slug.json')
  })
})
