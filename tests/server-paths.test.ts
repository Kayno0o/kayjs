import { afterAll, describe, expect, it } from 'bun:test'
import { pages } from '../src/server'
import { testSite } from '../src/test'

const routes = 'tests/fixtures/mcp/src/routes'
const api = 'tests/fixtures/mcp/src/api'
const KEY = { 'x-key': 'open' }
const locals = (request: Request) => ({ key: request.headers.get('x-key') ?? undefined })
const settings = { routes, api, islands: false, locals, mcp: { path: '/tools' }, openapi: { path: '/spec.json', reference: true, referencePath: '/docs/api' } }

const root = await testSite(settings)
const mounted = await testSite({ ...settings, base: '/shop', trailingSlash: 'always' })
const defaults = await testSite({ routes, api, islands: false, locals, mcp: true, openapi: { reference: true } })

afterAll(async () => {
  await Promise.all([root.close(), mounted.close(), defaults.close()])
})

describe.each([['at the root', root], ['behind a base and a trailing slash', mounted]] as const)('the OpenAPI and MCP paths %s', (_name, site) => {
  it('serves the document and the reference page where the config says', async () => {
    const document = await site.fetch('/spec.json', { headers: KEY })

    expect(document.status).toBe(200)
    expect(Object.keys((await document.json() as { paths: object }).paths)).toContain('/api/notes')

    const reference = await site.fetch('/docs/api', { headers: KEY })

    expect(reference.status).toBe(200)
    // The link reaches the document from where the page is served.
    expect(await reference.text()).toContain('href="../spec.json"')
  })

  it('serves nothing at the default paths', async () => {
    expect((await site.fetch('/api/openapi.json', { headers: KEY })).status).toBe(404)
    expect((await site.fetch('/api/reference', { headers: KEY })).status).toBe(404)
    expect((await site.fetch('/mcp', { method: 'POST', headers: { ...KEY, 'content-type': 'application/json' }, body: '{}' })).status).toBe(404)
  })

  it('serves the tools at the MCP path alone', async () => {
    const tools = await site.mcp.tools({ headers: KEY })

    expect(tools.length).toBeGreaterThan(0)
    expect((await site.fetch('/tools', { method: 'GET' })).status).toBe(405)
  })
})

describe('the default paths', () => {
  it('stay when the config names none', async () => {
    expect((await defaults.fetch('/api/openapi.json', { headers: KEY })).status).toBe(200)
    expect((await defaults.fetch('/api/reference', { headers: KEY })).status).toBe(200)
    expect((await defaults.fetch('/mcp', { method: 'GET' })).status).toBe(405)
  })
})

describe('a path that cannot be served', () => {
  const boot = async (extra: object) => pages({ routes, api, prebuilt: false, security: false, ...extra })

  it.each([
    ['mcp', { mcp: { path: 'tools' } }, 'mcp({ path })'],
    ['mcp', { mcp: { path: '' } }, 'mcp({ path })'],
    ['mcp', { mcp: { path: '/' } }, 'mcp({ path })'],
    ['mcp', { mcp: { path: '/tools/' } }, 'mcp({ path })'],
    ['mcp', { mcp: { path: '/a/:id' } }, 'mcp({ path })'],
    ['mcp', { mcp: { path: '/a/*' } }, 'mcp({ path })'],
    ['mcp', { mcp: { path: '/a//b' } }, 'mcp({ path })'],
    ['mcp', { mcp: { path: '/a/../b' } }, 'mcp({ path })'],
    ['mcp', { mcp: { path: '/a?x=1' } }, 'mcp({ path })'],
    ['mcp', { mcp: { path: 42 } }, 'mcp({ path })'],
    ['openapi', { openapi: { path: 'spec.json' } }, 'openapi.path'],
    ['openapi', { openapi: { path: '/spec.json', reference: true, referencePath: '/spec.json' } }, 'both'],
    ['openapi', { openapi: { path: '/api/openapi.json', reference: true, referencePath: '/api/openapi.json' } }, 'both'],
  ])('refuses %s %j', async (_kind, extra, message) => {
    await expect(boot(extra)).rejects.toThrow(message)
  })

  it('refuses a path under /_kay', async () => {
    await expect(boot({ mcp: { path: '/_kay/mcp' } })).rejects.toThrow('/_kay')
    await expect(boot({ openapi: { path: '/_kay' } })).rejects.toThrow('/_kay')
  })

  it('refuses an MCP path a page, an API route or the OpenAPI document already serves', async () => {
    await expect(boot({ mcp: { path: '/more' } })).rejects.toThrow('/more')
    await expect(boot({ mcp: { path: '/api/notes/hidden' } })).rejects.toThrow('/api/notes/hidden')
    await expect(boot({ mcp: { path: '/spec.json' }, openapi: { path: '/spec.json' } })).rejects.toThrow('/spec.json')
  })

  it('refuses an OpenAPI path an API route or a page already serves', async () => {
    await expect(boot({ openapi: { path: '/api/notes/hidden' } })).rejects.toThrow('/api/notes/hidden')
    await expect(boot({ openapi: { path: '/more' } })).rejects.toThrow('/more')
  })
})
