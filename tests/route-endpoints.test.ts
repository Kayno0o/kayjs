import { describe, expect, it } from 'bun:test'
import { resolveConfig } from '../src/config-resolve'
import { invalidConfigValues, unknownConfigKeys } from '../src/config-shape'
import { mcpPath, openApiPaths } from '../src/server/api-modules'
import { testSite } from '../src/test'

const routes = 'tests/fixtures/mcp/src/routes'
const api = 'tests/fixtures/mcp/src/api'
const post = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) }

describe('endpoints in the config', () => {
  it('reads the old keys, the key written in endpoints winning', async () => {
    const config = await resolveConfig({
      serve: { apiPrefix: '/v1', compress: false },
      openapi: { path: '/spec.json', reference: true, referencePath: '/docs/api', title: 'T' },
      mcp: { path: '/tools' },
      ops: { health: { path: '/up' }, metrics: { path: '/m' }, jobs: { path: '/j' } },
      endpoints: { health: '/ping' },
    })

    expect(config.endpoints).toEqual({ api: '/v1', openapi: '/spec.json', mcp: '/tools', health: '/ping', metrics: '/m', jobs: '/j' })
    expect(config.serve).toEqual({ compress: false })
    expect(config.openapi).toEqual({ reference: { path: '/docs/api' }, title: 'T' })
    expect(config.mcp).toEqual({})
    expect(config.ops).toEqual({ health: {}, metrics: {}, jobs: {} })
  })

  it('leaves a config with none of them alone', async () => {
    expect(await resolveConfig({ endpoints: { api: '/v1' } })).toEqual({ endpoints: { api: '/v1' } })
    expect((await resolveConfig({ lang: 'en' })).endpoints).toBeUndefined()
  })

  it('is checked, and the old keys still are', () => {
    expect(unknownConfigKeys({ endpoints: { mpc: '/x' } })).toHaveLength(1)
    expect(invalidConfigValues({ endpoints: { api: 1 }, openapi: { reference: 'yes' } })).toHaveLength(2)
    expect(invalidConfigValues({ endpoints: { api: '/v1' }, openapi: { reference: { path: '/r' } } })).toEqual([])
    expect(unknownConfigKeys({ serve: { apiPrefix: '/v1' }, ops: { health: { path: '/up' } }, openapi: { referencePath: '/r' } })).toEqual([])
  })

  it('names the default paths', () => {
    expect(mcpPath(true)).toBe('/_kay/mcp')
    expect(mcpPath(true, '/tools')).toBe('/tools')
    expect(openApiPaths(undefined, '/v1')).toEqual({ document: '/v1/openapi.json', reference: '/v1/reference' })
    expect(openApiPaths({ reference: { path: '/docs' } }, '/v1', '/spec.json')).toEqual({ document: '/spec.json', reference: '/docs' })
  })
})

describe('the MCP path', () => {
  it('is /_kay/mcp, and /mcp redirects to it with the query', async () => {
    const site = await testSite({ requireGuards: false, dirs: { routes, api }, mcp: true, islands: false })
    const ok = await site.fetch('/_kay/mcp', post)
    const old = await site.fetch('/mcp?x=1', { method: 'POST', body: '{}' })

    expect(ok.status).toBe(200)
    expect(old.status).toBe(308)
    expect(old.headers.get('location')).toBe('/_kay/mcp?x=1')
  })

  it('keeps the base in the redirect', async () => {
    const site = await testSite({ requireGuards: false, dirs: { routes, api }, mcp: true, islands: false, base: '/shop' })

    expect((await site.fetch('/mcp', { method: 'POST', body: '{}' })).headers.get('location')).toBe('/shop/_kay/mcp')
  })

  it('moves to endpoints.mcp, leaving /mcp unserved', async () => {
    const site = await testSite({ requireGuards: false, dirs: { routes, api }, mcp: true, islands: false, endpoints: { mcp: '/tools' } })

    expect((await site.fetch('/mcp', { method: 'POST', body: '{}' })).status).toBe(404)
    expect((await site.fetch('/tools', { method: 'GET' })).status).toBe(405)
  })
})
