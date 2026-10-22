import type { Subprocess } from 'bun'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { dev } from '../src/dev'
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
app.listen({ port: Number(process.env.PORT), hostname: '127.0.0.1' })
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

  beforeAll(async () => {
    [idle, late] = await Promise.all([project('auto-listen-idle-', IDLE), project('auto-listen-late-', LATE)])
    await Promise.all([idle, late].map(async (dir) => {
      const build = Bun.spawn([process.execPath, cli, 'build', dir, '--no-check'], { stdout: 'ignore', stderr: 'pipe' })
      const [errors, code] = await Promise.all([new Response(build.stderr).text(), build.exited])

      if (code !== 0)
        throw new Error(`kay build failed: ${errors}`)
    }))
  })

  afterAll(async () => {
    await Promise.all([idle, late].map(async dir => Bun.$`rm -rf ${dir}`.quiet()))
  })

  async function started(dir: string, port: number, host?: string): Promise<Subprocess> {
    return Bun.spawn([process.execPath, cli, 'start', dir], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', env: { ...process.env, PORT: String(port), ...host === undefined ? {} : { HOST: host } } })
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

  it('keeps the listen call it makes itself, even after an await', async () => {
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
