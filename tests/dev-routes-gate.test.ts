import type { Server } from 'bun'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'bun:test'
import { modeOf } from '../src/project'
import { DEV_DATA, DEV_DATA_QUERY, DEV_FOOTPRINT, DEV_HEAD, DEV_JOBS, DEV_JOBS_DELETE, DEV_JOBS_RETRY, DEV_NOT_FOUND, DEV_ROUTES, DEV_SIZES, DEV_TOOL, DEV_UI } from '../src/server/dev'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

const HEADERS = { 'x-kay-dev': '1', 'content-type': 'application/json' }
const READS = [DEV_ROUTES, DEV_UI, DEV_JOBS, DEV_DATA, DEV_SIZES, DEV_FOOTPRINT, DEV_NOT_FOUND, DEV_TOOL]
const WRITES = [DEV_UI, DEV_JOBS_RETRY, DEV_JOBS_DELETE, DEV_DATA_QUERY, DEV_NOT_FOUND, DEV_HEAD]

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
  async function reach(address: string | undefined, path: string) {
    process.env.KAY_DEV_CODE = '1'
    process.env.NODE_ENV = 'development'

    const app = await pages({ root: await root(), routes: 'routes', prebuilt: false, security: false })
    const server = { requestIP: () => address === undefined ? null : { address, family: 'IPv4', port: 1 } } as unknown as Server<unknown>

    // Elysia hands a handler the server it listens on, which `handle` has none of.
    app.server = server

    return (await app.handle(new Request(`http://localhost${path}`, { headers: HEADERS }))).status
  }

  it('refuses the data, UI, jobs and not-found routes from a peer that is not this machine', async () => {
    for (const path of [DEV_DATA, DEV_UI, DEV_JOBS, DEV_NOT_FOUND])
      expect([path, await reach('192.168.1.40', path)]).toEqual([path, 403])
  })

  // The UI route reaches its own check, which wants a file, once the peer is let in.
  it('answers a loopback peer, and a remote one once KAY_DEV_REMOTE=1 opens the tools', async () => {
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1'])
      expect([address, await reach(address, DEV_UI)]).toEqual([address, 400])

    expect(await reach('192.168.1.40', DEV_ROUTES)).toBe(200)
    process.env.KAY_DEV_REMOTE = '1'
    expect(await reach('192.168.1.40', DEV_UI)).toBe(400)
  })
})
