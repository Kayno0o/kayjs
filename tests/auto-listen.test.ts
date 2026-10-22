import type { Subprocess } from 'bun'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { dev } from '../src/dev'
import { rootOf } from '../src/server/auto-listen'
import { scratchDir } from './scratch'

const cli = join(import.meta.dir, '..', 'src', 'cli.ts')

// An entry that never calls `listen`, as the scaffold writes it.
const IDLE = `import { Elysia } from 'elysia'
import { pages } from 'kay/server'

export const app = new Elysia().get('/mine', () => 'mine').use(await pages())
`

// An entry that listens itself, after an await that gives kay's turn first.
const LATE = `import { Elysia } from 'elysia'
import { pages } from 'kay/server'

export const app = new Elysia().get('/mine', () => 'mine').use(await pages())

await Bun.sleep(100)
app.listen({ port: Number(process.env.PORT) + Number(process.env.LATE_SHIFT ?? 0), hostname: '127.0.0.1' })
`

// An entry whose app is used two levels deep.
const DEEP = `import { Elysia } from 'elysia'
import { pages } from 'kay/server'

export const app = new Elysia().get('/mine', () => 'mine').use(new Elysia().use(await pages()))
`

// An entry serving through Bun.serve, with no listen.
const SERVED = `import { Elysia } from 'elysia'
import { pages } from 'kay/server'

export const app = new Elysia().get('/mine', () => 'mine').use(await pages())

Bun.serve({ port: Number(process.env.PORT), hostname: '127.0.0.1', fetch: app.fetch })
`

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() })
  const { port } = probe

  void probe.stop(true)

  return port!
}

async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  for (const limit = Date.now() + 20_000; Date.now() < limit; await Bun.sleep(50)) {
    try {
      const value = await read()

      if (value !== undefined)
        return value
    }
    catch {}
  }

  throw new Error('timed out')
}

async function body(url: string): Promise<string | undefined> {
  const response = await fetch(url)

  return response.ok ? response.text() : undefined
}

async function project(prefix: string, entry: string): Promise<string> {
  const dir = await scratchDir(prefix)

  await Promise.all([
    Bun.write(join(dir, 'tsconfig.json'), Bun.file(join(import.meta.dir, 'fixtures/site/tsconfig.json'))),
    Bun.write(join(dir, 'src/routes/index.kay'), 'h1 Home\n'),
    Bun.write(join(dir, 'src/server.ts'), entry),
  ])

  return dir
}

