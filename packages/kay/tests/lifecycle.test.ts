import type { Subprocess } from 'bun'
import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from '../src/build/index'

const kayDir = join(import.meta.dir, '..')
const tempDirs: string[] = []
afterAll(() => {
  for (const d of tempDirs)
    rmSync(d, { recursive: true, force: true })
})

// A built app whose onShutdown hook, slow route and live stream show what a stop waited for.
async function builtApp(compile?: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'kay-lifecycle-'))
  tempDirs.push(dir)
  const files: Record<string, string> = {
    'kay.config.ts': `
      import { appendFileSync } from 'node:fs'
      import { defineConfig } from '@kayjs/kay/config'
      import { feed, rooms } from './src/live'
      export default defineConfig({
        plugins: [rooms, feed, { name: 'probe', server(api) { api.onShutdown(() => appendFileSync(${JSON.stringify(join(dir, 'hooks-ran'))}, 'yes')) } }],
      })
    `,
    'src/live.ts': 'import { createRooms } from \'@kayjs/live\'\nexport const rooms = createRooms<string, string>({ path: \'/events\', member: () => \'guest\', pingMs: 0 })\nexport const feed = createRooms<string, string>()\n',
    'src/routes/feed.ts': `
      import type { RequestContext } from '@kayjs/kay/server'
      import { feed } from '../live'
      export function GET(ctx: RequestContext): Response { return feed.stream(ctx, { room: 'main', member: 'reader', pingMs: 0 }) }
    `,
    'src/routes/slow.ts': `
      import { writeFileSync } from 'node:fs'
      export async function GET(): Promise<Response> {
        writeFileSync(${JSON.stringify(join(dir, 'slow-started'))}, 'yes')
        await Bun.sleep(400)
        return new Response('finished')
      }
    `,
    'src/routes/hang.ts': `
      import { writeFileSync } from 'node:fs'
      export function GET(): Promise<Response> {
        writeFileSync(${JSON.stringify(join(dir, 'hang-started'))}, 'yes')
        return new Promise(() => {})
      }
    `,
    'src/routes/index.tsx': 'export default function Home() { return <p>Home</p> }\n',
  }
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  mkdirSync(join(dir, 'node_modules/@kayjs'), { recursive: true })
  symlinkSync(kayDir, join(dir, 'node_modules/@kayjs/kay'))
  symlinkSync(join(kayDir, '../plugin-live'), join(dir, 'node_modules/@kayjs/live'))
  await build({ root: dir, ...(compile !== undefined ? { compile: join(dir, compile) } : {}) })
  return dir
}

async function listeningUrl(proc: Subprocess<'ignore', 'pipe', 'pipe'>): Promise<string> {
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let out = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done)
      throw new Error(`server exited before listening: ${out}${await new Response(proc.stderr).text()}`)
    out += decoder.decode(value)
    const match = /http:\/\/\S+:\d+/.exec(out)
    if (match !== null) {
      reader.releaseLock()
      return match[0]
    }
  }
}

async function until(check: () => boolean): Promise<void> {
  while (!check())
    await Bun.sleep(10)
}

describe('kay start and compiled binaries stop gracefully (#3581)', () => {
  it('on SIGTERM, finishes the open request, ends live streams, runs onShutdown hooks once and exits 0', async () => {
    const dir = await builtApp()
    const proc = Bun.spawn(['bun', join(kayDir, 'src/cli/index.ts'), 'start', dir, '--port', '0'], { stdout: 'pipe', stderr: 'pipe' })
    const url = await listeningUrl(proc)
    const events = await fetch(`${url}/events`)
    const feed = await fetch(`${url}/feed`)
    const slow = fetch(`${url}/slow`)
    await until(() => existsSync(join(dir, 'slow-started')))

    proc.kill('SIGTERM')
    proc.kill('SIGHUP')

    expect(await (await slow).text()).toBe('finished')
    expect(await events.text()).toBe('retry: 2000\n\n')
    expect(await feed.text()).toBe('retry: 2000\n\n')
    expect(await proc.exited).toBe(0)
    expect(readFileSync(join(dir, 'hooks-ran'), 'utf8')).toBe('yes')
  })

  it('a compiled binary does the same', async () => {
    const dir = await builtApp('server-bin')
    const proc = Bun.spawn([join(dir, 'server-bin')], { cwd: dir, env: { ...process.env, PORT: '0', HOST: '127.0.0.1' }, stdout: 'pipe', stderr: 'pipe' })
    await listeningUrl(proc)

    proc.kill('SIGTERM')

    expect(await proc.exited).toBe(0)
    expect(readFileSync(join(dir, 'hooks-ran'), 'utf8')).toBe('yes')
  })

  it('closes what is still open after the timeout and exits 1', async () => {
    const dir = await builtApp()
    const script = join(dir, 'serve.ts')
    writeFileSync(script, `
      import { createServer } from ${JSON.stringify(join(kayDir, 'src/server/index.ts'))}
      import { handleSignals } from ${JSON.stringify(join(kayDir, 'src/server/lifecycle.ts'))}
      const app = await createServer({ root: ${JSON.stringify(dir)} })
      const server = app.serve(0)
      handleSignals(app, server, { timeoutMs: 200 })
      console.log(\`listening on http://127.0.0.1:\${server.port}\`)
    `)
    const proc = Bun.spawn(['bun', script], { stdout: 'pipe', stderr: 'pipe' })
    const url = await listeningUrl(proc)
    const hung = (async () => {
      try {
        return await fetch(`${url}/hang`)
      }
      catch (error) {
        return error
      }
    })()
    await until(() => existsSync(join(dir, 'hang-started')))

    proc.kill('SIGTERM')

    expect(await proc.exited).toBe(1)
    expect(await new Response(proc.stderr).text()).toContain('kay: requests still open after 200 ms; closing them')
    expect(await hung).toBeInstanceOf(Error)
  })
})
