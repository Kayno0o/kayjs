import type { Subprocess } from 'bun'
import { chmod, rm, utimes } from 'node:fs/promises'
import { join } from 'node:path'
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

// Runs `whileUp` once the server listens, then stops it as a deployment would: the port it listened on, what `kay start` warned and how it exited.
async function listening(child: Subprocess<'ignore', 'pipe', 'pipe'>, whileUp?: (port: string) => Promise<void>): Promise<{ port: string, warned: string, code: number }> {
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
    child.kill('SIGTERM')
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

  it('runs the executable the last build compiled, and the entry once it is gone', async () => {
    const executable = join(dir, 'server')

    await Bun.write(executable, '#!/bin/sh\necho "compiled $NODE_ENV"\n')
    await chmod(executable, 0o755)
    await Bun.write(join(outputDir(dir), 'executable'), executable)

    const compiled = start(dir)

    expect(await new Response(compiled.stdout).text()).toBe('compiled production\n')
    expect(await compiled.exited).toBe(0)

    await rm(executable)
    expect((await listening(start(dir))).warned).toContain('is gone; starting the server entry instead')
  }, 60_000)
})
