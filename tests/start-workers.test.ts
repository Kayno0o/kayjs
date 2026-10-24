import type { Subprocess } from 'bun'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { parseWorkers, requestedWorkers, sharedStores } from '../src/server/workers'
import { alive } from './alive'
import { freePort } from './free-port'
import { scratchDir } from './scratch'

const cli = join(import.meta.dir, '..', 'src', 'cli.ts')
const WORKERS = 2
const SECRET = 'workers-test-secret-0123456789-abcdef'

// Each route answers with the worker serving it; the rest read what the workers must share.
const SERVER = `import process from 'node:process'
import { Elysia } from 'elysia'
import { cached } from 'kay/cache'
import { pages, rateLimit } from 'kay/server'

const limit = rateLimit('workers-test', { max: 3, window: '1m' })
const who = () => \`\${process.env.KAY_WORKER} \${process.pid}\`

new Elysia().get('/who', who).get('/cached', async () => \`\${await cached('workers-test', '1m', () => who())}|\${process.env.KAY_WORKER}\`).get('/rate', async ({ request, set }) => {
  const wait = await limit.hit(request)

  set.status = wait === undefined ? 200 : 429

  return \`\${process.env.KAY_WORKER}\`
}).get('/live', () => {
  visitors.set(count => count + 1)

  return \`\${visitors()}|\${process.env.KAY_WORKER}\`
}).onStop(() => console.log(\`stopped \${process.env.KAY_WORKER}\`)).use(await pages())
`

// A live value, written by whichever worker answers.
const API = `import { api } from 'kay/server'
import { visitors } from '../live'

export default api().get('/', () => [visitors(), process.env.KAY_WORKER].join('|')).post('/', () => {
  visitors.set(count => count + 1)

  return process.env.KAY_WORKER
})
`

// A fresh connection every time, as the kernel balances connections, not requests.
async function get(port: string, path: string): Promise<{ status: number, text: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { connection: 'close' } })

  return { status: response.status, text: await response.text() }
}

// Asks until the answers have come from every worker, returning `answer` of each.
async function fromEveryWorker(port: string, path: string, count = WORKERS): Promise<Map<string, string>> {
  const seen = new Map<string, string>()

  for (const limit = Date.now() + 15_000; seen.size < count;) {
    if (Date.now() > limit)
      throw new Error(`only ${[...seen.keys()].join(', ')} of ${count} workers answered ${path}`)

    try {
      const [worker, pid] = (await get(port, path)).text.split(' ')

      seen.set(worker!, pid!)
    }
    catch {
      await Bun.sleep(50)
    }
  }

  return seen
}

// The pid worker 0 answers with, undefined while the port answers nothing.
async function workerZero(port: string): Promise<string | undefined> {
  try {
    return (await fromEveryWorker(port, '/who')).get('0')
  }
  catch {
    return undefined
  }
}

// What the route answers once the server is up.
async function answered(port: string, path: string): Promise<string> {
  for (const limit = Date.now() + 15_000; ; await Bun.sleep(100)) {
    try {
      return (await get(port, path)).text
    }
    catch (error) {
      if (Date.now() > limit)
        throw error
    }
  }
}

