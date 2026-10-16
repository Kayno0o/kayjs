import { createHash } from 'node:crypto'
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { documentUrl, fetchPublicDocument, plainName, privateAddress } from '../src/authorize/clients'
import { validRedirectUri, validRedirectUris } from '../src/authorize/uris'
import { memoryStore } from '../src/memoryStore'
import { authPages } from '../src/pages'
import { testApp } from './helpers/app'

const PASSWORD = 'correct horse battery'
const REDIRECT = 'http://127.0.0.1:33418/callback'
const VERIFIER = 'v'.repeat(64)
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url')
const DOCUMENT = 'https://client.example/oauth/client.json'

afterEach(() => {
  setSystemTime()
})

describe('privateAddress', () => {
  test.each([
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::7f00:1',
    '::127.0.0.1',
    '::ffff:a00:1',
    '::ffff:0:7f00:1',
    '::ffff:0:127.0.0.1',
    'fec0::1',
    'fe80::1',
    'fd12:3456::1',
    'ff02::1',
    '2001::1',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    '2001:db8::1',
    '2002:7f00:1::1',
    '64:ff9b::7f00:1',
    'not an address',
  ])('refuses %s', (address) => {
    expect(privateAddress(address)).toBe(true)
  })

  test.each(['8.8.8.8', '::ffff:8.8.8.8', '::ffff:808:808', '2606:4700:4700::1111', '2a00:1450:4007::200e'])('allows the public %s', (address) => {
    expect(privateAddress(address)).toBe(false)
  })
})

describe('documentUrl', () => {
  test.each([
    'https://[::ffff:7f00:1]/x',
    'https://[::1]/x',
    'https://[2606:4700:4700::1111]/x',
    'https://127.0.0.1/x',
    'https://8.8.8.8/x',
    'https://2130706433/x',
    'http://client.example/x',
    'https://client.example/',
    'https://client.example',
    'https://user@client.example/x',
    'https://client.example/a/../x',
    'https://client.example/x#frag',
  ])('refuses %s as a client ID', (id) => {
    expect(documentUrl(id)).toBeUndefined()
  })

  test('takes a name with a path', () => {
    expect(documentUrl(DOCUMENT)?.href).toBe(DOCUMENT)
  })
})

describe('the real metadata document reader', () => {
  function serving(handler: (request: Request) => Response) {
    const requests: string[] = []
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (request) => {
      requests.push(new URL(request.url).pathname)

      return handler(request)
    } })

    return { url: `http://127.0.0.1:${server.port}`, requests, stop: async () => server.stop(true) }
  }

  const anywhere = () => false

  test('never connects to a loopback address', async () => {
    const server = serving(() => Response.json({ client_id: 'x' }))

    await expect(fetchPublicDocument(`${server.url}/client.json`)).rejects.toThrow('not on the public internet')
    await expect(fetchPublicDocument('https://localhost/client.json')).rejects.toThrow('not on the public internet')
    expect(server.requests).toEqual([])
    await server.stop()
  })

  test('reads a JSON document', async () => {
    const server = serving(() => Response.json({ client_id: 'x' }))

    expect(await fetchPublicDocument(`${server.url}/client.json`, anywhere)).toEqual({ client_id: 'x' })
    await server.stop()
  })

  test('follows no redirect', async () => {
    const server = serving(request => new URL(request.url).pathname === '/moved' ? Response.redirect(`${new URL(request.url).origin}/client.json`, 302) : Response.json({ client_id: 'x' }))

    await expect(fetchPublicDocument(`${server.url}/moved`, anywhere)).rejects.toThrow('200 with JSON')
    expect(server.requests).toEqual(['/moved'])
    await server.stop()
  })

  test('refuses a document that is not JSON, or too large', async () => {
    const text = serving(() => new Response('{"client_id":"x"}', { headers: { 'content-type': 'text/plain' } }))
    const large = serving(() => Response.json({ client_id: 'x', padding: 'x'.repeat(11 * 1024) }))

    await expect(fetchPublicDocument(`${text.url}/client.json`, anywhere)).rejects.toThrow('200 with JSON')
    await expect(fetchPublicDocument(`${large.url}/client.json`, anywhere)).rejects.toThrow('too large')
    await text.stop()
    await large.stop()
  })
})

