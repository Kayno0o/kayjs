import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { testSite } from 'kay/test'

// The fixture served as an app serves itself, kay's MCP endpoint among its routes: an MCP client signing in finds its way through the documents.
const ROOT = join(import.meta.dir, '..')

type Site = Awaited<ReturnType<typeof testSite>>

// The site's origin and mount point are the process's own, set as a site is made: each describe makes the one it serves.
function served(options: Parameters<typeof testSite>[0]): () => Site {
  let site: Site | undefined

  beforeAll(async () => {
    site = await testSite({ root: ROOT, ...options })
  })
  afterAll(async () => {
    await site?.close()
  })

  return () => site!
}

const json = async (response: Response) => await response.json() as Record<string, unknown>

describe('discovery', () => {
  const site = served({ mcp: true })

  test('the 401 of the MCP endpoint points at the resource metadata, which names the app\'s own authorization server', async () => {
    const refused = await site().fetch('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })

    expect(refused.status).toBe(401)
    expect(refused.headers.get('www-authenticate')).toBe('Bearer resource_metadata="http://localhost/.well-known/oauth-protected-resource"')

    const resource = await site().fetch('/.well-known/oauth-protected-resource')

    expect(resource.status).toBe(200)
    expect(resource.headers.get('access-control-allow-origin')).toBe('*')
    expect(await json(resource)).toEqual({ resource: 'http://localhost/mcp', authorization_servers: ['http://localhost'], bearer_methods_supported: ['header'], resource_name: 'API', scopes_supported: ['notes:read'] })
    expect(await json(await site().fetch('/.well-known/oauth-protected-resource/mcp'))).toMatchObject({ resource: 'http://localhost/mcp' })
  })

  test('the authorization server metadata is served at both well-known locations, with PKCE S256 only and client ID metadata documents', async () => {
    for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
      const response = await site().fetch(path)

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(await json(response)).toEqual({
        issuer: 'http://localhost',
        authorization_endpoint: 'http://localhost/auth/oauth/authorize',
        token_endpoint: 'http://localhost/auth/oauth/token',
        registration_endpoint: 'http://localhost/auth/oauth/register',
        response_types_supported: ['code'],
        response_modes_supported: ['query'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['notes:read'],
        client_id_metadata_document_supported: true,
        authorization_response_iss_parameter_supported: true,
      })
    }
  })

  test('answers a preflight of a browser client, ', async () => {
    const preflight = await site().fetch('/.well-known/oauth-authorization-server', { method: 'OPTIONS', headers: { 'origin': 'https://client.example', 'access-control-request-method': 'GET' } })

    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
    expect((await site().fetch('/.well-known/oauth-protected-resource')).status).toBe(200)
  })
})

describe('discovery without mcp', () => {
  const site = served({})

  test('serves no resource metadata, as there is no resource', async () => {
    expect((await site().fetch('/.well-known/oauth-protected-resource')).status).toBe(404)
  })
})

describe('discovery under a base', () => {
  const site = served({ mcp: true, base: '/shop', trailingSlash: 'always' })

  test('a site under a base and with trailing slashes puts the base in every URL, and a client finds the metadata by path appending under the issuer', async () => {
    const refused = await site().fetch('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
    const pointer = (/resource_metadata="([^"]+)"/).exec(refused.headers.get('www-authenticate')!)![1]!

    expect(pointer).toBe('http://localhost/shop/.well-known/oauth-protected-resource')

    const resource = await json(await site().fetch(new URL(pointer).pathname.replace('/shop', '')))

    expect(resource).toMatchObject({ resource: 'http://localhost/shop/mcp', authorization_servers: ['http://localhost/shop'] })

    const issuer = (resource.authorization_servers as string[])[0]!
    const metadata = await json(await site().fetch(new URL(`${issuer}/.well-known/openid-configuration`).pathname.replace('/shop', '')))

    expect(metadata).toMatchObject({ issuer, authorization_endpoint: 'http://localhost/shop/auth/oauth/authorize', token_endpoint: 'http://localhost/shop/auth/oauth/token', registration_endpoint: 'http://localhost/shop/auth/oauth/register' })
  })
})
