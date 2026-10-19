import { join, relative } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { writeShadowTypes } from '../src/check'
import { bootProblems } from '../src/check/boot'
import { UPGRADE_FROM } from '../src/compiler/lints'
import { configuredSite, setSite } from '../src/runtime/site'
import { encodeValue } from '../src/runtime/wire'
import { toolCall } from '../src/server'
import { testSite } from '../src/test'
import { fixtureCopy } from './scratch'

const routes = 'tests/fixtures/mcp/src/routes'
const api = 'tests/fixtures/mcp/src/api'
const BEARER = { authorization: 'Bearer open' }
// The key the app's own session would read from the bearer token, as a `derive` does.
const locals = (request: Request) => ({ key: request.headers.get('authorization') === 'Bearer open' ? 'open' : undefined })

const site = await testSite({ routes, api, mcp: true, islands: false, locals })
const off = await testSite({ routes, api, islands: false })
const mounted = await testSite({ routes, api, mcp: true, islands: false, base: '/shop', trailingSlash: 'always', locals })
const openapi = await testSite({ routes, api, mcp: true, openapi: true, islands: false, locals })
const guardedApi = 'tests/fixtures/mcp-guarded/src/api'
const guarded = await testSite({ routes, api: guardedApi, mcp: true, islands: false })
const limited = await testSite({ routes, api: 'tests/fixtures/mcp-limited/src/api', mcp: true, islands: false, base: '/shop' })
const names = await testSite({ routes: 'tests/fixtures/mcp-names/src/routes', api: 'tests/fixtures/mcp-names/src/api', mcp: true, openapi: true, islands: false })
const longNames = await testSite({ routes: 'tests/fixtures/mcp-long-names/src/routes', api: 'tests/fixtures/mcp-long-names/src/api', mcp: true, openapi: true, islands: false })
const guardedMounted = await testSite({ routes, api: guardedApi, mcp: true, islands: false, base: '/shop' })
// Guards that cover every module, and guards that cover only one of them.
const strict = await testSite({ routes, api: guardedApi, mcp: true, islands: false, requireGuards: true })
const uncovered = await testSite({ routes, api, mcp: true, islands: false, requireGuards: true })
// A site with tool actions and no API module has no guard to add, so requireGuards leaves its list open, while its OpenAPI document stays refused.
const noApi = await testSite({ routes, api: 'tests/fixtures/mcp/src/none', mcp: true, openapi: true, islands: false, requireGuards: true })
const documentOnly = await testSite({ routes, api: guardedApi, openapi: true, islands: false })
const localized = await testSite({ routes, api, mcp: true, islands: false, i18n: { locales: ['fr', 'en'], defaultLocale: 'fr', messages: 'tests/fixtures/i18n/src/messages' } })

afterAll(async () => {
  await Promise.all([site.close(), off.close(), mounted.close(), localized.close(), openapi.close(), guarded.close(), guardedMounted.close(), strict.close(), uncovered.close(), noApi.close(), documentOnly.close(), limited.close(), names.close()])
})

async function post(target: typeof site, body: unknown, headers: Record<string, string> = {}) {
  return target.fetch('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })
}

async function rpc(target: typeof site, method: string, params: object = {}, headers: Record<string, string> = {}) {
  const response = await post(target, { jsonrpc: '2.0', id: 1, method, params }, headers)

  return { response, body: await response.json() as { result?: Record<string, unknown> & { capabilities?: Record<string, unknown> }, error?: { code: number, message: string } } }
}

// `kay upgrade` sets the version the app came from, which the lint about the old default needs.
beforeAll(() => {
  process.env[UPGRADE_FROM] = '1.50.0'
})
afterAll(() => {
  delete process.env[UPGRADE_FROM]
})

describe('the endpoint', () => {
  it('is not served without mcp', async () => {
    expect((await post(off, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(404)
  })

  it('answers initialize, ping and tools/list as a Streamable HTTP server of tools only', async () => {
    const { response, body } = await rpc(site, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(body.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} } })
    expect(body.result!.capabilities?.resources).toBeUndefined()
    expect(body.result!.instructions).toBeUndefined()
    expect((await rpc(site, 'ping')).body.result).toEqual({})
  })

  it('says how long a client of the revision without a handshake keeps its tool list, as Claude Code requires', async () => {
    const { body } = await rpc(site, 'tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } })

    expect(body.result).toMatchObject({ resultType: 'complete', ttlMs: 0, cacheScope: 'private' })
    expect((await rpc(site, 'tools/list')).body.result?.ttlMs).toBeUndefined()
  })

  it('takes a notification with a 202 and no body', async () => {
    const response = await post(site, { jsonrpc: '2.0', method: 'notifications/initialized' })

    expect(response.status).toBe(202)
    expect(await response.text()).toBe('')
  })

  it('refuses GET and DELETE, as it keeps no stream and no session', async () => {
    for (const method of ['GET', 'DELETE']) {
      const response = await site.fetch('/mcp', { method })

      expect(response.status).toBe(405)
      expect(response.headers.get('allow')).toBe('POST')
    }
  })

  it('answers hostile JSON-RPC with an error, never a crash', async () => {
    const parse = await post(site, '{not json')

    expect(parse.status).toBe(400)
    expect((await parse.json() as { error: { code: number } }).error.code).toBe(-32700)

    for (const body of [[{ jsonrpc: '2.0', id: 1, method: 'ping' }], 'null', '42', '"text"', { jsonrpc: '2.0', id: {}, method: 'ping' }]) {
      const response = await post(site, body)

      expect(response.status).toBe(400)
      expect((await response.json() as { error: { code: number } }).error.code).toBe(-32600)
    }

    expect((await rpc(site, 'no/such')).body.error?.code).toBe(-32601)

    const params = await post(site, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: [] })

    expect((await params.json() as { error: { code: number } }).error.code).toBe(-32602)
    expect((await rpc(site, 'tools/call', { name: 'nope' })).body.error?.code).toBe(-32602)
    expect((await rpc(site, 'tools/call', { name: 'add_note', arguments: [] })).body.error?.code).toBe(-32602)
    expect((await rpc(site, 'tools/call', { name: 'add_note', arguments: 'x' })).body.error?.code).toBe(-32602)
    expect((await rpc(site, 'tools/call', { name: '__proto__' })).body.error?.code).toBe(-32602)
  })

  it('refuses a body over the limit with 413', async () => {
    const response = await post(site, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(1_100_000) } }))

    expect(response.status).toBe(413)
  })

  it('refuses a chunked body over the limit with 413 though the endpoint reads none itself', async () => {
    const message = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(1_100_000) } })
    const chunks = message.match(/[\s\S]{1,65536}/g)!

    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift()

        if (chunk === undefined)
          controller.close()
        else
          controller.enqueue(new TextEncoder().encode(chunk))
      },
    })

    const response = await site.fetch('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half' } as Parameters<typeof site.fetch>[1])

    expect(response.status).toBe(413)
  })

  it('refuses a request from another site, which would act with the visitor\'s cookies', async () => {
    const response = await post(site, { jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' })

    expect(response.status).toBe(403)
    expect((await post(site, { jsonrpc: '2.0', id: 1, method: 'ping' }, { 'origin': 'http://localhost', 'sec-fetch-site': 'same-origin' })).status).toBe(200)
  })

  it('stops the boot when a page serves its path', async () => {
    await expect(testSite({ routes: 'tests/fixtures/mcp-clash/src/routes', api, mcp: true, islands: false })).rejects.toThrow('`mcp` both serve /mcp')
  })
})

