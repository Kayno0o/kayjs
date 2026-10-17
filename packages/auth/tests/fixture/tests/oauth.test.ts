import { createHash } from 'node:crypto'
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

const PASSWORD = 'correct horse battery'
const REDIRECT = 'http://127.0.0.1:33418/callback'
const VERIFIER = 'v'.repeat(64)
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url')
const PAGES = join(ROOT, '..', '..', 'src', 'pages', 'routes')

// An MCP client signing in the way Claude Code does: registers itself, sends the user to the consent page, and exchanges the code.
async function signIn(site: Site, issuer: string, email: string, mount = { base: '', slash: '' }) {
  const { base, slash } = mount
  const { register } = await import(join(PAGES, 'register.kay')) as { register: Parameters<Site['submit']>[0] }
  const { decide } = await import(join(PAGES, 'oauth', 'authorize.kay')) as { decide: Parameters<Site['submit']>[0] }
  const registered = await json(await site.fetch('/auth/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude Code', redirect_uris: [REDIRECT] }) }))
  const clientId = registered.client_id as string
  const query = new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', code_challenge: CHALLENGE, code_challenge_method: 'S256', scope: 'notes:read', state: 'xyz' })
  const authorize = `/auth/oauth/authorize${slash}?${query}`

  const signedOut = await site.fetch(authorize)
  const toSignIn = new URL(signedOut.headers.get('location')!, 'http://localhost')

  expect(signedOut.status).toBe(302)
  expect(toSignIn.pathname).toStartWith(`${base}/auth/sign-in`)
  expect(toSignIn.searchParams.get('redirect')).toContain('/auth/oauth/authorize')

  await site.submit(register as never, { email, password: PASSWORD } as never, { from: await site.visit(`/auth/register${slash}`) })

  const consent = await site.visit(authorize)

  expect(consent.status).toBe(200)
  expect(consent.html).toContain('Claude Code')
  // The app's label, as text: markup in it is escaped, and the raw code is not shown.
  expect(consent.html).toContain('Read &lt;b>your&lt;/b> notes')
  expect(consent.html).not.toContain('<b>your</b>')
  expect(consent.html).not.toContain('notes:read</')

  const answered = await site.submit(decide as never, { client_id: clientId, redirect_uri: REDIRECT, code_challenge: CHALLENGE, scope: 'notes:read', state: 'xyz', resource: '', decision: 'allow' } as never, { from: consent })
  const back = new URL(answered.headers.get('location')!)

  expect(`${back.origin}${back.pathname}`).toBe(REDIRECT)
  expect(back.searchParams.get('state')).toBe('xyz')
  expect(back.searchParams.get('iss')).toBe(issuer)

  const exchanged = await json(await site.fetch('/auth/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, code_verifier: VERIFIER, client_id: clientId, redirect_uri: REDIRECT }) }))

  return { clientId, exchanged, authorize }
}

describe('signing in', () => {
  const site = served({ mcp: true })

  test('an MCP client registers, the user approves it on the consent page, and the token it is given works on the MCP endpoint', async () => {
    const { exchanged, authorize, clientId } = await signIn(site(), 'http://localhost', 'mcp-user@example.com')

    expect(exchanged).toMatchObject({ token_type: 'Bearer', scope: 'notes:read' })
    await expect(site().mcp.tools({ headers: { authorization: `Bearer ${exchanged.access_token}` } })).resolves.toBeArray()

    const { revoke } = await import(join(PAGES, 'account', 'clients.kay')) as { revoke: Parameters<Site['submit']>[0] }
    const clients = await site().visit('/auth/account/clients')

    expect(clients.html).toContain('Claude Code')
    expect(clients.html).toContain('Read &lt;b>your&lt;/b> notes')
    expect(clients.html).not.toContain('<b>your</b>')

    const again = await site().visit(authorize)

    expect(again.headers.get('location')).toStartWith(`${REDIRECT}?code=`)
    expect(clientId).toStartWith('kc_')

    await site().submit(revoke as never, { id: clientId } as never, { from: clients })

    expect((await site().visit('/auth/account/clients')).html).not.toContain('Claude Code')
    expect((await site().visit(authorize)).html).toContain('Claude Code')
  })
})

describe('signing in under a base', () => {
  const site = served({ mcp: true, base: '/shop', trailingSlash: 'always' })

  test('the full flow works with the base and trailing slashes, the issuer carrying the base, and the token works on /mcp', async () => {
    const { exchanged } = await signIn(site(), 'http://localhost/shop', 'shop-user@example.com', { base: '/shop', slash: '/' })

    expect(exchanged).toMatchObject({ token_type: 'Bearer', scope: 'notes:read' })
    await expect(site().mcp.tools({ headers: { authorization: `Bearer ${exchanged.access_token}` } })).resolves.toBeArray()

    const unknown = await site().visit('/auth/oauth/authorize/?client_id=kc_unknown&redirect_uri=http%3A%2F%2Fevil.example%2F')

    expect(unknown.status).toBe(200)
    expect(unknown.headers.get('location')).toBeNull()
  })
})
