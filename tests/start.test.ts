import type { Subprocess } from 'bun'
import { chmod, rm, utimes } from 'node:fs/promises'
import { join, relative } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { outputDir } from '../src/build/assets'
import { scratchDir } from './scratch'

const cli = join(import.meta.dir, '..', 'src', 'cli.ts')
const LISTENING = /listening (\d+)/

// Prints what it runs as, so the test sees the environment `kay start` gave it.
const SERVER = `import process from 'node:process'
import { Elysia } from 'elysia'
import { pages } from 'kay/server'

const app = new Elysia().get('/mode', () => \`\${process.env.NODE_ENV} \${process.env.FROM_DOTENV}\`).use(await pages()).listen(Number(process.env.PORT ?? 0))

console.log(\`listening \${app.server?.port}\`)
`

function start(dir: string, ...args: string[]): Subprocess<'ignore', 'pipe', 'pipe'> {
  return Bun.spawn([process.execPath, cli, 'start', dir, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
}

// In a process group of its own, as a shell runs a command, for the test to signal the group as Ctrl-C does.
function startGroup(dir: string, ...args: string[]): Subprocess<'ignore', 'pipe', 'pipe'> {
  return Bun.spawn([process.execPath, cli, 'start', dir, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', detached: true })
}

// Runs `whileUp` once the server listens, then stops it with `signal`, as a deployment would: the port it listened on, what `kay start` warned and how it exited.
async function listening(child: Subprocess<'ignore', 'pipe', 'pipe'>, whileUp?: (port: string) => Promise<void>, signal: NodeJS.Signals = 'SIGTERM', group = false): Promise<{ port: string, warned: string, code: number }> {
  const reader = child.stdout.getReader()
  let output = ''

  for (let match = LISTENING.exec(output); !match; match = LISTENING.exec(output)) {
    const { value, done } = await reader.read()

    if (done)
      throw new Error(`kay start exited without listening: ${await new Response(child.stderr).text()}`)

    output += new TextDecoder().decode(value)
  }

  reader.releaseLock()

  const port = LISTENING.exec(output)![1]!

  try {
    await whileUp?.(port)
  }
  finally {
    if (group)
      process.kill(-child.pid, signal)
    else
      child.kill(signal)
  }

  const [warned, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

  return { port, warned, code }
}

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() })
  const { port } = probe

  void probe.stop(true)

  return port!
}

describe('kay start', () => {
  let dir: string

  beforeAll(async () => {
    dir = await scratchDir('start-')
    await Promise.all([
      Bun.write(join(dir, 'tsconfig.json'), Bun.file(join(import.meta.dir, 'fixtures/site/tsconfig.json'))),
      Bun.write(join(dir, 'src/routes/index.kay'), 'h1 Home\n'),
      Bun.write(join(dir, 'src/server.ts'), SERVER),
      Bun.write(join(dir, '.env.production'), 'FROM_DOTENV=production\n'),
    ])
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('refuses to start a project with no build', async () => {
    const child = start(dir)
    const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

    expect(code).toBe(1)
    expect(errors).toContain('there is no build in')
    expect(errors).toContain('run `kay build` first')
  })

  it('serves the last build in production on the port it names, the server reading .env.production, and warns once a source is newer', async () => {
    const build = Bun.spawn([process.execPath, cli, 'build', dir, '--no-check'], { stdout: 'ignore', stderr: 'pipe' })

    expect(await build.exited).toBe(0)

    const port = String(freePort())
    const served = await listening(start(dir, '--port', port), async () => {
      expect(await (await fetch(`http://localhost:${port}/mode`)).text()).toBe('production production')
      expect(await (await fetch(`http://localhost:${port}/`)).text()).toContain('Home</h1>')
    })

    expect(served).toEqual({ port, warned: '', code: 0 })

    const later = new Date(Date.now() + 60_000)

    await utimes(join(dir, 'src/routes/index.kay'), later, later)
    expect((await listening(start(dir))).warned).toContain('the build is older than .kay/scratch/')
  }, 60_000)

  it('runs the executable the last build compiled, relative to the root, warning when the build is newer, and the entry once it is gone or a build compiled none', async () => {
    const executable = join(dir, 'server')
    const record = join(outputDir(dir), 'executable')

    await Bun.write(executable, '#!/bin/sh\necho "compiled $NODE_ENV"\n')
    await chmod(executable, 0o755)
    await Bun.write(record, 'server')

    const compiled = start(dir)

    expect(await new Response(compiled.stdout).text()).toBe('compiled production\n')
    expect(await compiled.exited).toBe(0)

    const earlier = new Date(Date.now() - 60_000)

    await utimes(executable, earlier, earlier)

    const older = start(dir)

    expect(await new Response(older.stderr).text()).toContain(`kay start: the executable ${relative(process.cwd(), executable)} is older than the build`)
    expect(await older.exited).toBe(0)

    await chmod(executable, 0o644)

    const refused = start(dir)

    expect(await new Response(refused.stderr).text()).toContain(`kay start: cannot run ${relative(process.cwd(), executable)}: EACCES`)
    expect(await refused.exited).toBe(1)

    await rm(executable)
    expect((await listening(start(dir))).warned).toContain('is gone; starting the server entry instead')

    await Bun.write(record, 'server')
    expect(await Bun.spawn([process.execPath, cli, 'build', dir, '--no-check'], { stdout: 'ignore', stderr: 'ignore' }).exited).toBe(0)
    expect(await Bun.file(record).exists()).toBe(false)
  }, 60_000)

  it('exits as the server does: with its code, 128 and the signal that killed it, or 0 once it stopped on the signal kay start alone was sent', async () => {
    const entry = async (name: string, code: string) => {
      await Bun.write(join(dir, name), code)

      // Relative to the current directory.
      return relative(process.cwd(), join(dir, name))
    }

    expect(await start(dir, '--entry', await entry('crash.ts', 'process.exit(3)\n')).exited).toBe(3)
    expect(await start(dir, '--entry', await entry('killed.ts', 'process.kill(process.pid, \'SIGKILL\')\n')).exited).toBe(137)

    for (const group of [false, true]) {
      const port = String(freePort())
      const interrupted = await listening((group ? startGroup : start)(dir, '--port', port), undefined, 'SIGINT', group)

      expect(interrupted.code).toBe(0)
      // The server drained and exited before `kay start` did.
      expect(async () => Bun.serve({ port: Number(port), fetch: () => new Response() }).stop(true)).not.toThrow()
    }
  }, 60_000)
})
