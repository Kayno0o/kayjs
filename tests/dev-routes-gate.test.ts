import type { Server } from 'bun'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'bun:test'
import { KayCompileError } from '../src/build/transform'
import { modeOf } from '../src/project'
import { bootFailure, DEV_A11Y, DEV_AXE, DEV_DATA, DEV_DATA_QUERY, DEV_DATA_ROWS, DEV_EVENTS, DEV_FOOTPRINT, DEV_HEAD, DEV_INSPECTOR, DEV_JOBS, DEV_JOBS_DELETE, DEV_JOBS_RETRY, DEV_NOT_FOUND, DEV_OPEN, DEV_PATCH, DEV_ROUTES, DEV_SIZES, DEV_STACK, DEV_STYLES, DEV_TAB, DEV_TOOL, DEV_UI } from '../src/server/dev'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

const HEADERS = { 'x-kay-dev': '1', 'content-type': 'application/json' }
const READS = [DEV_EVENTS, DEV_PATCH, DEV_A11Y, DEV_STYLES, DEV_AXE, DEV_INSPECTOR, `${DEV_TAB}data.js`, DEV_ROUTES, DEV_UI, DEV_JOBS, DEV_DATA, DEV_SIZES, DEV_FOOTPRINT, DEV_NOT_FOUND, DEV_TOOL]
const WRITES = [DEV_STACK, DEV_OPEN, DEV_UI, DEV_JOBS_RETRY, DEV_JOBS_DELETE, DEV_DATA_QUERY, DEV_NOT_FOUND, DEV_HEAD]

const saved = { NODE_ENV: process.env.NODE_ENV, KAY_DEV_CODE: process.env.KAY_DEV_CODE, KAY_DEV_REMOTE: process.env.KAY_DEV_REMOTE }

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined)
      delete process.env[name]
    else
      process.env[name] = value
  }
})

async function root() {
  const dir = await scratchDir('dev-routes-gate-')

  await Bun.write(join(dir, 'routes/index.kay'), 'h1 Home\n')

  return dir
}

async function answers(app: { handle: (request: Request) => Promise<Response> }, path: string, method: string) {
  return (await app.handle(new Request(`http://localhost${path}`, { method, headers: HEADERS, ...method === 'POST' && { body: '{}' } }))).status
}

describe('who gets the dev routes', () => {
  it('mounts them under kay dev or when the code passes dev: true, never because NODE_ENV says development', () => {
    process.env.NODE_ENV = 'development'
    delete process.env.KAY_DEV_CODE
    expect(modeOf().devRoutes).toBe(false)
    expect(modeOf({ dev: true }).devRoutes).toBe(true)
    process.env.KAY_DEV_CODE = '1'
    process.env.NODE_ENV = 'development'
    expect(modeOf().devRoutes).toBe(true)
  })

  it('answers 404 on every dev route to a header-carrying client when only NODE_ENV says development', async () => {
    process.env.NODE_ENV = 'development'
    delete process.env.KAY_DEV_CODE

    const app = await pages({ root: await root(), routes: 'routes', prebuilt: false, security: false })

    for (const path of READS)
      expect([path, await answers(app, path, 'GET')]).toEqual([path, 404])

    for (const path of WRITES)
      expect([path, await answers(app, path, 'POST')]).toEqual([path, 404])

    const page = await (await app.handle(new Request('http://localhost/'))).text()

    expect(page).toContain('Home')
    expect(page).not.toContain(DEV_TOOL)
  })

  it('still mounts them, and the tool script on pages, under kay dev', async () => {
    process.env.KAY_DEV_CODE = '1'
    process.env.NODE_ENV = 'development'

    const app = await pages({ root: await root(), routes: 'routes', prebuilt: false, security: false })

    expect(await answers(app, DEV_ROUTES, 'GET')).toBe(200)
    expect(await (await app.handle(new Request('http://localhost/'))).text()).toContain(DEV_TOOL)
  })
})

describe('kay dev --host', () => {
  async function reach(address: string | undefined, path: string, method = 'GET') {
    process.env.KAY_DEV_CODE = '1'
    process.env.NODE_ENV = 'development'

    const app = await pages({ root: await root(), routes: 'routes', prebuilt: false, security: false })
    const server = { requestIP: () => address === undefined ? null : { address, family: 'IPv4', port: 1 } } as unknown as Server<unknown>

    // Elysia hands a handler the server it listens on, which `handle` has none of.
    app.server = server

    return (await app.handle(new Request(`http://localhost${path}`, { method, headers: HEADERS, ...method === 'POST' && { body: '{}' } }))).status
  }

  it('refuses every dev route that reads or writes the project from a peer that is not this machine', async () => {
    for (const path of [DEV_DATA, DEV_DATA_ROWS, DEV_UI, DEV_JOBS, DEV_NOT_FOUND, DEV_ROUTES, DEV_SIZES, DEV_FOOTPRINT])
      expect([path, await reach('192.168.1.40', path)]).toEqual([path, 403])

    for (const path of [DEV_JOBS_RETRY, DEV_JOBS_DELETE, DEV_DATA_QUERY, DEV_UI, DEV_NOT_FOUND, DEV_OPEN, DEV_STACK, DEV_HEAD])
      expect([path, await reach('192.168.1.40', path, 'POST')]).toEqual([path, 403])
  })

  // The UI route reaches its own check, which wants a file, once the peer is let in.
  it('answers a loopback peer, and a remote one once KAY_DEV_REMOTE=1 opens the tools', async () => {
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1'])
      expect([address, await reach(address, DEV_UI)]).toEqual([address, 400])

    for (const path of [DEV_EVENTS, DEV_TOOL, DEV_PATCH, DEV_A11Y, `${DEV_TAB}data.js`])
      expect([path, await reach('192.168.1.40', path)]).toEqual([path, 200])

    process.env.KAY_DEV_REMOTE = '1'
    expect(await reach('192.168.1.40', DEV_UI)).toBe(400)
  })
})

describe('a boot failure', () => {
  const failure = new KayCompileError([])

  it('serves the error page with the dev tool under kay dev, and none of it elsewhere', async () => {
    const tooled = bootFailure(failure, process.cwd())

    expect(await (await tooled.handle(new Request('http://localhost/'))).text()).toContain(DEV_TOOL)
    expect((await tooled.handle(new Request(`http://localhost${DEV_EVENTS}`))).status).toBe(200)

    const bare = bootFailure(failure, process.cwd(), false)
    const page = await bare.handle(new Request('http://localhost/'))

    expect(page.status).toBe(500)
    expect(await page.text()).not.toContain(DEV_TOOL)

    for (const path of [DEV_EVENTS, DEV_TOOL])
      expect([path, (await bare.handle(new Request(`http://localhost${path}`))).status]).toEqual([path, 500])
  })
})

describe('the dev-only OpenAPI document', () => {
  const document = async () => (await (await pages({ root: 'tests/fixtures/openapi', prebuilt: false, security: false, openapi: { dev: true } })).handle(new Request('http://localhost/api/openapi.json', { headers: { 'x-key': 'open' } }))).status

  it('is served under kay dev only, never because NODE_ENV says development', async () => {
    process.env.NODE_ENV = 'development'
    delete process.env.KAY_DEV_CODE
    expect(await document()).toBe(404)
    process.env.KAY_DEV_CODE = '1'
    expect(await document()).toBe(200)
  })
})