describe('redirect URIs', () => {
  test.each([
    'myapp://callback',
    'javascript:alert(1)',
    'data:text/html,hi',
    'https://user:pw@app.example/cb',
    'https://user@app.example/cb',
    'https://app.example/cb#fragment',
    'http://app.example/cb',
    'http://127.0.0.1.evil.example/cb',
    'ftp://app.example/cb',
    '',
    'not a url',
  ])('refuses %s', (uri) => {
    expect(validRedirectUri(uri)).toBe(false)
  })

  test.each(['https://app.example/cb', 'http://127.0.0.1:8080/cb', 'http://localhost/cb', 'http://[::1]:9/cb'])('takes %s', (uri) => {
    expect(validRedirectUri(uri)).toBe(true)
  })

  test('a client may hold at most ten, 2048 characters in all', () => {
    expect(validRedirectUris(Array.from({ length: 10 }, (_, index) => `https://app.example/${index}`))).toBe(true)
    expect(validRedirectUris(Array.from({ length: 11 }, (_, index) => `https://app.example/${index}`))).toBe(false)
    expect(validRedirectUris(Array.from({ length: 5 }, (_, index) => `https://app.example/${'x'.repeat(500)}${index}`))).toBe(false)
    expect(validRedirectUris([])).toBe(false)
  })
})

describe('client names', () => {
  test('lose the characters that reorder the text around them, and control characters', () => {
    expect(plainName('Claude‮trusted‬⁦x⁩ Code\n')).toBe('Claudetrustedx Code')
  })
})

function server(options: { documents?: Record<string, unknown>, limits?: Record<string, { max: number, window: number }>, url?: string | null } = {}) {
  return testApp({
    ...options.url === null ? {} : { url: options.url ?? 'http://localhost' },
    pages: authPages(),
    scopes: ['posts:read', 'posts:write'],
    admin: 'admin',
    ...options.limits && { limits: options.limits },
    oauthServer: { fetch: async (url: string) => options.documents?.[url] === undefined ? new Response('missing', { status: 404 }) : Response.json(options.documents[url]) },
  } as never)
}

type Server = ReturnType<typeof server>