function start(dir: string, port: string, ...args: string[]): Subprocess<'ignore', 'pipe', 'pipe'> {
  return Bun.spawn([process.execPath, cli, 'start', dir, '--port', port, ...args], { env: { ...process.env, KAY_SECRET: SECRET }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
}

// Stops with SIGTERM and waits, killing it past the limit.
async function stop(child: Subprocess<'ignore', 'pipe', 'pipe'>): Promise<{ code: number, out: string, err: string }> {
  child.kill('SIGTERM')

  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  clearTimeout(timer)

  return { code, out, err }
}

describe('worker counts', () => {
  it('takes a whole number, or auto for one a core', () => {
    expect(parseWorkers('3')).toBe(3)
    expect(parseWorkers('auto')).toBeGreaterThanOrEqual(1)

    for (const bad of ['0', '-1', '1.5', 'two', '', '257'])
      expect(parseWorkers(bad)).toBeUndefined()
  })

  it('reads --workers over KAY_WORKERS, and refuses a bad one', () => {
    expect(requestedWorkers(['bun', 'server'], {})).toBeUndefined()
    expect(requestedWorkers(['bun', 'server'], { KAY_WORKERS: '4' })).toBe(4)
    expect(requestedWorkers(['bun', 'server', '--workers', '2'], { KAY_WORKERS: '4' })).toBe(2)
    expect(requestedWorkers(['bun', 'server', '--workers=3'], {})).toBe(3)
    expect(() => requestedWorkers(['bun', 'server', '--workers', 'x'], {})).toThrow('--workers takes a number')
    expect(() => requestedWorkers(['bun', 'server', '--workers'], {})).toThrow('--workers takes a number')
  })
})

describe('what workers share', () => {
  it('keeps the stores the app leaves out in one SQLite file, and leaves its own', async () => {
    const own = { cache: { get: () => undefined, set: () => undefined } } as never
    const before = process.env.KAY_WORKERS
    const worker = process.env.KAY_WORKER

    try {
      delete process.env.KAY_WORKERS
      delete process.env.KAY_WORKER
      expect(await sharedStores(undefined)).toBeUndefined()

      process.env.KAY_WORKERS = '2'
      process.env.KAY_WORKER = '0'

      const shared = await sharedStores({ cache: own })

      expect(shared?.cache).toBe(own)

      for (const kind of ['live', 'rates', 'rooms', 'vitals', 'notifications', 'push'] as const)
        expect(shared?.[kind]).toBeDefined()

      expect(shared?.sessions).toBeUndefined()
      expect(shared?.jobs).toBeUndefined()
    }
    finally {
      if (before === undefined)
        delete process.env.KAY_WORKERS
      else
        process.env.KAY_WORKERS = before

      if (worker === undefined)
        delete process.env.KAY_WORKER
      else
        process.env.KAY_WORKER = worker
    }
  })

  it('lets two workers listen on one port, and a process that is none refuses', async () => {
    const script = `import { shareThePort } from ${JSON.stringify(join(import.meta.dir, '../src/server/workers.ts'))}
shareThePort()
const first = Bun.serve({ port: 0, fetch: () => new Response() })
try {
  Bun.serve({ port: first.port, fetch: () => new Response() })
  console.log('shared')
}
catch {
  console.log('refused')
}
process.exit(0)`

    const run = async (worker: string | undefined) => {
      const rest = { ...process.env }

      delete rest.KAY_WORKER
      const child = Bun.spawn([process.execPath, '-e', script], { env: { ...rest, ...worker !== undefined && { KAY_WORKER: worker } }, stdout: 'pipe', stderr: 'inherit' })

      return (await new Response(child.stdout).text()).trim()
    }

    expect(await run('0')).toBe('shared')
    expect(await run(undefined)).toBe('refused')
  })
})

describe('kay start --workers', () => {
  let dir: string

  beforeAll(async () => {
    dir = await scratchDir('workers-')
    await Promise.all([
      Bun.write(join(dir, 'tsconfig.json'), Bun.file(join(import.meta.dir, 'fixtures/site/tsconfig.json'))),
      Bun.write(join(dir, 'src/routes/index.kay'), 'h1 Home\n'),
      Bun.write(join(dir, 'src/live.ts'), 'import { live } from \'kay\'\n\nexport const visitors = live(0)\n'),
      Bun.write(join(dir, 'src/api/count.ts'), API),
      Bun.write(join(dir, 'src/server.ts'), SERVER),
    ])

    const child = Bun.spawn([process.execPath, cli, 'build', dir, '--no-check'], { stdout: 'ignore', stderr: 'pipe' })
    const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

    if (code !== 0)
      throw new Error(`kay build failed: ${errors}`)
  }, 120_000)

  afterAll(async () => {
    const { rm } = await import('node:fs/promises')

    await rm(dir, { recursive: true, force: true })
  })

  it('serves from one process with --workers 1, whatever KAY_WORKERS says', async () => {
    const port = String(freePort())
    const child = Bun.spawn([process.execPath, cli, 'start', dir, '--port', port, '--workers', '1'], { env: { ...process.env, KAY_SECRET: SECRET, KAY_WORKERS: '4' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })

    try {
      const single = await answered(port, '/who')

      expect(single.startsWith('undefined ')).toBe(true)
      expect((await stop(child)).code).toBe(0)
    }
    finally {
      child.kill('SIGKILL')
    }
  }, 30_000)

  it('refuses a bad count', async () => {
    const child = start(dir, String(freePort()), '--workers', 'many')

    expect(await new Response(child.stderr).text()).toContain('--workers takes a number')
    expect(await child.exited).toBe(1)
  })

  it('serves from every worker on one port, shares what lived in memory, restarts a killed worker and drains them all', async () => {
    const port = String(freePort())
    const child = start(dir, port, '--workers', String(WORKERS))

    try {
      const pids = await fromEveryWorker(port, '/who')

      // Cached values: whichever worker loaded it, all answer with that one.
      const cachedBy = new Set<string>()
      const answeredBy = new Set<string>()

      for (let tries = 0; tries < 60 && (answeredBy.size < WORKERS || tries < 6); tries++) {
        const [value, worker] = (await get(port, '/cached')).text.split('|')

        cachedBy.add(value!)
        answeredBy.add(worker!)
      }

      expect(answeredBy.size).toBe(WORKERS)
      expect(cachedBy.size).toBe(1)

      // Rate limit: three pass and the rest are refused, over every worker.
      const statuses: number[] = []

      for (let tries = 0; tries < 8; tries++)
        statuses.push((await get(port, '/rate')).status)

      expect(statuses.filter(status => status === 200)).toHaveLength(3)

      // A live value one worker wrote is read by the other, within the half second the store takes to tell it.
      const wrote = (await (await fetch(`http://127.0.0.1:${port}/api/count`, { method: 'POST', headers: { connection: 'close' } })).text())
      let heard = ''

      for (const limit = Date.now() + 10_000; !heard.startsWith('1|') || heard.endsWith(wrote);) {
        if (Date.now() > limit)
          throw new Error(`worker ${wrote} wrote the live value, the other read ${heard}`)

        heard = (await get(port, '/api/count')).text
      }

      // A killed worker is started again.
      const victim = Number(pids.get('0'))

      process.kill(victim, 'SIGKILL')

      for (const limit = Date.now() + 15_000; alive(victim) || await workerZero(port) === String(victim);) {
        if (Date.now() > limit)
          throw new Error('worker 0 was not restarted')

        await Bun.sleep(100)
      }

      const after = await fromEveryWorker(port, '/who')

      expect(after.get('0')).not.toBe(String(victim))
      expect(after.size).toBe(WORKERS)

      const stopped = await stop(child)

      expect(stopped.code).toBe(0)
      expect(stopped.out).toContain('stopped 0')
      expect(stopped.out).toContain('stopped 1')

      for (const pid of after.values())
        expect(alive(Number(pid))).toBe(false)
    }
    catch (error) {
      child.kill('SIGKILL')

      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${await new Response(child.stderr).text()}${await new Response(child.stdout).text()}`)
    }
    finally {
      child.kill('SIGKILL')
    }
  }, 90_000)

  it('runs the executable with --workers as its own primary, draining every worker on SIGTERM', async () => {
    const executable = join(dir, 'bin/server')
    const built = Bun.spawn([process.execPath, cli, 'build', dir, '--no-check', '--compile', executable], { stdout: 'ignore', stderr: 'pipe' })
    const [errors, code] = await Promise.all([new Response(built.stderr).text(), built.exited])

    if (code !== 0)
      throw new Error(`kay build --compile failed: ${errors}`)

    const port = String(freePort())
    const child = Bun.spawn([executable, '--workers', String(WORKERS)], { cwd: dir, env: { ...process.env, PORT: port, KAY_SECRET: SECRET }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })

    try {
      const pids = await fromEveryWorker(port, '/who')

      expect(pids.size).toBe(WORKERS)

      // The container's health probe is no primary, whatever KAY_WORKERS says.
      const probe = Bun.spawn([executable, '--health'], { cwd: dir, env: { ...process.env, PORT: port, KAY_SECRET: SECRET, KAY_WORKERS: String(WORKERS) }, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })

      expect(await probe.exited).toBe(0)

      const stopped = await stop(child)

      expect(stopped.code).toBe(0)
      expect(stopped.out).toContain('stopped 0')
      expect(stopped.out).toContain('stopped 1')
    }
    finally {
      child.kill('SIGKILL')
    }
  }, 180_000)

  it('stops, exiting 1, when the app cannot boot', async () => {
    const broken = await scratchDir('workers-broken-')

    try {
      await Bun.write(join(broken, 'src/routes/index.kay'), 'h1 Home\n')
      await Bun.write(join(broken, 'tsconfig.json'), Bun.file(join(import.meta.dir, 'fixtures/site/tsconfig.json')))
      await Bun.write(join(broken, 'src/server.ts'), 'process.exit(3)\n')

      const built = Bun.spawn([process.execPath, cli, 'build', broken, '--no-check'], { stdout: 'ignore', stderr: 'pipe' })

      expect(await built.exited).toBe(0)

      const child = start(broken, String(freePort()), '--workers', '2')
      const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

      expect(code).toBe(1)
      expect(err).toContain('died 5 times in a row')
    }
    finally {
      const { rm } = await import('node:fs/promises')

      await rm(broken, { recursive: true, force: true })
    }
  }, 60_000)
})