describe('the tools', () => {
  it('lists the actions and the routes that set tool, nothing else', async () => {
    const tools = await site.mcp.tools()
    const names = tools.map(tool => tool.name)

    expect(names.sort()).toEqual([
      'Say_Hello',
      'a'.repeat(64),
      'add_note',
      'add_note_2',
      'bare',
      'breaks',
      'create_note',
      'delete_notes_id',
      'draft_note',
      'get_notes_binary',
      'get_notes_described',
      'get_notes_id',
      'get_notes_paged',
      'get_notes_search',
      'get_notes_who',
      'get_notes_words',
      'get_private',
      'language',
      'listing',
      'refuses',
      'sends_away',
      'signup',
      'solve',
      'tagged_note',
      'wipe',
    ].sort())
    expect(names).not.toContain('hidden')
    expect(names).not.toContain('upload')
    expect(names.some(name => name.includes('hidden') || name.includes('photo'))).toBe(false)
    expect(names.every(name => name.length <= 64 && (/^\w+$/).test(name))).toBe(true)
  })

  it('names an action after its export, and describes it with what tool says', async () => {
    const tools = await site.mcp.tools()
    const byName = (name: string) => tools.find(tool => tool.name === name)!

    expect(byName('signup').description).toBe('Sign up')
    expect(byName('Say_Hello').description).toBe('Says hello')
    expect(byName('bare').description).toBe('POST /_kay/action/tests/fixtures/mcp/src/routes/index.kay/bare')
    expect(byName('wipe').description).toBe('Wipe everything')
  })

  it('reads an action\'s input schema from its declaration', async () => {
    const tool = (await site.mcp.tools()).find(each => each.name === 'signup')!

    expect(tool.inputSchema).toMatchObject({ type: 'object', required: ['email'], properties: { email: { type: 'string' } } })
  })

  it('describes a defaulted field as JSON alone and leaves it out of required, on both protocol versions', async () => {
    const versioned = await rpc(site, 'tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } })
    const legacy = await rpc(site, 'tools/list')

    for (const body of [versioned.body, legacy.body]) {
      const tool = (body.result!.tools as { name: string, inputSchema: { properties: Record<string, Record<string, unknown>>, required: string[] } }[]).find(each => each.name === 'listing')!
      const { properties, required } = tool.inputSchema

      expect(properties.limit).toEqual({ type: 'integer', minimum: 1, maximum: 100, default: 20 })
      expect(properties.ratio).toEqual({ type: 'number', default: 0.5 })
      expect(properties.page).toEqual({ type: 'integer' })
      expect(properties.label).toEqual({ type: 'string', default: 'all' })
      expect(properties.open).toEqual({ type: 'boolean', default: true })
      expect(properties.tags).toMatchObject({ type: 'array', default: [] })
      expect(properties.paging).toEqual({ type: 'object', properties: { size: { type: 'integer', default: 10 }, after: { type: 'integer' } }, required: ['size', 'after'] })
      expect(properties.kind!.default).toBe('a')
      expect(properties.either).toEqual({ anyOf: [{ type: 'integer' }, { type: 'string' }] })
      expect(required).toEqual(['total', 'paging', 'either'])
      expect(JSON.stringify(tool.inputSchema)).not.toContain('"format":"integer"')
      expect(JSON.stringify(tool.inputSchema)).not.toContain('"format":"numeric"')
    }
  })

  it('still gives a defaulted field its default when a call leaves it out, and takes the form text over HTTP', async () => {
    const result = await site.mcp.call('listing', { total: 3, paging: { size: 4, after: 1 }, either: 1 })

    expect(result.data).toMatchObject({ limit: 20, ratio: 0.5, label: 'all', open: true, total: 3, paging: { size: 4, after: 1 } })
    expect((await site.mcp.call('listing', { total: '3', limit: '5', ratio: '2.5', paging: { size: 4, after: 1 }, either: 1 })).data).toMatchObject({ limit: 5, ratio: 2.5, total: 3 })
    expect((await site.mcp.call('listing', { total: 3, limit: 500, paging: { after: 1 }, either: 1 })).isError).toBe(true)
  })

  it('leaves a route\'s defaulted query and body fields out of required, and a path param in', async () => {
    const tools = await site.mcp.tools()
    const paged = tools.find(tool => tool.name === 'get_notes_paged')!
    const draft = tools.find(tool => tool.name === 'draft_note')!

    expect(paged.inputSchema).toMatchObject({ required: ['after'], properties: { limit: { type: 'integer', default: 20 } } })
    expect(draft.inputSchema).toMatchObject({ required: ['title'], properties: { copies: { type: 'integer', default: 1 } } })
    expect((await site.mcp.call('get_notes_paged', { after: 1 })).data).toEqual({ limit: 20 })
    expect((await site.mcp.call('draft_note', { title: 'x' })).data).toEqual({ title: 'x', copies: 1 })
  })

  it('reads a route\'s path, query and body into one schema, naming it by its operation id', async () => {
    const tools = await site.mcp.tools()
    const one = tools.find(tool => tool.name === 'get_notes_id')!
    const create = tools.find(tool => tool.name === 'create_note')!

    expect(one.description).toBe('One note\n\nReads a note by its id.')
    expect(one.inputSchema).toMatchObject({ type: 'object', required: ['id'], properties: { id: { type: 'string' }, fields: { type: 'string' }, tags: { type: 'array' } } })
    expect(create.inputSchema).toMatchObject({ required: ['title'], properties: { title: { type: 'string' }, pinned: { type: 'boolean' } } })
  })

  it('serves the same tools under a base and a trailing slash', async () => {
    expect((await mounted.mcp.tools()).length).toBe((await site.mcp.tools()).length)
    expect((await mounted.mcp.call('get_notes_id', { id: 'a' })).data).toEqual({ id: 'a', fields: null, tags: [] })
    expect((await mounted.mcp.call('add_note', { title: 'Milk' })).data).toEqual({ id: 1, title: 'Milk', at: '1970-01-01T00:00:00.000Z' })
  })
})

describe('calling an action', () => {
  it('returns what the handler returned, a Date as its text', async () => {
    const result = await site.mcp.call('add_note', { title: 'Milk' })

    expect(result).toMatchObject({ isError: false, status: 200, data: { id: 1, title: 'Milk', at: '1970-01-01T00:00:00.000Z' } })
    expect(JSON.parse(result.text)).toEqual(result.data!)
  })

  it('tells an action of the same name in another file apart', async () => {
    expect((await site.mcp.call('add_note_2', { text: 'x' })).data).toEqual({ text: 'x' })
  })

  it('runs a call with no input and no arguments', async () => {
    expect(await site.mcp.call('bare')).toMatchObject({ isError: false, text: 'bare' })
  })

  it('answers the fields a schema refused, so the agent can correct and call again', async () => {
    const result = await site.mcp.call('add_note', { title: 'x' })

    expect(result.isError).toBe(true)
    expect(JSON.parse(result.text)).toEqual({ status: 422, errors: { title: 'Too short' } })
    expect((await site.mcp.call('add_note', {})).isError).toBe(true)
    expect((await site.mcp.call('add_note', { title: 5 })).isError).toBe(true)
  })

  it('reads a hostile argument as a field, or refuses it', async () => {
    const encoded = await site.mcp.call('add_note', JSON.parse('{"title":"Milk","$kay":"[1]"}'))

    expect(encoded).toMatchObject({ isError: false, data: { id: 1, title: 'Milk' } })
    expect((await site.mcp.call('add_note', JSON.parse('{"title":"Milk","__proto__":{"admin":true}}'))).isError).toBe(true)
  })

  it('answers what the handler passed to ctx.fail, with its status', async () => {
    const result = await site.mcp.call('refuses')

    expect(result.isError).toBe(true)
    expect(JSON.parse(result.text)).toEqual({ status: 409, errors: {}, data: { reason: 'full' } })
  })

  it('says where a redirect leads', async () => {
    const result = await site.mcp.call('sends_away')

    expect(result.isError).toBe(true)
    expect(result.text).toContain('/done')
  })

  it('answers a handler that throws with a generic error, not its message', async () => {
    const result = await site.mcp.call('breaks')

    expect(result.isError).toBe(true)
    expect(result.text).not.toContain('boom')
  })

  it('runs in the locale of the caller', async () => {
    expect((await localized.mcp.call('language', {}, { headers: { 'accept-language': 'en' } })).data).toEqual({ locale: 'en' })
    expect((await localized.mcp.call('language')).data).toEqual({ locale: 'fr' })
  })
})

describe('sign-in metadata', () => {
  it('is a 404 while no auth library names an authorization server, as no client can sign in by OAuth', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'])
      expect((await site.fetch(path)).status).toBe(404)

    expect((await off.fetch('/.well-known/oauth-protected-resource')).status).toBe(404)
  })

  it('is what the auth of the context answers for the endpoint, at the root path and the endpoint\'s', async () => {
    const asked: string[][] = []
    const oauth = await testSite({ routes, api, mcp: true, islands: false, locals: () => ({ auth: { oauthResource: (path: string, name: string) => {
      asked.push([path, name])

      return { resource: `https://app.example${path}`, authorization_servers: ['https://app.example'] }
    } } }) })

    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const response = await oauth.fetch(path)

      expect(response.status).toBe(200)
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
      expect(await response.json()).toEqual({ resource: 'https://app.example/mcp', authorization_servers: ['https://app.example'] })
    }

    expect(asked).toEqual([['/mcp', expect.any(String)], ['/mcp', expect.any(String)]])
    expect((await oauth.fetch('/.well-known/oauth-protected-resource', { method: 'OPTIONS' })).status).toBe(204)
    await oauth.close()
  })
})