async function register(app: Server, name = 'Claude Code') {
  const response = await app.browser().fetch('/auth/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT] }) })

  return { status: response.status, body: await response.json() as Record<string, string> }
}

function params(clientId: string, extra: Record<string, string> = {}) {
  return { client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', code_challenge: CHALLENGE, code_challenge_method: 'S256', scope: 'posts:read', state: 'abc', ...extra }
}

async function signedIn(app: Server) {
  const ada = app.browser()

  await ada.call('register', { email: 'ada@example.com', password: PASSWORD })

  return ada
}

async function token(app: Server, form: Record<string, string>) {
  const response = await app.browser().fetch('/auth/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) })

  return { status: response.status, body: await response.json() as Record<string, string | number> }
}

describe('the limits', () => {
  test('registration answers 429 past the limit of an address, and past the one of all addresses together', async () => {
    const byAddress = server({ limits: { oauthRegister: { max: 2, window: 3600 } } })

    expect([(await register(byAddress)).status, (await register(byAddress)).status, (await register(byAddress)).status]).toEqual([201, 201, 429])

    const all = server({ limits: { oauthRegisterAll: { max: 2, window: 3600 } } })

    expect([(await register(all)).status, (await register(all)).status, (await register(all)).status]).toEqual([201, 201, 429])
  })

  test('the token endpoint answers 429 past its limit', async () => {
    const app = server({ limits: { oauthToken: { max: 2, window: 900 } } })
    const statuses = []

    for (let attempt = 0; attempt < 3; attempt++)
      statuses.push((await token(app, { grant_type: 'password' })).status)

    expect(statuses).toEqual([400, 400, 429])
  })

  test('metadata documents are read a limited number of times per address', async () => {
    const documents = { [DOCUMENT]: { client_id: DOCUMENT, redirect_uris: [REDIRECT] }, 'https://other.example/c.json': { client_id: 'https://other.example/c.json', redirect_uris: [REDIRECT] } }
    const app = server({ documents, limits: { oauthDocument: { max: 1, window: 900 } } })
    const ada = await signedIn(app)

    expect(await ada.call('oauthAuthorize', params(DOCUMENT))).toMatchObject({ kind: 'consent' })
    expect(await ada.call('oauthAuthorize', params('https://other.example/c.json'))).toEqual({ kind: 'error', error: 'client' })
  })
})

describe('client metadata documents', () => {
  test('one holding a secret, by its authentication method, is refused', async () => {
    const app = server({ documents: { [DOCUMENT]: { client_id: DOCUMENT, redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' } } })

    expect(await (await signedIn(app)).call('oauthAuthorize', params(DOCUMENT))).toEqual({ kind: 'error', error: 'client' })
  })

  test('one naming itself with bidirectional controls shows without them', async () => {
    const app = server({ documents: { [DOCUMENT]: { client_id: DOCUMENT, client_name: 'Fake‮Bank', redirect_uris: [REDIRECT] } } })

    expect(await (await signedIn(app)).call('oauthAuthorize', params(DOCUMENT))).toMatchObject({ kind: 'consent', client: { name: 'FakeBank' } })
  })
})

describe('the consent page', () => {
  test('always names the host the browser goes back to, for a registered client too', async () => {
    const app = server()
    const ada = await signedIn(app)
    const { body } = await register(app)

    expect(await ada.call('oauthAuthorize', params(body.client_id!))).toMatchObject({ kind: 'consent', redirectHost: '127.0.0.1:33418', client: { host: null } })
  })

  test('prompt=none answers the client instead of showing a page', async () => {
    const app = server()
    const { body } = await register(app)
    const signedOut = await app.browser().call('oauthAuthorize', params(body.client_id!, { prompt: 'none' })) as { kind: string, url: string }

    expect(new URL(signedOut.url).searchParams.get('error')).toBe('login_required')

    const ada = await signedIn(app)
    const needsConsent = await ada.call('oauthAuthorize', params(body.client_id!, { prompt: 'none' })) as { kind: string, url: string }

    expect(new URL(needsConsent.url).searchParams.get('error')).toBe('consent_required')

    await ada.post('/call/oauthDecide', [params(body.client_id!), true])

    const approved = await ada.call('oauthAuthorize', params(body.client_id!, { prompt: 'none' })) as { kind: string, url: string }

    expect(new URL(approved.url).searchParams.has('code')).toBe(true)
  })

  test('an admin acting as a user cannot approve a client', async () => {
    const app = server()
    const { body } = await register(app)
    const admin = app.browser()
    const { user } = await admin.callHas('user', 'register', { email: 'root@example.com', password: PASSWORD })
    const ada = await signedIn(app)
    const { id } = await ada.json('/me') as { id: string }

    await app.store.users.update(user.id, { roles: ['admin'] })
    expect(await admin.call('impersonate', id)).toEqual({ ok: true })

    const outcome = await admin.call('oauthAuthorize', params(body.client_id!)) as { kind: string, url: string }

    expect(new URL(outcome.url).searchParams.get('error')).toBe('access_denied')
    expect(await admin.post('/call/oauthDecide', [params(body.client_id!), true])).toEqual({ ok: false, error: 'signed-out' })
    expect(await app.store.oauth!.grants.listByUser(id)).toEqual([])
  })
})

describe('the token endpoint and the resource', () => {
  test('refuses a resource that is not of this site', async () => {
    const app = server()
    const { body } = await register(app)
    const ada = await signedIn(app)
    const answer = await ada.post('/call/oauthDecide', [params(body.client_id!), true]) as { ok: true, redirect: string }
    const code = new URL(answer.redirect).searchParams.get('code')!
    const wrong = await token(app, { grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: body.client_id!, redirect_uri: REDIRECT, resource: 'https://other.example/mcp' })

    expect(wrong.body.error).toBe('invalid_target')
  })

  test('refuses a body past 16 KB, whether or not the request says how large it is', async () => {
    const app = server()
    const sized = await app.browser().fetch('/auth/oauth/token', { method: 'POST', body: `grant_type=x&padding=${'x'.repeat(20000)}` })
    const streamed = await app.browser().fetch('/auth/oauth/token', { method: 'POST', body: new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`grant_type=x&padding=${'x'.repeat(20000)}`))
      controller.close()
    } }), duplex: 'half' } as RequestInit)

    expect(sized.status).toBe(400)
    expect(streamed.status).toBe(400)
  })
})

describe('the documents', () => {
  test('are cached for everyone only when the site\'s origin is configured', async () => {
    const fixed = server()
    const guessed = server({ url: null })

    expect((await fixed.browser().fetch('/.well-known/oauth-authorization-server')).headers.get('cache-control')).toBe('public, max-age=300')
    expect((await guessed.browser().fetch('/.well-known/oauth-authorization-server')).headers.get('cache-control')).toBe('private, max-age=300')
  })
})

describe('clients nobody approved', () => {
  test('are dropped after a day, and an approved one is kept', async () => {
    const app = server()
    const ada = await signedIn(app)
    const unused = await register(app, 'Unused')
    const used = await register(app, 'Used')

    await ada.post('/call/oauthDecide', [params(used.body.client_id!), true])
    setSystemTime(Date.now() + 25 * 60 * 60 * 1000)
    await app.store.prune!({ now: new Date(), bearerExpiredBefore: new Date(0), sessionMaxAge: 10 ** 9, sessionAbsoluteMaxAge: 10 ** 9 })

    expect(await app.store.oauth!.clients.get(unused.body.client_id!)).toBeUndefined()
    expect(await app.store.oauth!.clients.get(used.body.client_id!)).toBeDefined()
  })

  test('the memory store is the one tested', () => {
    expect(memoryStore().oauth).toBeDefined()
  })
})

describe('a route of the app at a document\'s path', () => {
  test('replaces the OAuth server\'s own, as a later route replaces an earlier one, and the app still boots', async () => {
    const { app } = server()
    const own = app.get('/.well-known/oauth-authorization-server', () => 'mine')

    expect(await (await own.handle(new Request('http://localhost/.well-known/oauth-authorization-server'))).text()).toBe('mine')
    expect((await own.handle(new Request('http://localhost/.well-known/openid-configuration'))).status).toBe(200)
  })
})