describe('an entry that does not listen', () => {
  let idle: string
  let late: string
  let deep: string
  let served: string

  beforeAll(async () => {
    [idle, late, deep, served] = await Promise.all([project('auto-listen-idle-', IDLE), project('auto-listen-late-', LATE), project('auto-listen-deep-', DEEP), project('auto-listen-served-', SERVED)])
    await Promise.all([idle, late, deep, served].map(async (dir) => {
      const build = Bun.spawn([process.execPath, cli, 'build', dir, '--no-check'], { stdout: 'ignore', stderr: 'pipe' })
      const [errors, code] = await Promise.all([new Response(build.stderr).text(), build.exited])

      if (code !== 0)
        throw new Error(`kay build failed: ${errors}`)
    }))
  })

  afterAll(async () => {
    await Promise.all([idle, late, deep, served].map(async dir => Bun.$`rm -rf ${dir}`.quiet()))
  })

  async function started(dir: string, port: number, host?: string, shift = 0): Promise<Subprocess> {
    return Bun.spawn([process.execPath, cli, 'start', dir], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', env: { ...process.env, LATE_SHIFT: String(shift), PORT: String(port), ...host === undefined ? {} : { HOST: host } } })
  }

  it('is listened on PORT by kay start, its own routes beside the pages', async () => {
    const port = freePort()
    const child = await started(idle, port)

    try {
      expect(await until(async () => body(`http://localhost:${port}/mine`))).toBe('mine')
      expect(await until(async () => body(`http://localhost:${port}/`))).toContain('Home')
    }
    finally {
      child.kill()
    }
  }, 60_000)

  it('is listened when its pages are used two levels deep', async () => {
    const port = freePort()
    const child = await started(deep, port)

    try {
      expect(await until(async () => body(`http://localhost:${port}/mine`))).toBe('mine')
      expect(await until(async () => body(`http://localhost:${port}/`))).toContain('Home')
    }
    finally {
      child.kill()
    }
  }, 60_000)

  it('is not listened a second time by an entry serving through Bun.serve', async () => {
    const port = freePort()
    const child = Bun.spawn([process.execPath, cli, 'start', served], { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe', env: { ...process.env, PORT: String(port) } })

    try {
      expect(await until(async () => body(`http://127.0.0.1:${port}/mine`))).toBe('mine')
      await Bun.sleep(300)
      expect(child.exitCode).toBeNull()
    }
    finally {
      child.kill()
    }

    expect(await new Response(child.stderr).text()).not.toContain('could not listen')
  }, 60_000)

  it('is listened when it is run as bun src/server.ts itself', async () => {
    const port = freePort()
    const child = Bun.spawn([process.execPath, join(idle, 'src/server.ts')], { cwd: idle, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', env: { ...process.env, NODE_ENV: 'production', PORT: String(port) } })

    try {
      expect(await until(async () => body(`http://localhost:${port}/mine`))).toBe('mine')
    }
    finally {
      child.kill()
    }
  }, 60_000)

  it('is listened by the executable', async () => {
    const executable = join(idle, 'server')
    const build = Bun.spawn([process.execPath, cli, 'build', idle, '--no-check', '--compile', executable], { stdout: 'ignore', stderr: 'pipe' })
    const [errors, code] = await Promise.all([new Response(build.stderr).text(), build.exited])

    if (code !== 0)
      throw new Error(`kay build --compile failed: ${errors}`)

    const port = freePort()
    const child = Bun.spawn([executable], { cwd: idle, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' } })

    try {
      expect(await until(async () => body(`http://127.0.0.1:${port}/mine`))).toBe('mine')
      expect(await until(async () => body(`http://127.0.0.1:${port}/`))).toContain('Home')
    }
    finally {
      child.kill()
    }
  }, 120_000)

  it('is listened on HOST when it is set', async () => {
    const port = freePort()
    const child = await started(idle, port, '127.0.0.1')

    try {
      expect(await until(async () => body(`http://127.0.0.1:${port}/mine`))).toBe('mine')
    }
    finally {
      child.kill()
    }
  }, 60_000)

  it('takes the same port back for a listen the entry makes itself after an await', async () => {
    const port = freePort()
    const child = await started(late, port)

    try {
      expect(await until(async () => body(`http://127.0.0.1:${port}/mine`))).toBe('mine')
      await Bun.sleep(300)
      expect(child.exitCode).toBeNull()
    }
    finally {
      child.kill()
    }
  }, 60_000)

  it('keeps the port the entry asks for itself, even after an await', async () => {
    const port = freePort()
    const child = await started(late, port, undefined, 1)

    try {
      expect(await until(async () => body(`http://127.0.0.1:${port + 1}/mine`))).toBe('mine')
      await Bun.sleep(300)
      expect(child.exitCode).toBeNull()
    }
    finally {
      child.kill()
    }
  }, 60_000)

  it('is listened by kay dev', async () => {
    const port = freePort()
    const dir = await project('auto-listen-dev-', IDLE)
    const lines: string[] = []
    const stop = await dev(dir, { port, log: line => lines.push(line) })

    try {
      expect(await until(async () => body(`http://localhost:${port}/mine`))).toBe('mine')

      // A page edited is swapped into the server of the process, whose reload starts the servers the run before did.
      await Bun.write(join(dir, 'src/routes/index.kay'), 'h1 Changed\n')
      expect(await until(async () => (await body(`http://localhost:${port}/`))?.includes('Changed') ? 'yes' : undefined)).toBe('yes')
      await until(async () => lines.some(line => line.includes('reloaded')) ? true : undefined)
      expect(lines.filter(line => line.includes('restarted'))).toEqual([])
    }
    finally {
      await stop()
      await Bun.$`rm -rf ${dir}`.quiet()
    }
  }, 60_000)
})

describe('kay dev with a HOST exported', () => {
  it('ignores it and listens on localhost', async () => {
    const port = freePort()
    const dir = await project('auto-listen-host-', IDLE)
    const before = process.env.HOST
    let stop: (() => Promise<void>) | undefined

    try {
      // An address this machine does not have: listening on it would fail.
      process.env.HOST = '203.0.113.7'

      const lines: string[] = []

      stop = await dev(dir, { port, log: line => lines.push(line) })
      expect(await until(async () => body(`http://localhost:${port}/mine`))).toBe('mine')
    }
    finally {
      if (before === undefined)
        delete process.env.HOST
      else
        process.env.HOST = before

      await stop?.()

      await Bun.$`rm -rf ${dir}`.quiet()
    }
  }, 60_000)
})

describe('the app pages() was used in', () => {
  // Elysia's `getParent` is not in its types: this fails when an upgrade changes it.
  it('is found through getParent, however deep', () => {
    const plugin = new Elysia()
    const root = new Elysia().use(new Elysia().use(plugin))

    expect(rootOf(plugin)).toBe(root)
    expect(rootOf(root)).toBe(root)
  })
})