describe('sign-in metadata of an app with no site set', () => {
  it('is kept by no shared cache, and the 401 points to the origin the auth library serves its documents at', async () => {
    const auth = (fixed: boolean) => ({ oauthResource: (path: string) => ({ resource: `https://app.example${path}`, authorization_servers: ['https://app.example'] }), oauthOrigin: () => 'https://app.example', oauthFixed: () => fixed })
    const withAuth = async (fixed: boolean) => testSite({ routes, api, mcp: true, islands: false, locals: request => ({ ...locals(request), auth: auth(fixed) }) })
    const [open, fixed] = await Promise.all([withAuth(false), withAuth(true)])
    const before = configuredSite()

    try {
      const withSite = await open.fetch('/.well-known/oauth-protected-resource')

      expect(withSite.headers.get('cache-control')).toBe('public, max-age=300')
      setSite(undefined)

      const noSite = await open.fetch('/.well-known/oauth-protected-resource')
      const pointed = await rpc(open, 'tools/call', { name: 'wipe', arguments: { confirm: true } })

      expect(noSite.headers.get('cache-control')).toBe('private, max-age=300')
      expect(pointed.response.status).toBe(401)
      expect(pointed.response.headers.get('www-authenticate')).toBe('Bearer resource_metadata="https://app.example/.well-known/oauth-protected-resource"')
      // An origin the auth library fixes does not come from the Host header.
      expect((await fixed.fetch('/.well-known/oauth-protected-resource')).headers.get('cache-control')).toBe('public, max-age=300')
    }
    finally {
      setSite(before?.origin, before?.slashed === true ? 'always' : 'never')
      await Promise.all([open.close(), fixed.close()])
    }
  })
})

