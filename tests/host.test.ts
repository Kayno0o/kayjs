import type { Subprocess } from 'bun'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { dev } from '../src/dev'
import { createProject, PRESETS } from '../src/new'
import { probeHealth } from '../src/server/lifecycle'
import { fixtureCopy, scratchDir } from './scratch'
import { pages } from './shared-pages'

const repo = resolve(import.meta.dir, '..')

function binds(hostname: string): boolean {
  try {
    Bun.listen({ hostname, port: 0, socket: { data: () => undefined } }).stop(true)

    return true
  }
  catch {
    return false
  }
}

function freePort(): number {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => undefined } })
  const { port } = probe

  probe.stop(true)

  return port
}

async function reaches(address: string, port: number): Promise<boolean> {
  try {
    return (await fetch(`http://${address}:${port}/`, { signal: AbortSignal.timeout(1000) })).status > 0
  }
  catch {
    return false
  }
}

// Runs `entry` with PORT and HOST as given, once it answers on one of `ready`, then the addresses it answers on among `addresses`.
async function answersOn(entry: string, cwd: string, host: string | undefined, addresses: string[], ready: string[]): Promise<string[]> {
  const port = freePort()
  const env: Record<string, string | undefined> = { ...process.env, PORT: String(port), HOST: host, NODE_ENV: 'production' }
  const child: Subprocess = Bun.spawn([process.execPath, entry], { cwd, env, stdout: 'ignore', stderr: 'inherit' })

  try {
    for (let tried = 0; !(await Promise.all(ready.map(async address => reaches(address, port)))).includes(true); tried++) {
      if (tried === 100)
        throw new Error(`${entry} never answered on ${ready.join(' or ')}`)

      await Bun.sleep(100)
    }

    const found: string[] = []

    for (const address of addresses) {
      if (await reaches(address, port))
        found.push(address)
    }

    return found
  }
  finally {
    child.kill()
    await child.exited
  }
}

// 127.0.0.2 is loopback too on Linux, but a server bound to 127.0.0.1 does not answer there.
const OTHER = '127.0.0.2'
const CASES = [
  [undefined, ['127.0.0.1', OTHER]],
  ['', ['127.0.0.1', OTHER]],
  ['0.0.0.0', ['127.0.0.1', OTHER]],
  ['127.0.0.1', ['127.0.0.1']],
  [OTHER, [OTHER]],
] as const

const itIpv6 = binds('::1') ? it : it.skip

