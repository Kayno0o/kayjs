import * as fs from 'node:fs'
import { existsSync, statSync } from 'node:fs'
import { chmod, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import { dropStore, NOT_FOUND_FILE } from '../src/server/not-found'
import { testSite } from '../src/test'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

const ROOT = 'tests/fixtures/mcp-key'
const KEY = 'a-long-secret-key-0123456789'
const OTHER = 'another-secret-key-9876543210'
const HEADER = 'x-upstream-key'
const PROXY_KEY = 'p'.repeat(40)
const VARIABLES = ['NODE_ENV', 'KAY_MCP_KEY', 'KAY_MCP_KEY_FILE', 'KAY_PROXY_KEY', 'KAY_PROXY_KEY_FILE']

// A production server counts the paths it answered 404 in the working folder's store, which this file leaves as it found it.
const storeKept = existsSync(NOT_FOUND_FILE)
const folderKept = existsSync(dirname(NOT_FOUND_FILE))

afterAll(async () => {
  dropStore()

  if (!storeKept)
    await rm(NOT_FOUND_FILE, { force: true })

  if (!folderKept)
    await rm(dirname(NOT_FOUND_FILE), { force: true, recursive: true })
})

type Options = NonNullable<Parameters<typeof pages>[0]>
type App = Awaited<ReturnType<typeof pages>>

// Serves the fixture with the environment given (a test run unless it says otherwise), and puts the environment back.
async function served(env: Record<string, string | undefined>, options: Options): Promise<App> {
  const before = VARIABLES.map(name => process.env[name])
  const wanted: Record<string, string | undefined> = { NODE_ENV: 'test', ...env }

  for (const name of VARIABLES) {
    if (wanted[name] === undefined)
      delete process.env[name]
    else
      process.env[name] = wanted[name]
  }

  try {
    return await pages({ root: ROOT, prebuilt: false, ...options })
  }
  finally {
    for (const [index, name] of VARIABLES.entries()) {
      if (before[index] === undefined)
        delete process.env[name]
      else
        process.env[name] = before[index]
    }
  }
}

const message = (method: string, params: object = {}) => ({ jsonrpc: '2.0', id: 1, method, params })

async function post(app: App, body: unknown, headers: Record<string, string> = {}, path = '/mcp'): Promise<Response> {
  const text = typeof body === 'string' ? body : JSON.stringify(body)

  return app.handle(new Request(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: text }))
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` })

async function toolNames(app: App, headers: Record<string, string>): Promise<string[]> {
  const body = await (await post(app, message('tools/list'), headers)).json() as { result: { tools: { name: string }[] } }

  return body.result.tools.map(tool => tool.name).sort()
}

async function refused(response: Response): Promise<void> {
  const text = await response.text()

  expect(response.status).toBe(401)
  expect(response.headers.get('www-authenticate')).toBe('Bearer realm="mcp"')
  expect(JSON.parse(text)).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Send the MCP key as a bearer token' } })
}

describe('the key', () => {
  it('serves a request carrying it and refuses every other value alike', async () => {
    const app = await served({}, { mcp: { key: KEY, rateLimit: false } })

    expect(await toolNames(app, bearer(KEY))).toEqual(['add', 'greet', 'seen'])

    const wrong = [undefined, '', ' ', 'x', KEY.slice(0, -1), `${KEY}x`, `${KEY.slice(0, -1)}y`, KEY.slice(1), KEY.toUpperCase(), OTHER, KEY.repeat(2)]

    for (const key of wrong)
      await refused(await post(app, message('tools/list'), key === undefined ? {} : bearer(key)))
  })

  it('answers every kind of message with the refusal and runs nothing', async () => {
    const app = await served({}, { mcp: { key: KEY, rateLimit: false } })
    const bodies = [message('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }), message('ping'), message('tools/list'), message('tools/call', { name: 'greet', arguments: { name: 'x' } }), message('tools/call', { name: 'no_such_tool' }), { jsonrpc: '2.0', method: 'notifications/initialized' }, [message('tools/list')], 'not json', '', '{}']

    for (const body of bodies)
      await refused(await post(app, body))
  })

  it('leaves GET and DELETE the 405 they are, and the sign-in metadata open', async () => {
    const app = await served({}, { mcp: { key: KEY } })

    for (const method of ['GET', 'DELETE']) {
      for (const headers of [{}, bearer(KEY), bearer(OTHER)]) {
        const response = await app.handle(new Request('http://localhost/mcp', { method, headers }))

        expect(response.status).toBe(405)
        expect(response.headers.get('allow')).toBe('POST')
      }
    }

    expect((await app.handle(new Request('http://localhost/.well-known/oauth-protected-resource'))).status).toBe(404)
  })

  it('reads the scheme in any case and refuses anything but one bearer token', async () => {
    const app = await served({}, { mcp: { key: KEY, rateLimit: false } })

    for (const authorization of [`Bearer ${KEY}`, `bearer ${KEY}`, `BEARER ${KEY}`, `BeArEr   ${KEY}`])
      expect((await post(app, message('ping'), { authorization })).status).toBe(200)

    const others = [KEY, `Basic ${KEY}`, `Token ${KEY}`, 'Bearer', 'Bearer ', `Bearer${KEY}`, `Bearer ${KEY} extra`, `Bearer ${KEY},Bearer ${KEY}`, `Bearer ${OTHER}, Bearer ${KEY}`, `Bearer "${KEY}"`, `Bearer\t${KEY}`]

    for (const authorization of others)
      await refused(await post(app, message('ping'), { authorization }))

    // Neither another header nor the query is the key.
    await refused(await post(app, message('ping'), { 'x-api-key': KEY, 'x-mcp-key': KEY, 'cookie': `key=${KEY}` }))
    await refused(await post(app, message('ping'), {}, `/mcp?key=${KEY}&access_token=${KEY}`))
  })

  it('does not tell a missing key from a wrong one, or leak the key in the refusal', async () => {
    const app = await served({}, { mcp: { key: KEY } })
    const missing = await post(app, message('tools/list'))
    const wrong = await post(app, message('tools/list'), bearer(OTHER))
    const text = await wrong.text()

    expect(await missing.text()).toBe(text)
    expect(text).not.toContain(KEY)
    expect(text).not.toContain(OTHER)
  })

  it('counts the refused requests against the rate limit, so guessing is bounded', async () => {
    const app = await served({}, { mcp: { key: KEY, rateLimit: 3 }, proxy: { hops: 1 } })
    // A client of its own, as the counts are the process's.
    const client = { 'x-forwarded-for': '203.0.113.77' }

    for (let n = 0; n < 3; n++)
      expect((await post(app, message('ping'), { ...bearer(OTHER), ...client })).status).toBe(401)

    expect((await post(app, message('ping'), { ...bearer(OTHER), ...client })).status).toBe(429)
    expect((await post(app, message('ping'), { ...bearer(KEY), ...client })).status).toBe(429)
  })
})

describe('the tools it admits', () => {
  it('runs a route and an action with the key, and hands neither the bearer', async () => {
    const app = await served({}, { mcp: { key: KEY, rateLimit: false } })
    const seen = await (await post(app, message('tools/call', { name: 'seen' }), bearer(KEY))).json() as { result: { structuredContent: unknown } }
    const greeted = await (await post(app, message('tools/call', { name: 'greet', arguments: { name: 'Ada' } }), bearer(KEY))).json() as { result: { content: { text: string }[] } }
    const added = await (await post(app, message('tools/call', { name: 'add', arguments: { name: 'Ada' } }), bearer(KEY))).json() as { result: { structuredContent: unknown } }

    expect(seen.result.structuredContent).toEqual({ authorization: null, tool: 'seen' })
    expect(greeted.result.content[0]!.text).toContain('hi Ada')
    expect(added.result.structuredContent).toEqual({ added: 'Ada' })
  })

  it('keeps the bearer for an endpoint without a key, as it did', async () => {
    const app = await served({}, { mcp: true })
    const seen = await (await post(app, message('tools/call', { name: 'seen' }), { authorization: 'Bearer anything' })).json() as { result: { structuredContent: unknown } }

    expect(seen.result.structuredContent).toEqual({ authorization: 'Bearer anything', tool: 'seen' })
    expect((await post(app, message('ping'))).status).toBe(200)
  })

  it('treats a header an outside client sends as no tool call, and asks no key of a route the endpoint does not serve', async () => {
    const app = await served({}, { mcp: { key: KEY } })
    const forged = await app.handle(new Request('http://localhost/api/echo/seen', { headers: { 'x-kay-agent': 'guess', 'x-kay-agent-tool': 'seen', 'x-kay-agent-client': '1.2.3.4', 'x-kay-agent-from': 'http://localhost/mcp' } }))

    expect(forged.status).toBe(200)
    expect(await forged.json()).toEqual({ authorization: null, tool: null })
  })
})

describe('where the key comes from', () => {
  it('reads KAY_MCP_KEY, else the file KAY_MCP_KEY_FILE names, trimmed', async () => {
    const dir = await scratchDir('mcp-key-')
    const file = join(dir, 'key')

    await writeFile(file, `${KEY}\n`)

    const fromVariable = await served({ KAY_MCP_KEY: ` ${KEY} ` }, { mcp: { key: true } })
    const fromFile = await served({ KAY_MCP_KEY_FILE: file }, { mcp: { key: true } })
    const both = await served({ KAY_MCP_KEY: OTHER, KAY_MCP_KEY_FILE: file }, { mcp: { key: true } })

    expect((await post(fromVariable, message('ping'), bearer(KEY))).status).toBe(200)
    await refused(await post(fromVariable, message('ping'), bearer(OTHER)))
    expect((await post(fromFile, message('ping'), bearer(KEY))).status).toBe(200)
    expect((await post(both, message('ping'), bearer(OTHER))).status).toBe(200)
    await refused(await post(both, message('ping'), bearer(KEY)))
  })

  it('takes a rotated key at the next boot, and refuses the old one', async () => {
    const dir = await scratchDir('mcp-key-')
    const file = join(dir, 'key')

    await writeFile(file, KEY)

    const before = await served({ KAY_MCP_KEY_FILE: file }, { mcp: { key: true } })

    await writeFile(file, OTHER)

    const after = await served({ KAY_MCP_KEY_FILE: file }, { mcp: { key: true } })

    // Read once, at boot: the server that started with the old key keeps it.
    expect((await post(before, message('ping'), bearer(KEY))).status).toBe(200)
    await refused(await post(before, message('ping'), bearer(OTHER)))
    expect((await post(after, message('ping'), bearer(OTHER))).status).toBe(200)
    await refused(await post(after, message('ping'), bearer(KEY)))
  })

  it('makes the key in { file } on first use, private, and reuses it', async () => {
    const dir = await scratchDir('mcp-key-')
    const file = join(dir, 'data', 'mcp-key')
    const first = await served({}, { mcp: { key: { file } } })
    const made = (await readFile(file, 'utf8')).trim()

    expect(made.length).toBeGreaterThanOrEqual(32)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700)
    expect((await post(first, message('ping'), bearer(made))).status).toBe(200)
    await refused(await post(first, message('ping'), bearer(OTHER)))

    const second = await served({}, { mcp: { key: { file } } })

    expect((await post(second, message('ping'), bearer(made))).status).toBe(200)
    expect((await readFile(file, 'utf8')).trim()).toBe(made)
  })

  it('makes the key in place on a filesystem without hard links, leaving no other file', async () => {
    const dir = await scratchDir('mcp-key-')
    const file = join(dir, 'mcp-key')
    const refusing = spyOn(fs, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    })

    try {
      const app = await served({}, { mcp: { key: { file } } })
      const made = (await readFile(file, 'utf8')).trim()

      expect(refusing).toHaveBeenCalled()
      expect(made.length).toBeGreaterThanOrEqual(32)
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect((await post(app, message('ping'), bearer(made))).status).toBe(200)
      expect((await readdir(dir)).sort()).toEqual(['mcp-key'])
    }
    finally {
      refusing.mockRestore()
    }
  })

  it('lets the environment win over { file }, and makes no file then', async () => {
    const dir = await scratchDir('mcp-key-')
    const file = join(dir, 'mcp-key')
    const app = await served({ KAY_MCP_KEY: KEY }, { mcp: { key: { file } } })

    expect((await post(app, message('ping'), bearer(KEY))).status).toBe(200)
    expect(existsSync(file)).toBe(false)
  })

  it('refuses a key that is too short, empty or unreadable, wherever it comes from', async () => {
    const dir = await scratchDir('mcp-key-')
    const short = join(dir, 'short')
    const empty = join(dir, 'empty')
    const locked = join(dir, 'locked')

    await writeFile(short, 'short')
    await writeFile(empty, '\n')
    await writeFile(locked, KEY)
    await chmod(locked, 0o000)

    await expect(served({}, { mcp: { key: 'short' } })).rejects.toThrow('at least 16 characters')
    await expect(served({}, { mcp: { key: '   ' } })).rejects.toThrow('at least 16 characters')
    await expect(served({ KAY_MCP_KEY: 'short' }, { mcp: { key: true } })).rejects.toThrow('KAY_MCP_KEY')
    await expect(served({ KAY_MCP_KEY_FILE: short }, { mcp: { key: true } })).rejects.toThrow('at least 16 characters')
    await expect(served({ KAY_MCP_KEY_FILE: empty }, { mcp: { key: true } })).rejects.toThrow('at least 16 characters')
    await expect(served({ KAY_MCP_KEY_FILE: join(dir, 'missing') }, { mcp: { key: true } })).rejects.toThrow('cannot be read')
    await expect(served({}, { mcp: { key: { file: short } } })).rejects.toThrow('at least 16 characters')
    await expect(served({}, { mcp: { key: { file: empty } } })).rejects.toThrow('at least 16 characters')

    // A file mode is no barrier to root.
    if (process.getuid?.() !== 0)
      await expect(served({ KAY_MCP_KEY_FILE: locked }, { mcp: { key: true } })).rejects.toThrow('cannot be read')
  })

  it('refuses a key no bearer token could carry', async () => {
    for (const key of ['my secret key 12345', 'clé-secrète-0123456789', 'tab\tseparated-key-1234'])
      await expect(served({}, { mcp: { key } })).rejects.toThrow('visible ASCII')

    await expect(served({ KAY_MCP_KEY: 'has a space in it 123' }, { mcp: { key: true } })).rejects.toThrow('visible ASCII')
  })

  it('never lets a second boot meet a half-made key file', async () => {
    const dir = await scratchDir('mcp-key-')
    const file = join(dir, 'mcp-key')
    const apps = await Promise.all([1, 2, 3, 4].map(async () => served({}, { mcp: { key: { file } } })))
    const made = (await readFile(file, 'utf8')).trim()

    for (const app of apps)
      expect((await post(app, message('ping'), bearer(made))).status).toBe(200)

    expect((await readdir(dir)).sort()).toEqual(['mcp-key'])
  })

  it('refuses a setting that is none of the three', async () => {
    for (const key of [5, null, {}, { file: '' }, { file: 3 }, []])
      await expect(served({}, { mcp: { key: key as never } })).rejects.toThrow('mcp.key is')
  })

  it('leaves the endpoint open without a key setting, and with key: false', async () => {
    for (const mcp of [true, { key: false }, {}]) {
      const app = await served({ KAY_MCP_KEY: KEY }, { mcp })

      expect((await post(app, message('ping'))).status).toBe(200)
    }
  })
})

describe('in production and elsewhere', () => {
  it('does not boot in production with key: true and no key, and names where it is read', async () => {
    await expect(served({ NODE_ENV: 'production' }, { mcp: { key: true } })).rejects.toThrow('KAY_MCP_KEY')
    await expect(served({ NODE_ENV: 'production' }, { mcp: { key: true } })).rejects.toThrow('KAY_MCP_KEY_FILE')
  })

  it('refuses every request outside production while no key is given, whatever it sends', async () => {
    for (const NODE_ENV of ['test', 'development']) {
      const app = await served({ NODE_ENV }, { mcp: { key: true } })

      await refused(await post(app, message('ping')))
      await refused(await post(app, message('ping'), bearer(KEY)))
      await refused(await post(app, message('ping'), { authorization: 'Bearer ' }))
      await refused(await post(app, message('ping'), { authorization: 'Bearer undefined' }))
    }
  })

  it('checks the key in production, in development and in a test run alike', async () => {
    for (const NODE_ENV of ['production', 'development', 'test']) {
      const app = await served({ NODE_ENV, KAY_MCP_KEY: KEY }, { mcp: { key: true } })

      expect((await post(app, message('ping'), bearer(KEY))).status).toBe(200)
      await refused(await post(app, message('ping')))
      await refused(await post(app, message('ping'), bearer(OTHER)))
    }
  })

  it('checks the key under `dev`', async () => {
    const app = await served({ NODE_ENV: 'development', KAY_MCP_KEY: KEY }, { mcp: { key: true }, dev: true })

    expect((await post(app, message('ping'), bearer(KEY))).status).toBe(200)
    await refused(await post(app, message('ping')))
    await refused(await post(app, message('ping'), bearer(OTHER)))
  })
})

describe('behind proxy.key', () => {
  const production = { NODE_ENV: 'production', KAY_PROXY_KEY: PROXY_KEY, KAY_MCP_KEY: KEY }
  const proxy = { key: HEADER }

  it('needs no proxy.open for the endpoint, which the bearer guards', async () => {
    const app = await served(production, { proxy, mcp: { key: true, rateLimit: false } })

    expect((await post(app, message('ping'), bearer(KEY))).status).toBe(200)
    expect(await toolNames(app, bearer(KEY))).toEqual(['add', 'greet', 'seen'])
    // Through the proxy too, with both.
    expect((await post(app, message('ping'), { ...bearer(KEY), [HEADER]: PROXY_KEY })).status).toBe(200)
    // The proxy key is no substitute for the bearer, nor the bearer for the proxy key anywhere else.
    await refused(await post(app, message('ping'), { [HEADER]: PROXY_KEY }))
    await refused(await post(app, message('ping'), { ...bearer(OTHER), [HEADER]: PROXY_KEY }))
    await refused(await post(app, message('ping')))
    expect((await app.handle(new Request('http://localhost/', { headers: bearer(KEY) }))).status).toBe(403)
    expect((await app.handle(new Request('http://localhost/api/echo/seen', { headers: bearer(KEY) }))).status).toBe(403)
  })

  it('opens the endpoint alone, not what lies under it, nor a site without the key', async () => {
    const keyed = await served(production, { proxy, mcp: { key: true } })
    const plain = await served(production, { proxy, mcp: true })

    expect((await keyed.handle(new Request('http://localhost/mcp/other', { method: 'POST', headers: bearer(KEY) }))).status).toBe(403)
    expect((await keyed.handle(new Request('http://localhost/mcpx', { method: 'POST', headers: bearer(KEY) }))).status).toBe(403)
    expect((await post(plain, message('ping'), bearer(KEY))).status).toBe(403)
  })

  it('opens a POST alone, no other method on the path', async () => {
    const app = await served(production, { proxy, mcp: { key: true } })

    for (const method of ['GET', 'DELETE', 'PUT', 'PATCH', 'OPTIONS', 'HEAD'])
      expect((await app.handle(new Request('http://localhost/mcp', { method, headers: bearer(KEY) }))).status).toBe(403)
  })

  it('opens the endpoint where mcp.path puts it', async () => {
    const app = await served(production, { proxy, mcp: { key: true, path: '/tools' } })

    expect((await post(app, message('ping'), bearer(KEY), '/tools')).status).toBe(200)
    expect((await post(app, message('ping'), bearer(KEY), '/tools/')).status).toBe(200)
    await refused(await post(app, message('ping'), {}, '/tools/'))
    expect((await post(app, message('ping'), bearer(KEY), '/mcp')).status).toBe(403)
    await refused(await post(app, message('ping'), {}, '/tools'))
  })

  it('opens it under a base and a trailing slash', async () => {
    const app = await served(production, { proxy, mcp: { key: true }, base: '/shop', trailingSlash: 'always' })

    // The server hands the app the path without the base, and the check reads either.
    for (const path of ['/mcp', '/mcp/', '/shop/mcp', '/shop/mcp/'])
      expect((await post(app, message('ping'), bearer(KEY), path)).status).not.toBe(403)

    // The slash variant answers as the endpoint does, or is no route at all, never a page past the key.
    const slashed = await post(app, message('ping'), {}, '/mcp/')

    expect([401, 404]).toContain(slashed.status)

    expect((await post(app, message('ping'), bearer(KEY))).status).toBe(200)
    await refused(await post(app, message('ping'), {}))
    expect((await post(app, message('ping'), bearer(KEY), '/shop/elsewhere')).status).toBe(403)
    expect((await app.handle(new Request('http://localhost/shop/', { headers: bearer(KEY) }))).status).toBe(403)
  })
})

describe('testSite', () => {
  it('sends the key it is given with site.mcp, and a call can send another', async () => {
    const site = await testSite({ root: ROOT, mcp: true, mcpKey: KEY, islands: false })

    try {
      expect((await site.mcp.tools()).map(tool => tool.name).sort()).toEqual(['add', 'greet', 'seen'])
      expect((await site.mcp.call('add', { name: 'Ada' })).data).toEqual({ added: 'Ada' })
      await expect(site.mcp.tools({ headers: { Authorization: `Bearer ${OTHER}` } })).rejects.toThrow('MCP key')
      await expect(site.mcp.call('add', { name: 'Ada' }, { headers: { authorization: 'Bearer ' } })).rejects.toThrow('MCP key')
      expect((await site.mcp.tools({ headers: { AUTHORIZATION: `bearer ${KEY}` } })).length).toBe(3)

      const raw = await site.fetch('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message('ping')) })

      await refused(raw)
    }
    finally {
      await site.close()
    }
  })

  it('makes a key for a config that sets mcp.key, and keeps the site headers an authorization', async () => {
    const generated = await testSite({ root: ROOT, mcp: { key: true }, islands: false })
    const headed = await testSite({ root: ROOT, mcp: true, mcpKey: KEY, islands: false, headers: { authorization: `Bearer ${OTHER}` } })

    try {
      expect((await generated.mcp.tools()).length).toBe(3)
      await expect(headed.mcp.tools()).rejects.toThrow('MCP key')
      expect((await headed.mcp.tools({ headers: bearer(KEY) })).length).toBe(3)
    }
    finally {
      await Promise.all([generated.close(), headed.close()])
    }
  })

  it('serves the endpoint under a base and a trailing slash', async () => {
    const site = await testSite({ root: ROOT, mcp: true, mcpKey: KEY, islands: false, base: '/shop', trailingSlash: 'always' })

    try {
      expect((await site.mcp.tools()).length).toBe(3)
      await expect(site.mcp.tools({ headers: bearer(OTHER) })).rejects.toThrow('MCP key')
    }
    finally {
      await site.close()
    }
  })
})
