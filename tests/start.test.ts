import type { Subprocess } from 'bun'
import { chmod, mkdir, rename, rm, utimes } from 'node:fs/promises'
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

let slow = 0

const app = new Elysia().get('/mode', () => \`\${process.env.NODE_ENV} \${process.env.FROM_DOTENV}\`).get('/inflight', () => String(slow)).get('/slow', async () => {
  slow++
  await Bun.sleep(30_000)

  return 'late'
}).use(await pages()).listen(Number(process.env.PORT ?? 0))

console.log(\`listening \${app.server?.port}\`)
`

function start(dir: string, ...args: string[]): Subprocess<'ignore', 'pipe', 'pipe'> {
  return Bun.spawn([process.execPath, cli, 'start', dir, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
}

// In a process group of its own, as a shell runs a command, for the test to signal the group as Ctrl-C does.
function startGroup(dir: string, ...args: string[]): Subprocess<'ignore', 'pipe', 'pipe'> {
  return Bun.spawn([process.execPath, cli, 'start', dir, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', detached: true })
}

// Runs `whileUp` once the server listens, then stops it with `signal`, as a deployment would: the port it listened on, what `kay start` warned, what the server printed after listening and how it exited.
async function listening(child: Subprocess<'ignore', 'pipe', 'pipe'>, whileUp?: (port: string, printed: () => string) => Promise<void>, signal: NodeJS.Signals = 'SIGTERM', group = false): Promise<{ port: string, warned: string, printed: string, code: number }> {
  const reader = child.stdout.getReader()
  let output = ''

  for (let match = LISTENING.exec(output); !match; match = LISTENING.exec(output)) {
    const { value, done } = await reader.read()

    if (done)
      throw new Error(`kay start exited without listening: ${await new Response(child.stderr).text()}`)

    output += new TextDecoder().decode(value)
  }

  const port = LISTENING.exec(output)![1]!
  const listened = output.indexOf('\n', LISTENING.exec(output)!.index) + 1
  // Read as it comes, for `whileUp` to wait on what the server prints.
  const pump = (async () => {
    for (let read = await reader.read(); !read.done; read = await reader.read())
      output += new TextDecoder().decode(read.value)
  })()

  try {
    await whileUp?.(port, () => output.slice(listened))
  }
  finally {
    if (group)
      process.kill(-child.pid, signal)
    else
      child.kill(signal)
  }

  await pump

  const [warned, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

  return { port, warned, printed: output.slice(listened), code }
}

// Whether nothing listens on the port any more, waiting up to `ms` for it to close.
async function released(port: string, ms = 5000): Promise<boolean> {
  for (const limit = Date.now() + ms; ; await Bun.sleep(20)) {
    try {
      void Bun.serve({ port: Number(port), fetch: () => new Response() }).stop(true)

      return true
    }
    catch {
      if (Date.now() > limit)
        return false
    }
  }
}

// What a kay server does not do itself: counts the SIGINTs it gets, then exits a moment after the first.
const COUNTING = `import process from 'node:process'

let signals = 0

process.on('SIGINT', () => {
  if (signals++ === 0)
    setTimeout(() => {
      console.log(\`signals \${signals}\`)
      process.exit(0)
    }, 300)
})

const server = Bun.serve({ port: Number(process.env.PORT ?? 0), fetch: () => new Response() })

console.log(\`listening \${server.port}\`)
`

// Polls a condition the server makes true, failing past 10 seconds.
async function until(holds: () => boolean | Promise<boolean>): Promise<void> {
  for (const limit = Date.now() + 10_000; !await holds();) {
    if (Date.now() > limit)
      throw new Error('timed out')

    await Bun.sleep(20)
  }
}

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() })
  const { port } = probe

  void probe.stop(true)

  return port!
}

describe('kay start', () => {
  let dir: string
  let built: Promise<void> | undefined
  let compiledAside: string

  // The one build of the file, compiling an executable, made by the first test needing it. The executable waits beside the project, as one in it would date the build older than a source; the tests serving the entry drop its record, the one running it puts both back.
  async function build(): Promise<void> {
    built ??= (async () => {
      const child = Bun.spawn([process.execPath, cli, 'build', dir, '--no-check', '--compile', join(dir, 'bin/server')], { stdout: 'ignore', stderr: 'pipe' })
      const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

      if (code !== 0)
        throw new Error(`kay build failed: ${errors}`)

      await rename(join(dir, 'bin/server'), compiledAside)
    })()

    return built
  }

  beforeAll(async () => {
    dir = await scratchDir('start-')
    compiledAside = `${dir}-compiled`
    await Promise.all([
      Bun.write(join(dir, 'tsconfig.json'), Bun.file(join(import.meta.dir, 'fixtures/site/tsconfig.json'))),
      Bun.write(join(dir, 'src/routes/index.kay'), 'h1 Home\n'),
      Bun.write(join(dir, 'src/server.ts'), SERVER),
      Bun.write(join(dir, '.env.production'), 'FROM_DOTENV=production\n'),
    ])
  })

  afterAll(async () => {
    await Promise.all([rm(dir, { recursive: true, force: true }), rm(compiledAside, { force: true })])
  })

  it('refuses to start a project with no build', async () => {
    const child = start(dir)
    const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

    expect(code).toBe(1)
    expect(errors).toContain('there is no build in')
    expect(errors).toContain('run `kay build` first')
  })

  it('serves the last build in production on the port it names, the server reading .env.production, and warns once a source is newer', async () => {
    await build()
    await rm(join(outputDir(dir), 'executable'))

    const port = String(freePort())
    const served = await listening(start(dir, '--port', port), async () => {
      expect(await (await fetch(`http://localhost:${port}/mode`)).text()).toBe('production production')
      expect(await (await fetch(`http://localhost:${port}/`)).text()).toContain('Home</h1>')
    })

    expect(served).toMatchObject({ port, warned: '', code: 0 })

    const later = new Date(Date.now() + 60_000)

    await utimes(join(dir, 'src/routes/index.kay'), later, later)
    expect((await listening(start(dir))).warned).toContain('the build is older than .kay/scratch/')
  }, 60_000)

  it('serves the entry the build recorded without loading kay.config.ts, the supervisor holding little memory', async () => {
    await build()
    await rm(join(outputDir(dir), 'executable'), { force: true })
    await Bun.write(join(dir, 'kay.config.ts'), 'import process from \'node:process\'\n\n// The server it starts has this set, the supervisor has not.\nif (process.env.KAY_START_PID === undefined)\n  throw new Error(\'config loaded\')\n\nexport default {}\n')

    try {
      const child = start(dir)
      let anon = 0
      const served = await listening(child, async () => {
        anon = Number((/RssAnon:\s+(\d+)/).exec(await Bun.file(`/proc/${child.pid}/status`).text())?.[1])
      })

      expect(served).toMatchObject({ code: 0 })
      expect(served.warned).not.toContain('config loaded')
      // The supervisor imports no compiler or checker: about 8 MB, against 25 when it did.
      expect(anon).toBeLessThan(16_000)
    }
    finally {
      await rm(join(dir, 'kay.config.ts'))
    }
  }, 60_000)

  it('runs the executable the last build compiled, relative to the root, warning when the build is newer, and the entry once it is gone', async () => {
    await build()

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

    await rm(record)
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
      expect(await released(port, 0)).toBe(true)
    }

    // A server without kay's own handling dies of SIGQUIT, as it would run alone.
    expect((await listening(start(dir), undefined, 'SIGQUIT')).code).toBe(131)
  }, 60_000)

  it('passes a Ctrl-C sent to the whole group on once, and stops the server at a second one while it drains', async () => {
    const counting = relative(process.cwd(), join(dir, 'counting.ts'))

    await Bun.write(counting, COUNTING)
    expect((await listening(startGroup(dir, '--entry', counting), undefined, 'SIGINT', true)).printed).toBe('signals 1\n')

    const port = String(freePort())
    const child = start(dir, '--port', port)
    let interrupted = 0
    // Cut off as the server stops.
    const slow = async () => {
      try {
        await fetch(`http://localhost:${port}/slow`)
      }
      catch {}
    }
    const stopped = await listening(child, async (_, printed) => {
      // An open request keeps the server draining for its `shutdownTimeout`, 10 seconds, until the second Ctrl-C.
      void slow()
      await until(async () => await (await fetch(`http://localhost:${port}/inflight`)).text() === '1')
      child.kill('SIGINT')
      interrupted = performance.now()
      await until(() => printed().includes('SIGINT received'))
    }, 'SIGINT')

    expect(stopped.printed).toContain('SIGINT received; finishing open requests')
    expect(stopped.code).toBe(0)
    expect(performance.now() - interrupted).toBeLessThan(5000)
  }, 60_000)

  it('stops the server once kay start is killed with its group, which no signal it passes on reaches, while it serves or still boots', async () => {
    const port = String(freePort())
    const child = startGroup(dir, '--port', port)

    await listening(child, undefined, 'SIGKILL', true)

    expect(await released(port)).toBe(true)

    const late = relative(process.cwd(), join(dir, 'late.ts'))

    const gate = join(dir, 'late.gate')

    await Bun.write(late, `import { existsSync } from 'node:fs'\nimport process from 'node:process'\n\nconsole.log(\`pid \${process.pid}\`)\nwhile (!existsSync(${JSON.stringify(gate)}))\n  await Bun.sleep(5)\n${SERVER}`)

    const booting = startGroup(dir, '--entry', late)
    const reader = booting.stdout.getReader()
    let output = ''

    // Killed as soon as the server says it runs, before it is let listen.
    while (!(/pid \d+\n/).test(output)) {
      const { value, done } = await reader.read()

      if (done)
        throw new Error('kay start exited before the server ran')

      output += new TextDecoder().decode(value)
    }

    const pid = Number((/pid (\d+)/).exec(output)![1])
    const alive = () => {
      try {
        return process.kill(pid, 0)
      }
      catch {
        return false
      }
    }

    process.kill(-booting.pid, 'SIGKILL')
    await Bun.write(gate, '')

    await until(() => !alive())

    expect(alive()).toBe(false)
  }, 30_000)

  it('runs the executable `kay build --compile` made, from wherever the project moved', async () => {
    await build()
    await mkdir(join(dir, 'bin'), { recursive: true })
    await rename(compiledAside, join(dir, 'bin/server'))

    const moved = `${dir}-moved`
    let isMoved = false

    try {
      await Bun.write(join(outputDir(dir), 'executable'), 'bin/server')
      expect(await Bun.file(join(outputDir(dir), 'executable')).text()).toBe('bin/server')
      await rename(dir, moved)
      isMoved = true
      await rm(join(moved, 'src/server.ts'))

      const port = String(freePort())
      const served = await listening(start(moved, '--port', port), async () => {
        expect(await (await fetch(`http://localhost:${port}/mode`)).text()).toBe('production production')
      })

      // Only an earlier test's source dated ahead is newer than the build.
      expect(served.warned).not.toContain('executable')
      expect(served.code).toBe(0)
    }
    finally {
      if (isMoved)
        await rename(moved, dir)

      await rename(join(dir, 'bin/server'), compiledAside)
      await Bun.write(join(dir, 'src/server.ts'), SERVER)
    }
  }, 120_000)
})
