import { afterAll, describe, expect, it } from 'bun:test'
import { testSite } from '../src/test'
import { pages } from './shared-pages'

const routes = 'tests/fixtures/mcp/src/routes'
const api = 'tests/fixtures/mcp/src/api'
const KEY = { 'x-key': 'open' }
const locals = (request: Request) => ({ key: request.headers.get('x-key') ?? undefined })
const config = { guards: { default: 'open' as const }, dirs: { routes, api }, mcp: true, endpoints: { mcp: '/tools', openapi: '/spec.json' }, openapi: { reference: { path: '/docs/api' } } }

const root = await testSite({ config, islands: false, locals })
const mounted = await testSite({ config: { ...config, base: '/shop', trailingSlash: 'always' }, islands: false, locals })
const defaults = await testSite({ config: { guards: { default: 'open' }, dirs: { routes, api }, mcp: true, openapi: { reference: true } }, islands: false, locals })

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
    expect((await defaults.fetch('/_kay/mcp', { method: 'GET' })).status).toBe(405)
  })
})

describe('a path that cannot be served', () => {
  const boot = async (extra: object) => pages({ config: { guards: { default: 'open' }, dirs: { routes, api }, security: false, ...extra }, prebuilt: false })

  it.each([
    ['mcp', { mcp: true, endpoints: { mcp: 'tools' } }, 'endpoints.mcp'],
    ['mcp', { mcp: true, endpoints: { mcp: '' } }, 'endpoints.mcp'],
    ['mcp', { mcp: true, endpoints: { mcp: '/' } }, 'endpoints.mcp'],
    ['mcp', { mcp: true, endpoints: { mcp: '/tools/' } }, 'endpoints.mcp'],
    ['mcp', { mcp: true, endpoints: { mcp: '/a/:id' } }, 'endpoints.mcp'],
    ['mcp', { mcp: true, endpoints: { mcp: '/a/*' } }, 'endpoints.mcp'],
    ['mcp', { mcp: true, endpoints: { mcp: '/a//b' } }, 'endpoints.mcp'],
    ['mcp', { mcp: true, endpoints: { mcp: '/a/../b' } }, 'endpoints.mcp'],
    ['mcp', { mcp: true, endpoints: { mcp: '/a?x=1' } }, 'endpoints.mcp'],
    ['mcp', { mcp: true, endpoints: { mcp: 42 } }, 'endpoints.mcp'],
    ['openapi', { endpoints: { openapi: 'spec.json' } }, 'endpoints.openapi'],
    ['openapi', { endpoints: { openapi: '/spec.json' }, openapi: { reference: { path: '/spec.json' } } }, 'both'],
    ['openapi', { endpoints: { openapi: '/api/openapi.json' }, openapi: { reference: { path: '/api/openapi.json' } } }, 'both'],
  ])('refuses %s %j', async (_kind, extra, message) => {
    await expect(boot(extra)).rejects.toThrow(message)
  })

  it('lets the document sit at the reference page\'s default path while the page is off', async () => {
    await expect(boot({ endpoints: { openapi: '/api/reference' } })).resolves.toBeDefined()
  })

  it('refuses a path under /_kay', async () => {
    await expect(boot({ mcp: true, endpoints: { mcp: '/_kay/mcp' } })).rejects.toThrow('/_kay')
    await expect(boot({ endpoints: { openapi: '/_kay' } })).rejects.toThrow('/_kay')
  })

  it('refuses an MCP path a page, an API route or the OpenAPI document already serves', async () => {
    await expect(boot({ mcp: true, endpoints: { mcp: '/more' } })).rejects.toThrow('/more')
    await expect(boot({ mcp: true, endpoints: { mcp: '/api/notes/hidden' } })).rejects.toThrow('/api/notes/hidden')
    await expect(boot({ mcp: true, openapi: true, endpoints: { mcp: '/spec.json', openapi: '/spec.json' } })).rejects.toThrow('/spec.json')
  })

  it('refuses an OpenAPI path an API route or a page already serves', async () => {
    await expect(boot({ openapi: true, endpoints: { openapi: '/api/notes/hidden' } })).rejects.toThrow('/api/notes/hidden')
    await expect(boot({ openapi: true, endpoints: { openapi: '/more' } })).rejects.toThrow('/more')
  })
})
