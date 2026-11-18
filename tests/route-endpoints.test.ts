import { describe, expect, it } from 'bun:test'
import { resolveConfig } from '../src/config-resolve'
import { invalidConfigValues, unknownConfigKeys } from '../src/config-shape'
import { mcpPath, openApiPaths } from '../src/server/api-modules'
import { testSite } from '../src/test'

const routes = 'tests/fixtures/mcp/src/routes'
const api = 'tests/fixtures/mcp/src/api'
const post = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) }

describe('endpoints in the config', () => {
  it('leaves a config with none of them alone', async () => {
    expect(await resolveConfig({ endpoints: { api: '/v1' } })).toEqual({ endpoints: { api: '/v1' } })
    expect((await resolveConfig({ lang: 'en' })).endpoints).toBeUndefined()
  })

  it('is checked', () => {
    expect(unknownConfigKeys({ endpoints: { mpc: '/x' } })).toHaveLength(1)
    expect(invalidConfigValues({ endpoints: { api: 1 }, openapi: { reference: 'yes' } })).toHaveLength(2)
    expect(invalidConfigValues({ endpoints: { api: '/v1' }, openapi: { reference: { path: '/r' } } })).toEqual([])
  })

  it('names the default paths', () => {
    expect(mcpPath(true)).toBe('/_kay/mcp')
    expect(mcpPath(true, '/tools')).toBe('/tools')
    expect(openApiPaths(undefined, '/v1')).toEqual({ document: '/v1/openapi.json', reference: '/v1/reference' })
    expect(openApiPaths({ reference: { path: '/docs' } }, '/v1', '/spec.json')).toEqual({ document: '/spec.json', reference: '/docs' })
  })
})

describe('the MCP path', () => {
  it('is /_kay/mcp, and /mcp answers 404, with or without a query', async () => {
    const site = await testSite({ config: { guards: { default: 'open' }, dirs: { routes, api }, mcp: true }, islands: false })
    const ok = await site.fetch('/_kay/mcp', post)
    const old = await site.fetch('/mcp?x=1', { ...post, redirect: 'manual' })

    expect(ok.status).toBe(200)
    expect(old.status).toBe(404)
    expect(old.headers.get('location')).toBeNull()
    expect((await site.fetch('/mcp', { ...post, redirect: 'manual' })).status).toBe(404)
  })

  it('answers 404 at /mcp under a base too', async () => {
    const site = await testSite({ config: { guards: { default: 'open' }, dirs: { routes, api }, mcp: true, base: '/shop' }, islands: false })
    const old = await site.fetch('/mcp', { ...post, redirect: 'manual' })

    expect(old.status).toBe(404)
    expect(old.headers.get('location')).toBeNull()
  })

  it('refuses endpoints.mcp set to a path under /_kay', async () => {
    await expect(testSite({ config: { guards: { default: 'open' }, dirs: { routes, api }, mcp: true, endpoints: { mcp: '/_kay/mcp' } }, islands: false })).rejects.toThrow('under /_kay')
  })

  it('moves to endpoints.mcp, leaving /mcp unserved', async () => {
    const site = await testSite({ config: { guards: { default: 'open' }, dirs: { routes, api }, mcp: true, endpoints: { mcp: '/tools' } }, islands: false })

    expect((await site.fetch('/mcp', { method: 'POST', body: '{}' })).status).toBe(404)
    expect((await site.fetch('/tools', { method: 'GET' })).status).toBe(405)
  })
})