describe('an auth library that cannot name its origin', () => {
  it('still answers 401 with a pointer built from the request, as kayjs-auth does in production with no site set', async () => {
    const unnamed = await testSite({ routes, api, mcp: true, islands: false, locals: request => ({ ...locals(request), auth: { oauthResource: () => null, oauthOrigin: () => undefined, oauthFixed: () => false } }) })
    const before = configuredSite()

    try {
      setSite(undefined)

      const refused = await rpc(unnamed, 'tools/call', { name: 'wipe', arguments: { confirm: true } })

      expect(refused.response.status).toBe(401)
      expect(refused.response.headers.get('www-authenticate')).toBe('Bearer resource_metadata="http://localhost/.well-known/oauth-protected-resource"')
      expect((await unnamed.fetch('/.well-known/oauth-protected-resource')).status).toBe(404)
    }
    finally {
      setSite(before?.origin, before?.slashed === true ? 'always' : 'never')
      await unnamed.close()
    }
  })
})

describe('sign-in metadata an app serves itself', () => {
  it('gives way to the app\'s own route at that path instead of stopping the boot', async () => {
    const own = await testSite({ routes, api, mcp: true, islands: false, redirects: { '/.well-known/oauth-protected-resource': '/elsewhere' } })
    const response = await own.fetch('/.well-known/oauth-protected-resource')

    expect(response.status).toBe(308)
    expect(response.headers.get('location')).toBe('/elsewhere')
    expect((await own.fetch('/.well-known/oauth-protected-resource/mcp')).status).toBe(404)
    await own.close()
  })
})

describe('guards', () => {
  it('asks for a sign-in with 401 and a pointer to the resource metadata when a guard refuses', async () => {
    const response = await rpc(site, 'tools/call', { name: 'wipe', arguments: { confirm: true } })

    expect(response.response.status).toBe(401)
    expect(response.response.headers.get('www-authenticate')).toBe('Bearer resource_metadata="http://localhost/.well-known/oauth-protected-resource"')
    expect(response.body.result).toMatchObject({ isError: true })
  })

  it('puts the base in that pointer', async () => {
    const response = await rpc(mounted, 'tools/call', { name: 'wipe', arguments: { confirm: true } })

    expect(response.response.headers.get('www-authenticate')).toContain('http://localhost/shop/.well-known/oauth-protected-resource')
  })

  it('lets the guards and ctx.locals see the Authorization header, as for a fetch', async () => {
    const result = await site.mcp.call('wipe', { confirm: true }, { headers: BEARER })

    expect(result).toMatchObject({ isError: false, status: 200, data: { by: 'open' } })
  })

  it('answers a guard\'s 403 as a result, not a sign-in request', async () => {
    const result = await site.mcp.call('wipe', { confirm: true }, { headers: { authorization: 'Bearer reader' } })

    expect(result.status).toBe(200)
    expect(result).toMatchObject({ isError: true, text: 'Not for readers' })
  })

  it('does not read the guard\'s input before it, so a refused caller learns nothing of the schema', async () => {
    const result = await rpc(site, 'tools/call', { name: 'wipe', arguments: {} })

    expect(result.response.status).toBe(401)
  })

  it('guards an API route by the guards of its directory', async () => {
    expect((await rpc(site, 'tools/call', { name: 'get_private' })).response.status).toBe(401)
    expect((await site.mcp.call('get_private', {}, { headers: BEARER })).data).toEqual({ secret: 42 })
  })
})

describe('protection', () => {
  it('counts the rate limit by the caller, and keeps it for every call', async () => {
    const calls = []

    for (let call = 0; call < 3; call++)
      calls.push(await site.mcp.call('signup', { email: 'a@b.example' }))

    expect(calls.map(call => call.isError)).toEqual([false, false, true])
    expect((JSON.parse(calls[2]!.text) as { status: number }).status).toBe(429)
    expect((JSON.parse(calls[2]!.text) as { errors: Record<string, string> }).errors['']).toContain('Too many attempts')
  })

  it('counts the next test\'s client afresh, as each caller has its own limit', async () => {
    expect((await site.mcp.call('signup', { email: 'a@b.example' })).isError).toBe(false)
  })

  it('skips the honeypot, the minimum time and the proof of work, which only a form a person filled in can pass', async () => {
    expect((await site.mcp.call('solve')).text).toBe('solved')
    expect((await site.mcp.call('signup', { email: 'once@b.example' })).isError).toBe(false)
  })

  it('asks the proof of work of the same action called any other way, a forged marker header included', async () => {
    const url = '/_kay/action/tests/fixtures/mcp/src/routes/index.kay/solve'
    const headers = { 'content-type': 'application/json', 'x-kay-action': '1', 'origin': 'http://localhost' }
    const plain = await site.fetch(url, { method: 'POST', headers, body: encodeValue({}) })
    const forged = await site.fetch(url, { method: 'POST', headers: { ...headers, 'x-kay-agent': 'guess', 'x-kay-agent-client': '1.2.3.4' }, body: encodeValue({}) })

    expect(plain.status).toBe(422)
    expect(forged.status).toBe(422)
  })
})

describe('calling an API route', () => {
  it('fills the path and the query, and answers the JSON', async () => {
    const result = await site.mcp.call('get_notes_id', { id: 'n 1', fields: 'a&b', tags: ['x', 'y'] })

    expect(result.data).toEqual({ id: 'n 1', fields: 'a&b', tags: ['x', 'y'] })
  })

  it('sends the body of a post as JSON, only the fields the route declares', async () => {
    expect((await site.mcp.call('create_note', { title: 'Milk', pinned: true, extra: 1 })).data).toEqual({ created: 'Milk', pinned: true })
  })

  it('reads a value in the path as one segment, whatever it holds', async () => {
    for (const id of ['a/b', '../private', '..', '.', '', '%2e%2e', 'x?y=1#z'])
      expect((await site.mcp.call('get_notes_id', { id })).data?.id ?? 'refused').toBeOneOf([id, 'refused'])

    expect((await site.mcp.call('get_notes_id', { id: '../private' })).data).toEqual({ id: '../private', fields: null, tags: [] })
    expect((await site.mcp.call('get_notes_id', { id: '..' })).isError).toBe(true)
    expect((await site.mcp.call('get_notes_id', { id: '' })).isError).toBe(true)
    expect((await site.mcp.call('get_notes_id', {})).isError).toBe(true)
    expect((await site.mcp.call('get_notes_id', { id: { a: 1 } })).isError).toBe(true)
  })

  it('answers a route\'s refusal as a result with its text', async () => {
    const result = await site.mcp.call('get_notes_search', { limit: 'many' })

    expect(result.isError).toBe(true)
    expect(result.text.length).toBeGreaterThan(0)
    expect((await site.mcp.call('get_notes_search', { limit: 3 })).data).toEqual({ count: 3 })
  })

  it('gives a text answer as text and a binary one as its size', async () => {
    expect(await site.mcp.call('get_notes_words')).toMatchObject({ isError: false, text: 'plain words', data: undefined })
    expect((await site.mcp.call('get_notes_binary')).text).toBe('application/octet-stream, 3 bytes')
  })

  it('deletes with the id in the path and no body', async () => {
    expect((await site.mcp.call('delete_notes_id', { id: '7' })).data).toEqual({ deleted: '7' })
  })
})