describe('HOST', () => {
  it.each(CASES)('kay\'s own server for an app with no entry listens on HOST=%p', async (host, expected) => {
    const cwd = await fixtureCopy('bare')

    expect(await answersOn(join(repo, 'src/dev/pages.ts'), cwd, host, ['127.0.0.1', OTHER], [expected[0]])).toEqual([...expected])
  }, 30_000)

  it.each(CASES)('the server entry of a new project listens on HOST=%p', async (host, expected) => {
    const cwd = join(await scratchDir('host-'), 'app')

    await createProject(cwd, { kay: '^1.0.0', features: PRESETS.server.features.filter(feature => feature === 'server') })
    expect(await answersOn('src/server.ts', cwd, host, ['127.0.0.1', OTHER], [expected[0]])).toEqual([...expected])
  }, 30_000)

  // Bun binds localhost to one family, ::1 in CI's Alpine container, so one loopback answers and no other address.
  it('listens on one loopback when HOST=localhost', async () => {
    const loopbacks = binds('::1') ? ['127.0.0.1', '[::1]'] : ['127.0.0.1']
    const project = join(await scratchDir('host-'), 'app')

    await createProject(project, { kay: '^1.0.0', features: PRESETS.server.features.filter(feature => feature === 'server') })

    for (const [entry, cwd] of [[join(repo, 'src/dev/pages.ts'), await fixtureCopy('bare')], ['src/server.ts', project]] as const) {
      const found = await answersOn(entry, cwd, 'localhost', [...loopbacks, OTHER], loopbacks)

      expect(loopbacks.map(address => [address])).toContainEqual(found)
    }
  }, 30_000)

  itIpv6('listens on ::1 when HOST names it', async () => {
    const cwd = await fixtureCopy('bare')

    expect(await answersOn(join(repo, 'src/dev/pages.ts'), cwd, '::1', ['[::1]', '127.0.0.1'], ['[::1]'])).toEqual(['[::1]'])
  }, 30_000)

  it('the full starter reads HOST as an optional variable and listens on it', async () => {
    const cwd = join(await scratchDir('host-'), 'app')

    await createProject(cwd, { kay: '^1.0.0', features: PRESETS.app.features })
    expect(await Bun.file(join(cwd, 'src/server.ts')).text()).toContain('...process.env.HOST !== undefined && { hostname: process.env.HOST }')
  })

  it('probes the health route where HOST says the server listens', async () => {
    const quiet = spyOn(console, 'error').mockImplementation(() => undefined)
    const routes = 'tests/fixtures/production/src/routes'

    try {
      for (const [bound, host, expected] of [
        ['127.0.0.1', undefined, 0],
        ['127.0.0.1', '', 0],
        ['127.0.0.1', '0.0.0.0', 0],
        ['127.0.0.1', '127.0.0.1', 0],
        ['127.0.0.1', 'localhost', 0],
        [OTHER, OTHER, 0],
        [OTHER, undefined, 1],
        ['127.0.0.1', OTHER, 1],
        ...binds('::1') ? [['::1', '::1', 0], ['::1', '[::1]', 0], ['::1', '127.0.0.1', 1]] as const : [],
      ] as const) {
        const app = new Elysia().use(await pages({ routes, prebuilt: false, health: { path: '/up' } })).listen({ port: 0, hostname: bound })

        try {
          expect({ bound, host, status: await probeHealth({ path: '/up' }, String(app.server!.port), host) }).toEqual({ bound, host, status: expected })
        }
        finally {
          await app.stop()
        }
      }
    }
    finally {
      quiet.mockRestore()
    }
  })

  it.serial.each([undefined, '', '0.0.0.0', '127.0.0.1'])('kay dev keeps its own address when HOST=%p is exported, and leaves the app no HOST', async (exported) => {
    expect(await devAnswer(exported, {})).toBe('localhost undefined')
  }, 30_000)

  it.serial('kay dev keeps its own address for a HOST in the .env, and opens to the network with --host while the app still sees no HOST', async () => {
    expect(await devAnswer(undefined, { dotenv: 'HOST=127.0.0.1\n' })).toBe('localhost undefined')
    expect(await devAnswer('127.0.0.1', { host: '0.0.0.0', dotenv: 'HOST=127.0.0.1\n' })).toBe('0.0.0.0 undefined')
  }, 30_000)
})

// What an app that listens on process.env.HOST answers under kay dev, with HOST exported as given.
async function devAnswer(exported: string | undefined, options: { host?: string, dotenv?: string }): Promise<string> {
  const root = await scratchDir('host-dev-')
  const lines: string[] = []
  const before = process.env.HOST

  if (options.dotenv !== undefined)
    await Bun.write(join(root, '.env'), options.dotenv)

  await Bun.write(join(root, 'src/server.ts'), 'const server = Bun.serve({ port: 0, hostname: process.env.HOST, fetch: () => new Response(`${server.hostname} ${process.env.HOST}`) })\n')

  if (exported === undefined)
    delete process.env.HOST
  else
    process.env.HOST = exported

  try {
    const stop = await dev(root, { host: options.host, log: line => lines.push(line) })

    try {
      for (let tried = 0; lines.length === 0 && tried < 200; tried++)
        await Bun.sleep(50)

      const [, port] = (/^kay dev: http:\/\/localhost:(\d+) /).exec(lines[0] ?? '') ?? []

      return await (await fetch(`http://localhost:${port}`)).text()
    }
    finally {
      await stop()
    }
  }
  finally {
    if (before === undefined)
      delete process.env.HOST
    else
      process.env.HOST = before
  }
}
