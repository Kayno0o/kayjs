import { join, relative } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { writeShadowTypes } from '../src/check'
import { bootProblems } from '../src/check/boot'
import { encodeValue } from '../src/runtime/wire'
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
const guardedMounted = await testSite({ routes, api: guardedApi, mcp: true, islands: false, base: '/shop' })
// Guards that cover every module, and guards that cover only one of them.
const strict = await testSite({ routes, api: guardedApi, mcp: true, islands: false, requireGuards: true })
const uncovered = await testSite({ routes, api, mcp: true, islands: false, requireGuards: true })
// A site with tool actions and no API module has no guard to add, so requireGuards leaves its list open.
const noApi = await testSite({ routes, api: 'tests/fixtures/mcp/src/none', mcp: true, islands: false, requireGuards: true })
const documentOnly = await testSite({ routes, api: guardedApi, openapi: true, islands: false })
const localized = await testSite({ routes, api, mcp: true, islands: false, i18n: { locales: ['fr', 'en'], defaultLocale: 'fr', messages: 'tests/fixtures/i18n/src/messages' } })

afterAll(async () => {
  await Promise.all([site.close(), off.close(), mounted.close(), localized.close(), openapi.close(), guarded.close(), guardedMounted.close(), strict.close(), uncovered.close(), noApi.close(), documentOnly.close()])
})

async function post(target: typeof site, body: unknown, headers: Record<string, string> = {}) {
  return target.fetch('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })
}

async function rpc(target: typeof site, method: string, params: object = {}, headers: Record<string, string> = {}) {
  const response = await post(target, { jsonrpc: '2.0', id: 1, method, params }, headers)

  return { response, body: await response.json() as { result?: Record<string, unknown> & { capabilities?: Record<string, unknown> }, error?: { code: number, message: string } } }
}

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
  it('lists the actions that set tool and the routes of the OpenAPI document, nothing else', async () => {
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
      'get_notes_binary',
      'get_notes_id',
      'get_notes_search',
      'get_notes_words',
      'get_private',
      'language',
      'refuses',
      'sends_away',
      'signup',
      'solve',
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

  it('lists an action-only site\'s tools under requireGuards', async () => {
    expect((await noApi.mcp.tools()).map(tool => tool.name)).toContain('add_note')
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

describe('the test helper', () => {
  it('sends the cookies so far with a call, and takes from as call does', async () => {
    guarded.cookies.set('session', 'abc')

    expect((await guarded.mcp.call('get_items_cookie', {}, { headers: BEARER, from: '/' })).data).toEqual({ seen: 'abc' })
    expect((await guarded.mcp.tools({ headers: BEARER, from: '/' })).length).toBeGreaterThan(0)
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