describe('the OpenAPI document', () => {
  it('gives every operation an id, and lists the actions that are tools as POST operations', async () => {
    const document = await (await openapi.fetch('/api/openapi.json', { headers: BEARER })).json() as { paths: Record<string, Record<string, { 'operationId': string, 'tags': string[], 'summary'?: string, 'x-kay-action'?: boolean, 'x-kay-guards'?: string[] }>> }
    const operations = Object.values(document.paths).flatMap(methods => Object.values(methods))
    const ids = operations.map(operation => operation.operationId)

    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('create_note')
    expect(ids).toContain('get_notes_id')
    expect(document.paths['/_kay/action/tests/fixtures/mcp/src/routes/index.kay/signup']!.post).toMatchObject({ 'operationId': 'signup', 'summary': 'Sign up', 'tags': ['actions'], 'x-kay-action': true })
    expect(document.paths['/_kay/action/tests/fixtures/mcp/src/routes/index.kay/hidden']).toBeUndefined()
    expect(document.paths['/_kay/action/tests/fixtures/mcp/src/routes/admin/index.kay/wipe']!.post!['x-kay-guards']).toEqual(['tests/fixtures/mcp/src/routes/admin/_guard.ts'])
  })

  it('lists them without mcp too, as the document and the tools say the same', async () => {
    const only = await testSite({ routes, api, openapi: true, islands: false, locals })
    const document = await (await only.fetch('/api/openapi.json', { headers: BEARER })).json() as { paths: Record<string, unknown> }

    expect(Object.keys(document.paths)).toContain('/_kay/action/tests/fixtures/mcp/src/routes/index.kay/signup')
    await only.close()
  })
})

describe('a guarded API directory', () => {
  const asked = rpc

  it('refuses tools/list to a caller the API directory\'s guard refuses, with the sign-in pointer', async () => {
    const { response, body } = await asked(guarded, 'tools/list')

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe('Bearer resource_metadata="http://localhost/.well-known/oauth-protected-resource"')
    expect(body.result).toBeUndefined()
    expect(body.error?.message).toBe('Sign in')
    expect(JSON.stringify(body)).not.toContain('echo')
  })

  it('puts the base in that pointer, and lists to a caller the guard admits', async () => {
    const { response } = await asked(guardedMounted, 'tools/list')

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain('http://localhost/shop/.well-known/oauth-protected-resource')
    expect((await guardedMounted.mcp.tools({ headers: BEARER })).length).toBeGreaterThan(0)
  })

  it('keeps the guard\'s response headers on a refused tools/list, Retry-After of a 429 among them', async () => {
    const { response, body } = await asked(limited, 'tools/list')

    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('30')
    expect(response.headers.has('www-authenticate')).toBe(false)
    expect(body.error?.message).toBe('Slow down')
  })

  it('answers a call of a guarded tool and of an unknown name alike to a caller the directory guard refuses', async () => {
    const guardedTool = await asked(guarded, 'tools/call', { name: 'get_items_own_401' })
    const unknown = await asked(guarded, 'tools/call', { name: 'no_such_tool' })

    expect(unknown.response.status).toBe(401)
    expect(unknown.response.headers.get('www-authenticate')).toBe(guardedTool.response.headers.get('www-authenticate'))
    expect(unknown.body).toEqual(guardedTool.body)
    expect((await asked(limited, 'tools/call', { name: 'no_such_tool' })).response.status).toBe(429)
    expect((await asked(guarded, 'tools/call', { name: 'no_such_tool' }, BEARER)).body.error?.code).toBe(-32602)
    expect((await asked(site, 'tools/call', { name: 'no_such_tool' })).body.error?.code).toBe(-32602)
  })

  it('still answers initialize and ping to anyone', async () => {
    expect((await asked(guarded, 'ping')).response.status).toBe(200)
    expect((await asked(guarded, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).response.status).toBe(200)
  })

  it('refuses tools/list under requireGuards when the guards do not cover every module', async () => {
    const { response, body } = await asked(uncovered, 'tools/list', {}, BEARER)

    expect(response.status).toBe(403)
    expect(body.error?.message).toBe('No guard covers this route')
    expect((await asked(strict, 'tools/list')).response.status).toBe(401)
    expect((await strict.mcp.tools({ headers: BEARER })).length).toBeGreaterThan(0)
  })

  it('lists an action-only site\'s tools under requireGuards, and keeps its OpenAPI document refused', async () => {
    expect((await noApi.mcp.tools()).map(tool => tool.name)).toContain('add_note')
    expect((await noApi.fetch('/api/openapi.json')).status).toBe(403)
  })

  it('lists freely when the API directory has no guard and the site does not require them', async () => {
    expect((await asked(site, 'tools/list')).response.status).toBe(200)
  })

  it('keeps the guard\'s 401 a challenge on a call, and an API route\'s own 401 a result', async () => {
    const anonymous = await asked(guarded, 'tools/call', { name: 'get_items_own_401' })

    expect(anonymous.response.status).toBe(401)
    expect(anonymous.response.headers.has('www-authenticate')).toBe(true)

    const own = await asked(guarded, 'tools/call', { name: 'get_items_own_401' }, BEARER)

    expect(own.response.status).toBe(200)
    expect(own.response.headers.has('www-authenticate')).toBe(false)
    expect(own.body.result).toMatchObject({ isError: true, content: [{ text: 'Not yours' }] })
  })
})

describe('operation ids', () => {
  const methods = ['get', 'post', 'put', 'patch', 'delete']

  it('keeps an explicit id on an .all() route, one operation and tool per method', async () => {
    const document = await (await documentOnly.fetch('/api/openapi.json', { headers: BEARER })).json() as { paths: Record<string, Record<string, { operationId: string }>> }

    expect(Object.keys(document.paths['/api/items/echo']!).sort()).toEqual([...methods].sort())
    expect(methods.map(method => document.paths['/api/items/echo']![method]!.operationId)).toEqual(methods.map(method => `echo.any_${method}`))

    const tools = (await guarded.mcp.tools({ headers: BEARER })).map(tool => tool.name)

    for (const method of methods)
      expect(tools).toContain(`echo_any_${method}`)

    expect((await guarded.mcp.call('echo_any_put', {}, { headers: BEARER })).data).toEqual({ method: 'PUT' })
    expect((await guarded.mcp.call('echo_any_delete', {}, { headers: BEARER })).data).toEqual({ method: 'DELETE' })
  })

  it('leaves a chosen id as written in the OpenAPI document, and makes a safe tool name of it', async () => {
    const document = await (await documentOnly.fetch('/api/openapi.json', { headers: BEARER })).json() as { paths: Record<string, Record<string, { operationId: string }>> }

    expect(document.paths['/api/items']!.get!.operationId).toBe('users.list')
    expect(document.paths['/api/items']!.post!.operationId).toBe('users_list')

    const tools = (await guarded.mcp.tools({ headers: BEARER })).map(tool => tool.name)

    expect(tools).toContain('users_list')
    expect(tools).toContain('users_list_2')
    expect(tools.every(name => (/^\w{1,64}$/).test(name))).toBe(true)
    expect(new Set(tools).size).toBe(tools.length)
  })

  it('keeps ids unique in the document when two choose the same', async () => {
    const document = await (await documentOnly.fetch('/api/openapi.json', { headers: BEARER })).json() as { paths: Record<string, Record<string, { operationId: string }>> }
    const ids = Object.values(document.paths).flatMap(each => Object.values(each).map(operation => operation.operationId))

    expect(new Set(ids).size).toBe(ids.length)
    expect(document.paths['/api/items/dup-a']!.get!.operationId).toBe('same')
    expect(document.paths['/api/items/dup-b']!.get!.operationId).toBe('same_2')
  })
})

describe('tool names', () => {
  it('keeps the document\'s ids and the tools\' names the same when a chosen id and an action sanitise alike', async () => {
    const document = await (await names.fetch('/api/openapi.json')).json() as { paths: Record<string, Record<string, { operationId: string }>> }
    const ids = Object.values(document.paths).flatMap(each => Object.values(each).map(operation => operation.operationId))
    const tools = (await names.mcp.tools()).map(tool => tool.name)

    expect(document.paths['/api/items']!.get!.operationId).toBe('a.b')
    expect(ids.sort()).toEqual(['a.b', 'a_b_2'])
    expect(tools.sort()).toEqual(['a_b', 'a_b_2'])
    expect((await names.mcp.call('a_b_2')).data).toBeUndefined()
    expect((await names.mcp.call('a_b_2')).text).toBe('action')
  })

  it('keeps tool names unique when two ids differ only after the 64th character', async () => {
    const document = await (await longNames.fetch('/api/openapi.json')).json() as { paths: Record<string, Record<string, { operationId: string }>> }
    const ids = Object.values(document.paths).flatMap(each => Object.values(each).map(operation => operation.operationId))
    const tools = (await longNames.mcp.tools()).map(tool => tool.name)

    expect(tools.every(name => name.length <= 64)).toBe(true)
    expect(tools.sort()).toEqual([`${'x'.repeat(62)}_2`, 'x'.repeat(64)])
    expect(ids).toContain(`${'x'.repeat(62)}_2`)
  })
})

describe('the test helper', () => {
  it('sends the cookies so far with a call', async () => {
    guarded.cookies.set('session', 'abc')

    expect((await guarded.mcp.call('get_items_cookie', {}, { headers: BEARER })).data).toEqual({ seen: 'abc' })
    guarded.cookies.delete('session')
    expect((await guarded.mcp.call('get_items_cookie', {}, { headers: BEARER })).data).toEqual({ seen: null })
  })
})

describe('kay check', () => {
  const COVERED = '--- server\nimport { t } from \'elysia\'\nimport { action } from \'kay\'\n\nexport const covered = action(t.Object({}), () => 1, { tool: true, honeypot: \'website\' })\n---\nh1 Covered\n'

  const reported = async (dir: string, mcp: boolean, lints?: object) => (await writeShadowTypes(dir, { routes: 'src/routes', api: 'src/api', mcp, lints })).problems.filter(found => found.code === 'unguarded-tool').map(found => [relative(dir, found.file), found.message.match(/`(\w+)`/)![1]])

  it('warns of a tool action with bot protection that no guard covers, and of that alone', async () => {
    const dir = await fixtureCopy('mcp')

    await Bun.write(join(dir, 'src/routes/admin/covered.kay'), COVERED)

    expect(await reported(dir, true)).toEqual([['src/routes/index.kay', 'signup'], ['src/routes/index.kay', 'solve']])
  })

  it('counts an options spread as bot protection, and leaves out options it cannot read', async () => {
    const dir = await fixtureCopy('mcp')
    const page = (options: string) => `--- server\nimport { action } from 'kay'\n\nconst shared = { rateLimit: { max: 1, window: '1m' } }\n\nexport const spread = action(() => 1, ${options})\n---\nh1 Spread\n`

    await Bun.write(join(dir, 'src/routes/spread.kay'), page('{ tool: true, ...shared }'))
    await Bun.write(join(dir, 'src/routes/opaque.kay'), page('shared').replace('spread', 'opaque'))
    expect((await reported(dir, true)).filter(([file]) => file !== 'src/routes/index.kay')).toEqual([['src/routes/spread.kay', 'spread']])
  })

  it('reports each route where it is written, not at the start of its chain', async () => {
    const dir = await fixtureCopy('mcp')
    const found = (await writeShadowTypes(dir, { routes: 'src/routes', api: 'src/api', mcp: true })).problems.find(problem => problem.code === 'deprecated-api-tool')!
    const line = (await Bun.file(found.file).text()).split('\n')[found.line - 1]!

    expect(line).toContain('/internal')
  })

  it('says nothing without mcp, or when the lint is allowed', async () => {
    const dir = await fixtureCopy('mcp')

    expect(await reported(dir, false)).toEqual([])
    expect(await reported(dir, true, { 'unguarded-tool': 'allow' })).toEqual([])
  })

  it('refuses a page at the endpoint\'s path', async () => {
    const dir = await fixtureCopy('mcp-clash')
    const problems = await bootProblems(dir, { routes: 'src/routes', mcp: true })

    expect(problems.some(problem => problem.message.includes('`mcp` both serve /mcp'))).toBe(true)
  })
})

describe('routes opt in to being tools', () => {
  const LEFT_OUT = ['get_notes_internal', 'get_notes_hidden', 'get_notes_both', 'get_items_internal']

  it('lists a route that sets tool and none that does not, the hidden one included even with tool', async () => {
    const names = (await site.mcp.tools()).map(tool => tool.name)

    expect(names).toContain('get_notes_words')

    for (const left of LEFT_OUT)
      expect(names).not.toContain(left)
  })

  it('refuses a call naming a route that did not opt in as an unknown tool, as a name nothing has', async () => {
    const unknown = await rpc(site, 'tools/call', { name: 'get_notes_internal' }, BEARER)
    const missing = await rpc(site, 'tools/call', { name: 'no_such_tool' }, BEARER)

    expect(unknown.response.status).toBe(missing.response.status)
    expect(unknown.body.error).toEqual({ code: missing.body.error!.code, message: 'Unknown tool: get_notes_internal' })
  })

  it('keeps the route in the OpenAPI document, tool or not, and a hidden route out of it', async () => {
    const document = await (await openapi.fetch('/api/openapi.json', { headers: BEARER })).json() as { paths: Record<string, Record<string, { 'operationId': string, 'x-kay-tool'?: unknown }>> }

    expect(document.paths['/api/notes/internal']!.get!.operationId).toBe('get_notes_internal')
    expect(document.paths['/api/notes/internal']!.get!['x-kay-tool']).toBeUndefined()
    expect(document.paths['/api/notes/words']!.get!['x-kay-tool']).toEqual({})
    expect(document.paths['/api/notes/hidden']).toBeUndefined()
    expect(document.paths['/api/notes/both']).toBeUndefined()
  })

  it('takes the name and the description a route sets, as an action does', async () => {
    const tools = await site.mcp.tools()
    const named = tools.find(tool => tool.name === 'tagged_note')!
    const described = tools.find(tool => tool.name === 'get_notes_described')!

    expect(named.description).toBe('A note by its tag')
    expect(described.description).toBe('What an agent reads')
    expect((await site.mcp.call('tagged_note', {})).text).toBe('tagged')
  })

  it('names the operation after the tool when it sets no id, and keeps an id it sets', async () => {
    const document = await (await openapi.fetch('/api/openapi.json', { headers: BEARER })).json() as { paths: Record<string, Record<string, { operationId: string }>> }

    expect(document.paths['/api/notes/tagged']!.get!.operationId).toBe('tagged_note')
    expect(document.paths['/api/notes/described']!.get!.operationId).toBe('get_notes_described')
  })

  it('serves the same tools under a base and a trailing slash, and refuses a route that did not opt in there too', async () => {
    expect((await mounted.mcp.tools()).map(tool => tool.name)).not.toContain('get_notes_internal')
    expect((await mounted.mcp.call('get_notes_words')).text).toBe('plain words')
    expect((await rpc(mounted, 'tools/call', { name: 'get_notes_internal' })).body.error?.message).toBe('Unknown tool: get_notes_internal')
  })

  it('lists the same tools in a localized site', async () => {
    expect((await localized.mcp.tools()).map(tool => tool.name)).not.toContain('get_notes_internal')
  })

  it('offers an .all() route that sets tool once per method, and one that does not never', async () => {
    const names = (await guarded.mcp.tools({ headers: BEARER })).map(tool => tool.name)

    expect(names).toContain('echo_any_get')
    expect(names).not.toContain('get_items_internal')
  })

  it('keeps the directory guard on a route that opted in', async () => {
    expect((await rpc(guarded, 'tools/call', { name: 'get_items_cookie' })).response.status).toBe(401)
    expect((await guarded.mcp.call('get_items_cookie', {}, { headers: BEARER })).isError).toBe(false)
  })

  it('names each method of an .all() route after the tool name it sets', async () => {
    const all = await testSite({ routes: 'tests/fixtures/mcp-names/src/routes', api: 'tests/fixtures/mcp-names/src/api', mcp: true, islands: false })

    expect((await all.mcp.tools()).map(tool => tool.name).sort()).toEqual(['a_b', 'a_b_2'])
    await all.close()
  })
})

describe('a tool call an app can tell', () => {
  const calls: (ReturnType<typeof toolCall>)[] = []
  const seen = new Elysia().onRequest(({ request }) => {
    if (new URL(request.url).pathname !== '/mcp')
      calls.push(toolCall(request))
  })
  const front = testSite({ routes: 'tests/fixtures/mcp-seen/src/routes', api: 'tests/fixtures/mcp-seen/src/api', mcp: true, islands: false, use: [seen] })
  const KEY = { authorization: 'Bearer key' }
  const ACTION = '/_kay/action/tests/fixtures/mcp-seen/src/routes/index.kay/ping'

  afterAll(async () => (await front).close())

  it('is seen from a hook registered before pages(), for an action and for a route, with the tool each calls', async () => {
    const site = await front

    calls.length = 0
    await site.mcp.call('ping', {}, { headers: KEY })
    await site.mcp.call('get_seen', {}, { headers: KEY })
    expect(calls.map(call => call?.tool)).toEqual(['ping', 'get_seen'])
    expect(calls.every(call => typeof call?.client === 'string')).toBe(true)
  })

  it('is seen from a kay guard, so a bearer key reaches the tools and nothing else', async () => {
    const site = await front

    expect((await site.mcp.tools({ headers: KEY })).map(tool => tool.name).sort()).toEqual(['get_seen', 'ping'])
    expect((await site.mcp.call('ping', {}, { headers: KEY })).isError).toBe(false)
    expect((await site.mcp.call('get_seen', {}, { headers: KEY })).data).toEqual({ tool: 'get_seen' })
    expect((await site.fetch('/api/seen', { headers: KEY })).status).toBe(403)
    expect((await site.fetch(ACTION, { method: 'POST', headers: { ...KEY, 'content-type': 'application/json', 'x-kay-action': '1', 'origin': 'http://localhost' }, body: encodeValue({}) })).status).toBe(403)
    expect((await site.fetch('/', { headers: KEY })).status).toBe(403)
  })

  it('is no tool call for a client sending the marker headers itself, a guessed value or the header names', async () => {
    const site = await front

    calls.length = 0

    const forged = await site.fetch('/api/seen', { headers: { ...KEY, 'x-kay-agent': 'guess', 'x-kay-agent-tool': 'get_seen', 'x-kay-agent-client': '1.2.3.4' } })

    expect(forged.status).toBe(403)
    expect(calls).toEqual([undefined])
  })

  it('is told from the handler too, after the markers are dropped from the request', async () => {
    const result = await site.mcp.call('get_notes_who', {}, { headers: BEARER })

    expect(result.data).toEqual({ tool: 'get_notes_who' })
    expect((await (await site.fetch('/api/notes/who', { headers: { ...BEARER, 'x-kay-agent': 'guess', 'x-kay-agent-tool': 'x' } })).json())).toEqual({ tool: null })
  })

  it('is seen through the app.handle fallback of a site without a server too', async () => {
    const result = await mounted.mcp.call('get_notes_who')

    expect(result.data).toEqual({ tool: 'get_notes_who' })
  })
})

describe('kay check on routes that opt in', () => {
  const codes = async (dir: string, mcp = true, lints?: object) => (await writeShadowTypes(dir, { routes: 'src/routes', api: 'src/api', mcp, lints })).problems.filter(found => found.code === 'deprecated-api-tool' || found.code === 'hidden-tool').map(found => [found.code, found.message.match(/`([A-Z]+ [^`]+)`/)![1]])

  it('reports a route relying on the old default, and the one that hides and opts in, and nothing else', async () => {
    const dir = await fixtureCopy('mcp')

    expect((await codes(dir)).sort()).toEqual([
      ['deprecated-api-tool', 'GET /internal'],
      ['hidden-tool', 'GET /both'],
    ])
  })

  it('offers a fix that opts the route in, which is none for kay check --fix to apply', async () => {
    const dir = await fixtureCopy('mcp')
    const found = (await writeShadowTypes(dir, { routes: 'src/routes', api: 'src/api', mcp: true })).problems.find(problem => problem.code === 'deprecated-api-tool')!

    expect(found.fixes?.[0]?.safe).toBeUndefined()
    expect(found.fixes?.[0]?.edits[0]?.text).toBe(', { detail: { tool: true } }')
  })

  it('reads a route with no options, a detail without tool, and leaves out what it cannot read', async () => {
    const dir = await fixtureCopy('mcp')

    await Bun.write(join(dir, 'src/api/more.ts'), [
      'import { api } from \'kay/server\'',
      'const options = { detail: { hide: true } }',
      'export default api()',
      '  .post(\'/bare\', () => 1)',
      '  .put(\'/summary\', () => 1, { detail: { summary: \'x\' } })',
      '  .get(\'/held\', () => 1, options)',
      '  .patch(\'/off\', () => 1, { detail: { tool: false } })',
      'const cache = new Map()',
      'cache.get(\'key\', () => 1)',
      'const app = api()',
      'app.get(\'/named\', () => 1)',
      '  .delete(\'/hidden\', () => 1, { detail: { hide: true } })',
      '  .get(\'/spread\', () => 1, { ...options })',
      '',
    ].join('\n'))

    const found = (await codes(dir)).filter(([, route]) => !route!.endsWith('/internal') && !route!.endsWith('/both'))

    expect(found.sort()).toEqual([['deprecated-api-tool', 'GET /named'], ['deprecated-api-tool', 'POST /bare'], ['deprecated-api-tool', 'PUT /summary']])
  })

  it('reads api() under an aliased import, a namespace import, a reassigned let and a helper of the file, and not an api of another module', async () => {
    const dir = await fixtureCopy('mcp')
    const only = async (name: string, lines: string[]) => {
      await Bun.write(join(dir, 'src/api/more.ts'), `${lines.join('\n')}\n`)

      return (await codes(dir)).filter(([, route]) => !route!.endsWith('/internal') && !route!.endsWith('/both')).map(([, route]) => `${name} ${route}`)
    }

    expect(await only('alias', ['import { api as server } from \'kay/server\'', 'export default server().get(\'/a\', () => 1)'])).toEqual(['alias GET /a'])
    expect(await only('aliased-const', ['import { api as server } from \'kay/server\'', 'const app = server()', 'export default app.get(\'/a\', () => 1)'])).toEqual(['aliased-const GET /a'])
    expect(await only('namespace', ['import * as kay from \'kay/server\'', 'export default kay.api().get(\'/a\', () => 1)'])).toEqual(['namespace GET /a'])
    expect(await only('let', ['import { api } from \'kay/server\'', 'let app', 'app = api()', 'export default app.get(\'/a\', () => 1)'])).toEqual(['let GET /a'])
    expect((await only('helper', ['import { api } from \'kay/server\'', 'function base() { return api().get(\'/b\', () => 1) }', 'const arrow = () => api()', 'const one = base()', 'export default one.get(\'/a\', () => 1)', 'arrow().post(\'/c\', () => 1)'])).sort()).toEqual(['helper GET /a', 'helper GET /b', 'helper POST /c'])
    expect(await only('other', ['import { api } from \'./my-api\'', 'export default api().get(\'/a\', () => 1)'])).toEqual([])
    expect(await only('none', ['const api = () => ({ get: (path: string, run: () => number) => run() })', 'export default api().get(\'/a\', () => 1)'])).toEqual([])
  })

  it('says nothing without mcp, or when the lints are allowed', async () => {
    const dir = await fixtureCopy('mcp')

    expect(await codes(dir, false)).toEqual([])
    expect(await codes(dir, true, { 'deprecated-api-tool': 'allow', 'hidden-tool': 'allow' })).toEqual([])
  })

  it('speaks to an app upgrading from before 1.51 alone, not to one turning mcp on since', async () => {
    const dir = await fixtureCopy('mcp')
    const before = process.env[UPGRADE_FROM]

    try {
      delete process.env[UPGRADE_FROM]
      expect(await codes(dir)).toEqual([['hidden-tool', 'GET /both']])
      process.env[UPGRADE_FROM] = '1.51.2'
      expect(await codes(dir)).toEqual([['hidden-tool', 'GET /both']])
      process.env[UPGRADE_FROM] = '1.50.4'
      expect((await codes(dir)).map(([code]) => code).sort()).toEqual(['deprecated-api-tool', 'hidden-tool'])
    }
    finally {
      process.env[UPGRADE_FROM] = before
    }
  })
})
