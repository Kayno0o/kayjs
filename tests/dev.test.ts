import type { Subprocess } from 'bun'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { testWorker } from '../src/build/assets'
import { buildClient } from '../src/build/client'
import { KayCompileError } from '../src/build/transform'
import { readShadowSettings } from '../src/check/shadow'
import { dev, watchProject } from '../src/dev'
import { inspectorProxy } from '../src/dev/inspector'
import { bootFailure, hotSwap } from '../src/server/dev'
import { editorCommand } from '../src/server/editor'

// The parent's pid in /proc/<pid>/stat, after the command name and the state.
const PARENT_PID = /\) \S+ (\d+)/

async function until(condition: () => boolean, timeout = 5000) {
  for (const start = Date.now(); !condition(); await Bun.sleep(20)) {
    if (Date.now() - start > timeout)
      throw new Error('timed out')
  }
}

async function firstEvent(response: Response): Promise<string> {
  const reader = response.body!.getReader()
  const { value } = await reader.read()

  await reader.cancel()

  return typeof value === 'string' ? value : new TextDecoder().decode(value)
}

describe('the dev watcher', () => {
  async function watched(files: Record<string, string>) {
    const root = await mkdtemp(join(tmpdir(), 'kay-watch-'))
    const changes: string[] = []

    await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))
    const stop = watchProject(root, file => changes.push(file))
    // Whether a change to `file` arrives while `act` runs again and again, which a watcher that stopped never reports; a directory is armed a moment after its event, so a first change may predate the watcher.
    const sees = async (file: string, act: (attempt: number) => Promise<unknown>, timeout = 5000) => {
      changes.length = 0

      for (let attempt = 0, start = Date.now(); Date.now() - start < timeout; attempt++) {
        await act(attempt)

        try {
          await until(() => changes.includes(file), 200)

          return true
        }
        catch {}
      }

      return false
    }

    return { root, sees, cleanup: async () => {
      stop()
      await rm(root, { recursive: true, force: true })
    } }
  }

  it('keeps watching a root file replaced atomically, and one created after it started', async () => {
    const { root, sees, cleanup } = await watched({ 'tsconfig.json': '{}', 'src/server.ts': '' })

    try {
      for (const round of [1, 2]) {
        expect(await sees('tsconfig.json', async (attempt) => {
          await Bun.write(join(root, 't.tmp'), `{"round":${round},"attempt":${attempt}}`)
          await rename(join(root, 't.tmp'), join(root, 'tsconfig.json'))
        })).toBe(true)
      }

      expect(await sees('tsconfig.json', async attempt => Bun.write(join(root, 'tsconfig.json'), `{"edited":${attempt}}`))).toBe(true)
      expect(await sees('.env.local', async attempt => Bun.write(join(root, '.env.local'), `A=${attempt}\n`))).toBe(true)
      expect(await sees('bunfig.toml', async attempt => Bun.write(join(root, 'bunfig.toml'), `# ${attempt}\n`))).toBe(true)
      expect(await sees('bunfig.toml', async attempt => Bun.write(join(root, 'bunfig.toml'), `# edited ${attempt}\n`))).toBe(true)
    }
    finally {
      await cleanup()
    }
  })

  it('keeps watching a directory that is removed and created again, and one created after it started', async () => {
    const { root, sees, cleanup } = await watched({ 'src/server.ts': '' })

    try {
      expect(await sees('src/server.ts', async (attempt) => {
        await rm(join(root, 'src'), { recursive: true, force: true })
        await Bun.sleep(50)
        await mkdir(join(root, 'src'))
        await Bun.write(join(root, 'src/server.ts'), `${attempt}\n`)
      })).toBe(true)
      expect(await sees('src/server.ts', async attempt => Bun.write(join(root, 'src/server.ts'), `edited ${attempt}\n`))).toBe(true)
      expect(await sees('lib/a.ts', async (attempt) => {
        await mkdir(join(root, 'lib'), { recursive: true })
        await Bun.sleep(50)
        await Bun.write(join(root, 'lib/a.ts'), String(attempt))
      })).toBe(true)
      expect(await sees('lib/a.ts', async attempt => Bun.write(join(root, 'lib/a.ts'), `edited ${attempt}`))).toBe(true)
    }
    finally {
      await cleanup()
    }
  })

  it('ignores dependencies, hidden directories and build output', async () => {
    const { root, sees, cleanup } = await watched({ 'src/server.ts': '', 'node_modules/dep/index.js': '', '.kay/types/a.tsx': '' })

    try {
      expect(await sees('node_modules/dep/index.js', async attempt => Bun.write(join(root, 'node_modules/dep/index.js'), String(attempt)), 300)).toBe(false)
      expect(await sees('.kay/types/a.tsx', async attempt => Bun.write(join(root, '.kay/types/a.tsx'), String(attempt)), 300)).toBe(false)
      expect(await sees('dist', async () => mkdir(join(root, 'dist'), { recursive: true }), 300)).toBe(false)
    }
    finally {
      await cleanup()
    }
  })

  it('ignores tests and the root files no server reads, and keeps what it reads', async () => {
    const { root, sees, cleanup } = await watched({ 'src/server.ts': '', 'src/a.test.ts': '', 'src/__tests__/a.ts': '', 'tests/a.test.ts': '', '.env': '', 'README.md': '', 'LICENSE': '', 'kay.config.ts': '', 'package.json': '{}', 'bun.lock': '', 'public/a.txt': '' })

    try {
      expect(await sees('tests/a.test.ts', async attempt => Bun.write(join(root, 'tests/a.test.ts'), String(attempt)), 300)).toBe(false)
      expect(await sees('src/a.test.ts', async attempt => Bun.write(join(root, 'src/a.test.ts'), String(attempt)), 300)).toBe(false)
      expect(await sees('src/__tests__/a.ts', async attempt => Bun.write(join(root, 'src/__tests__/a.ts'), String(attempt)), 300)).toBe(false)
      expect(await sees('README.md', async attempt => Bun.write(join(root, 'README.md'), String(attempt)), 300)).toBe(false)
      expect(await sees('LICENSE', async attempt => Bun.write(join(root, 'LICENSE'), String(attempt)), 300)).toBe(false)

      for (const file of ['kay.config.ts', '.env', 'package.json', 'bun.lock', 'src/server.ts', 'public/a.txt'])
        expect(await sees(file, async attempt => Bun.write(join(root, file), String(attempt)))).toBe(true)

      expect(await sees('public', async () => rm(join(root, 'public'), { recursive: true }))).toBe(true)
    }
    finally {
      await cleanup()
    }
  })

  it('ignores a root directory the project itself ignores, as a database bind-mounted into it is', async () => {
    const { root, sees, cleanup } = await watched({ 'src/server.ts': '', '.gitignore': '# data\n/data-dev/\ndata\n*.log\nsrc/generated\n', 'data-dev/postgres/base/1': '', 'data/x': '', 'src/generated/a.ts': '' })

    try {
      expect(await sees('data-dev/postgres/base/1', async attempt => Bun.write(join(root, 'data-dev/postgres/base/1'), String(attempt)), 300)).toBe(false)
      expect(await sees('data/x', async attempt => Bun.write(join(root, 'data/x'), String(attempt)), 300)).toBe(false)
      // A pattern reaching deeper than a root directory is left to the walk, so the source under it is still watched.
      expect(await sees('src/generated/a.ts', async attempt => Bun.write(join(root, 'src/generated/a.ts'), String(attempt)))).toBe(true)
      expect(await sees('src/server.ts', async attempt => Bun.write(join(root, 'src/server.ts'), String(attempt)))).toBe(true)
    }
    finally {
      await cleanup()
    }
  })

  it('starts the server with the .env as it is now, over the values Bun loaded into kay dev itself', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-dev-'))
    const seen = join(root, 'seen.txt')

    await Bun.write(join(root, '.env'), 'KAY_GREETING=hello\nKAY_FROM_SHELL=file\n')
    await Bun.write(join(root, 'src/server.ts'), `await Bun.write(${JSON.stringify(seen)}, \`\${process.env.KAY_GREETING}|\${process.env.KAY_FROM_SHELL}\`)\nsetInterval(() => undefined, 1000)\n`)
    // The command runs in the project, so Bun loads its .env into the process that restarts the server.
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'dev'], { cwd: root, env: { ...process.env, KAY_FROM_SHELL: 'shell' }, stdout: 'ignore', stderr: 'ignore' })

    try {
      await until(() => existsSync(seen), 10_000)
      expect(await Bun.file(seen).text()).toBe('hello|shell')

      await rm(seen)
      await Bun.write(join(root, '.env'), 'KAY_GREETING=changed\nKAY_FROM_SHELL=file\n')
      await until(() => existsSync(seen), 10_000)
      expect(await Bun.file(seen).text()).toBe('changed|shell')
    }
    finally {
      child.kill('SIGINT')
      await child.exited
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('kay dev', () => {
  it('restarts the server on a change and keeps the generated types current, written from the config as kay check writes them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-dev-'))
    const children: Subprocess[] = []

    await Bun.write(join(root, 'src/server.ts'), 'setInterval(() => undefined, 1000)\n')
    await Bun.write(join(root, 'src/routes/index.kay'), 'p Home\n')
    await Bun.write(join(root, 'site-content.ts'), 'export {}\n')
    const stop = await dev(root, { config: { lints: { 'unread-name': 'allow' }, content: 'site-content.ts' }, onRestart: child => children.push(child) })

    try {
      expect(children).toHaveLength(1)
      expect(await Bun.file(join(root, '.kay/types/src/routes/index.kay.tsx')).exists()).toBe(true)
      expect(readShadowSettings(root).lints).toEqual({ 'unread-name': 'allow' })
      expect(await Bun.file(join(root, '.kay/types/kay-env.d.ts')).text()).toContain('FeedPathsOf<typeof import("../../site-content")>')

      await Bun.write(join(root, 'src/routes/about.kay'), 'p About\n')
      await until(() => children.length === 2)

      expect(children[0]!.killed).toBe(true)
      // The new server starts first; the types follow it.
      await until(() => existsSync(join(root, '.kay/types/src/routes/about.kay.tsx')))
    }
    finally {
      await stop()
      await rm(root, { recursive: true, force: true })
    }
    expect(children.at(-1)!.killed).toBe(true)
  })

  it('loads the .kay modules and globs the entry imports before it calls pages()', async () => {
    const base = join(import.meta.dir, '../node_modules/.cache')

    await mkdir(base, { recursive: true })
    const root = await mkdtemp(join(base, 'kay-dev-'))
    const seen = join(root, 'seen.txt')

    await Bun.write(join(root, 'src/mails/welcome.kay'), 'p Welcome\n')
    await Bun.write(join(root, 'src/mailer.ts'), 'import Welcome from \'./mails/welcome.kay\'\n\nexport const mails = { Welcome, ...import.meta.glob(\'./mails/*.kay\', { eager: true, import: \'default\' }) }\n')
    await Bun.write(join(root, 'src/server.ts'), `import { mails } from './mailer'\n\nawait Bun.write(${JSON.stringify(seen)}, Object.entries(mails).map(([name, mail]) => \`\${name}: \${typeof mail}\`).join(', '))\nsetInterval(() => undefined, 1000)\n`)
    const stop = await dev(root)

    try {
      await until(() => existsSync(seen), 15_000)
      expect(readFileSync(seen, 'utf8')).toBe('Welcome: function, ./mails/welcome.kay: function')
    }
    finally {
      await stop()
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('starts the loader over when pages() names another project than kay dev guessed', async () => {
    const base = join(import.meta.dir, '../node_modules/.cache')

    await mkdir(base, { recursive: true })
    const root = await mkdtemp(join(base, 'kay-dev-'))
    const app = join(root, 'app')
    const loader = join(import.meta.dir, '../src/server/loader.ts')

    await Bun.write(join(app, 'src/hello.kay'), 'p Hello\n')
    await Bun.write(join(root, 'script.ts'), `import { registerEarlyLoader, registerLoader } from ${JSON.stringify(loader)}\n\nawait registerEarlyLoader(${JSON.stringify(root)})\nawait registerLoader(${JSON.stringify(app)})\nconsole.log(typeof (await import(${JSON.stringify(join(app, 'src/hello.kay'))})).default)\n`)

    try {
      const run = Bun.spawnSync([process.execPath, join(root, 'script.ts')], { cwd: root })

      expect([run.stdout.toString(), run.stderr.toString()]).toEqual(['function\n', ''])
      // Compiled by the loader registered for the app, not by the one guessed.
      expect([existsSync(join(app, '.kay/cache')), existsSync(join(root, '.kay/cache'))]).toEqual([true, false])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('runs from the command line on the project a directory names, or with the entry --entry names, on the port --port names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-dev-'))
    const seen = join(root, 'seen.txt')
    const cli = join(import.meta.dir, '../src/cli.ts')
    const report = (name: string) => `await Bun.write(${JSON.stringify(seen)}, \`${name}|\${process.cwd()}|\${process.env.PORT}\`)\nsetInterval(() => undefined, 1000)\n`
    const port = process.env.PORT

    await Bun.write(join(root, 'src/server.ts'), report('server'))
    await Bun.write(join(root, 'src/other.ts'), report('other'))

    try {
      // An entry file in place of the directory, as `kay dev` took before, runs in the current directory.
      for (const [args, expected, cwd] of [[[root], `server|${root}|${port}`, undefined], [[root, '--entry', join(root, 'src/other.ts')], `other|${root}|${port}`, undefined], [['src/other.ts'], `other|${root}|${port}`, root], [[root, '--port', '4123'], `server|${root}|4123`, undefined]] as const) {
        const child = Bun.spawn(['bun', cli, 'dev', ...args], { cwd: cwd ?? process.cwd(), stdout: 'ignore', stderr: 'pipe' })

        await until(() => existsSync(seen) && readFileSync(seen, 'utf8') === expected, 10_000)
        child.kill('SIGTERM')
        expect(await child.exited).toBe(0)
        await rm(seen, { force: true })
      }

      const refused = Bun.spawn(['bun', cli, 'dev', join(root, 'src/server.ts'), '--entry', 'src/other.ts'], { stdout: 'ignore', stderr: 'pipe' })

      expect(await refused.exited).toBe(1)
      expect(await new Response(refused.stderr).text()).toContain('is not a directory, and --entry names the server entry already')

      const notPort = Bun.spawn(['bun', cli, 'dev', root, '--port', '70000'], { stdout: 'ignore', stderr: 'pipe' })

      expect(await notPort.exited).toBe(1)
      expect(await new Response(notPort.stderr).text()).toContain('--port takes a port number, not 70000')

      const missing = Bun.spawn(['bun', cli, 'dev', join(root, 'typo')], { stdout: 'ignore', stderr: 'pipe' })

      expect(await missing.exited).toBe(1)
      expect(await new Response(missing.stderr).text()).toContain('is neither a directory nor a file')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('runs the entry as the main module, and a changed .env reaches the next server', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-dev-'))
    const seen = join(root, 'seen.txt')
    const children: Subprocess[] = []

    await Bun.write(join(root, '.env'), 'KAY_GREETING=hello\n')
    await Bun.write(join(root, 'src/server.ts'), `await Bun.write(${JSON.stringify(seen)}, \`\${process.env.KAY_GREETING}|\${import.meta.main}\`)\nsetInterval(() => undefined, 1000)\n`)
    const stop = await dev(root, { onRestart: child => children.push(child) })

    try {
      await until(() => existsSync(seen))
      expect(await Bun.file(seen).text()).toBe('hello|true')

      await Bun.write(join(root, '.env'), 'KAY_GREETING=changed\n')
      await until(() => children.length === 2)
      await until(() => readFileSync(seen, 'utf8').startsWith('changed'))
      expect(await Bun.file(seen).text()).toBe('changed|true')
    }
    finally {
      await stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('serves the pages itself while the project has no server entry, and runs one written meanwhile at the next restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-dev-'))
    const seen = join(root, 'seen.txt')
    const children: Subprocess[] = []

    await Bun.write(join(root, '.env'), 'PORT=0\n')
    await Bun.write(join(root, 'src/routes/index.kay'), 'p Home\n')
    const stop = await dev(root, { onRestart: child => children.push(child) })

    try {
      await Bun.sleep(500)
      expect(children[0]!.exitCode).toBeNull()

      await Bun.write(join(root, 'src/server.ts'), `await Bun.write(${JSON.stringify(seen)}, 'server')\nsetInterval(() => undefined, 1000)\n`)
      await until(() => existsSync(seen), 10_000)
      expect(children).toHaveLength(2)
    }
    finally {
      await stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('tells each server how many changes other than to stylesheets came before it, counting on from the last run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-dev-'))
    // Hidden, so writing it restarts nothing.
    const seen = join(root, '.seen')
    const children: Subprocess[] = []

    await Bun.write(join(root, 'src/server.ts'), `await Bun.write(${JSON.stringify(seen)}, process.env.KAY_DEV_CODE ?? '')\nsetInterval(() => undefined, 1000)\n`)
    await Bun.write(join(root, 'src/app.css'), 'p { color: red }\n')
    let stop = await dev(root, { onRestart: child => children.push(child) })
    const restartAfter = async (file: string, content: string) => {
      const count = children.length

      await rm(seen, { force: true })
      await Bun.write(join(root, file), content)
      await until(() => children.length > count && existsSync(seen))
      // A save can come as several events, each restarting once their debounce settles.
      await Bun.sleep(200)
      await until(() => existsSync(seen))

      return Bun.file(seen).text()
    }

    try {
      await until(() => existsSync(seen))
      const first = await Bun.file(seen).text()

      expect(await restartAfter('src/app.css', 'p { color: blue }\n')).toBe(first)
      const edited = Number(await restartAfter('src/routes/index.kay', 'p Home\n'))

      expect(edited).toBeGreaterThan(Number(first))

      // A page left open across two runs takes the next run's count for new code.
      await stop()
      await rm(seen, { force: true })
      stop = await dev(root, { onRestart: child => children.push(child) })
      await until(() => existsSync(seen))
      expect(Number(await Bun.file(seen).text())).toBeGreaterThan(edited)
    }
    finally {
      await stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports the address once, then each restart with what changed, and a server exiting on its own', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-dev-'))
    const lines: string[] = []
    const free = Bun.serve({ port: 0, fetch: () => new Response() })
    const port = free.port!

    await free.stop()
    await Bun.write(join(root, 'src/server.ts'), `if (await Bun.file('src/exit.ts').exists()) process.exit(3)\nBun.serve({ port: ${port}, fetch: () => new Response('ok') })\n`)
    const stop = await dev(root, { log: line => lines.push(line) })

    try {
      await until(() => lines.length === 1)
      expect(lines[0]).toMatch(new RegExp(`^kay dev: http://localhost:${port} \\(ready in \\d+ ms\\)$`))

      await Bun.write(join(root, 'src/routes/about.kay'), 'p About\n')
      await until(() => lines.length === 2)
      expect(lines[1]).toMatch(/^\d\d:\d\d:\d\d src\/routes\/about\.kay: restarted in \d+ ms$/)

      await Bun.write(join(root, 'src/exit.ts'), '')
      await until(() => lines.length === 3)
      expect(lines[2]).toMatch(/^\d\d:\d\d:\d\d the server exited with code 3, waiting for a change$/)
    }
    finally {
      await stop()
      await rm(root, { recursive: true, force: true })
    }
    expect(lines).toHaveLength(3)
  })

  it('moves off a busy port, saying which was in use, and stays on the port it moved to after a restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-dev-'))
    const lines: string[] = []
    const holder = Bun.serve({ port: 0, fetch: () => new Response('holder') })
    const busy = holder.port!

    await Bun.write(join(root, 'src/server.ts'), `Bun.serve({ port: ${busy}, fetch: () => new Response('ok') })\n`)
    const stop = await dev(root, { log: line => lines.push(line) })

    try {
      await until(() => lines.length === 1)
      const [, moved] = new RegExp(`^kay dev: http://localhost:(\\d+) \\(ready in \\d+ ms, ${busy} was in use\\)$`).exec(lines[0]!) ?? []

      expect(Number(moved)).toBeGreaterThan(busy)
      expect(await (await fetch(`http://localhost:${moved}`)).text()).toBe('ok')

      // The port it asked for is free again, but open pages stay on the one it moved to.
      await holder.stop()
      await Bun.write(join(root, 'src/routes/about.kay'), 'p About\n')
      await until(() => lines.length === 2)
      expect(lines[1]).toMatch(/^\d\d:\d\d:\d\d src\/routes\/about\.kay: restarted in \d+ ms$/)
      expect(await (await fetch(`http://localhost:${moved}`)).text()).toBe('ok')
    }
    finally {
      await holder.stop()
      await stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('opens the address in the BROWSER command once, not on a restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-dev-'))
    const lines: string[] = []
    const opened = join(root, 'opened.txt')
    const browser = join(root, 'browser.sh')
    const previous = process.env.BROWSER

    await Bun.write(browser, `#!/bin/sh\necho "$1" >> ${JSON.stringify(opened)}\n`)
    chmodSync(browser, 0o755)
    await Bun.write(join(root, 'src/server.ts'), 'Bun.serve({ port: 0, fetch: () => new Response() })\n')
    process.env.BROWSER = browser
    const stop = await dev(root, { open: true, log: line => lines.push(line) })

    try {
      await until(() => existsSync(opened))
      const [, address] = (/^kay dev: (\S+) /).exec(lines[0]!) ?? []

      await Bun.write(join(root, 'src/routes/about.kay'), 'p About\n')
      await until(() => lines.length === 2)
      expect(readFileSync(opened, 'utf8')).toBe(`${address}\n`)
    }
    finally {
      process.env.BROWSER = previous
      await stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('opens the debugger --inspect names on every server it runs, at the address it prints once, which a client closing as it connects never ends', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-dev-'))
    // Outside the project, whose changes restart the server, and written before it listens, so it is there once kay dev prints the address.
    const spawned = `${root}-spawned.txt`

    await Bun.write(join(root, 'src/server.ts'), `await Bun.write(${JSON.stringify(spawned)}, String(Bun.env.BUN_INSPECT))\nBun.serve({ port: 0, fetch: () => new Response() })\n`)
    const child = Bun.spawn(['bun', join(import.meta.dir, '../src/cli.ts'), 'dev', root, '--inspect=0'], { stdout: 'pipe', stderr: 'pipe' })
    const sockets = async () => Array.fromAsync(new Bun.Glob(`kay-inspect-${child.pid}-*`).scan({ cwd: tmpdir(), onlyFiles: false }))
    const output: string[] = []
    let port = 0
    const reading = (async () => {
      for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream()))
        output.push(...chunk.split('\n').filter(Boolean))
    })()
    // Closed as soon as it opens, as a debugger tab reloading does, which under Bun 1.4 let a server's process exit (#285).
    const opens = async () => {
      const socket = new WebSocket(`ws://localhost:${port}/kay`)
      const { promise, resolve } = Promise.withResolvers<boolean>()

      socket.addEventListener('open', () => resolve(true))
      socket.addEventListener('error', () => resolve(false))
      const open = await promise

      socket.close()

      return open
    }
    // A debugger staying connected: the process it reaches, and its connection closing.
    const session = async () => {
      const socket = new WebSocket(`ws://localhost:${port}/kay`)
      const answers = new Map<number, (value: unknown) => void>()
      const closed = new Promise<void>(resolve => socket.addEventListener('close', () => resolve()))
      let id = 0

      socket.addEventListener('message', (event) => {
        const { id, result } = JSON.parse(String(event.data)) as { id: number, result: { result: { value: unknown } } }

        answers.get(id)?.(result.result.value)
      })
      await new Promise(resolve => socket.addEventListener('open', resolve))

      return {
        pid: async () => new Promise((resolve) => {
          answers.set(++id, resolve)
          socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: 'process.pid' } }))
        }),
        closed,
      }
    }

    try {
      await until(() => output.length === 2, 10_000)
      port = Number((/localhost:(\d+)/).exec(output[1]!)?.[1])
      expect(output[1]).toBe(`kay dev: debugger on ws://localhost:${port}/kay, https://debug.bun.sh/#localhost:${port}/kay`)

      for (let attempt = 0; attempt < 10; attempt++)
        expect(await opens()).toBe(true)

      // The app's own processes do not try to open it again.
      expect(await Bun.file(spawned).text()).toBe('undefined')

      const first = await session()
      const pid = await first.pid()

      // Every attempt from the moment the next server starts, when its inspector is setting up.
      await Bun.write(join(root, 'src/routes/about.kay'), 'p About\n')
      for (const start = Date.now(); output.length < 3 && Date.now() - start < 10_000;)
        await opens()

      expect(output[2]).toMatch(/restarted in/)

      for (let attempt = 0; attempt < 10; attempt++)
        expect(await opens()).toBe(true)

      // The debugger's connection ends with its server, and connecting again reaches the next.
      await first.closed
      expect(await (await session()).pid()).not.toBe(pid)
      // A server let go of exits within milliseconds and says so.
      await Bun.sleep(500)
      expect(output).toHaveLength(3)

      const second = Bun.spawn(['bun', join(import.meta.dir, '../src/cli.ts'), 'dev', root, `--inspect=${port}`], { stdout: 'ignore', stderr: 'pipe' })

      expect(await second.exited).toBe(1)
      expect(await new Response(second.stderr).text()).toBe(`kay dev: the debugger address localhost:${port} is in use\n`)
      expect(await sockets()).toHaveLength(1)
    }
    finally {
      child.kill('SIGTERM')
      await child.exited
      await reading
      expect(await sockets()).toEqual([])
      await Promise.all([rm(root, { recursive: true, force: true }), rm(spawned, { force: true })])
    }
  })

  it('lets no page of another site reach the debugger, as Bun\'s inspector does', async () => {
    const proxy = inspectorProxy('ws://localhost:0/kay', () => undefined)
    const status = async (headers: Record<string, string>) => (await fetch(proxy.url.replace('ws:', 'http:'), { headers })).status

    try {
      // Not a WebSocket upgrade, the answer once both checks pass.
      expect(await status({})).toBe(426)
      expect(await status({ host: '127.0.0.1', origin: 'https://debug.bun.sh' })).toBe(426)
      expect(await status({ origin: 'http://localhost:3000' })).toBe(426)
      expect(await status({ host: 'evil.example' })).toBe(400)
      expect(await status({ origin: 'https://evil.example' })).toBe(403)
      expect(await status({ origin: 'http://localhost.evil.example' })).toBe(403)
    }
    finally {
      await proxy.stop()
    }
  })

  it('drops the line an entry prints once it listens, which kay dev prints itself', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-dev-'))
    const messages: unknown[] = []

    await Bun.write(join(root, 'server.ts'), 'const server = Bun.serve({ port: 0, fetch: () => new Response() })\nconsole.log(`Listening on http://localhost:${server.port}`)\nconsole.log(`Listening on http://localhost:${server.port + 1}`)\nconsole.log(\'Listening on\', server.port)\nawait server.stop()\n')
    const child = Bun.spawn([process.execPath, '--preload', join(import.meta.dir, '../src/dev/spare.ts'), join(root, 'server.ts')], { cwd: root, stdin: 'pipe', stdout: 'pipe', stderr: 'inherit', ipc: message => messages.push(message) })

    try {
      void child.stdin.write('start 0\n')
      void child.stdin.flush()
      const output = await new Response(child.stdout).text()
      const [listening] = messages as { listening: string }[]
      const port = Number(new URL(listening!.listening).port)

      expect(await child.exited).toBe(0)
      expect(output).toBe(`Listening on http://localhost:${port + 1}\nListening on ${port}\n`)
    }
    finally {
      child.kill()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('marks its pages for the inspector, serves it, and opens the file it names in KAY_EDITOR, telling when that fails', async () => {
    // Inside the repository, where the browser build resolves `kay`.
    const scratch = join(import.meta.dir, '../node_modules/.cache')

    await mkdir(scratch, { recursive: true })
    const root = await mkdtemp(join(scratch, 'inspect-'))
    const seen = join(root, '.seen')
    const lines: string[] = []

    // Records the first call, and fails the next as an editor with nothing to open in would.
    await Bun.write(join(root, 'record.ts'), `import { existsSync } from 'node:fs'\nif (existsSync(${JSON.stringify(seen)})) process.exit(1)\nawait Bun.write(${JSON.stringify(seen)}, JSON.stringify(process.argv.slice(2)))\n`)
    await Bun.write(join(root, '.env'), 'PORT=0\n')
    await Bun.write(join(root, 'src/routes/index.kay'), 'main\n  h1 Home\n')
    // Over any the shell set, which would win over a `.env` value.
    const editor = process.env.KAY_EDITOR

    process.env.KAY_EDITOR = `${process.execPath} ${join(root, 'record.ts')}`
    const stop = await dev(root, { log: line => lines.push(line) })

    if (editor === undefined)
      delete process.env.KAY_EDITOR
    else
      process.env.KAY_EDITOR = editor

    try {
      await until(() => lines.length === 1, 20_000)

      const url = lines[0]!.split(' ')[2]!
      const page = await (await fetch(url)).text()

      expect(page).toContain('<h1 data-kay-src="src/routes/index.kay:2:3">Home</h1>')
      expect(page).toContain('<script type="module" src="/_kay/dev/inspector.js"></script>')
      expect(await (await fetch(`${url}/_kay/dev/inspector.js`)).text()).toContain('startInspector()')

      const open = async (source: string, headers: Record<string, string> = { 'x-kay-dev': '1' }) => fetch(`${url}/_kay/dev/open`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ source }) })

      expect((await open('src/routes/index.kay:2:3', {})).status).toBe(403)
      expect((await open('../outside.kay:1:1')).status).toBe(404)
      expect((await open('record.ts:1:1')).status).toBe(404)
      expect(await (await open('src/routes/index.kay:2:3')).json()).toEqual({ opened: true })
      await until(() => existsSync(seen))
      expect(JSON.parse(readFileSync(seen, 'utf8'))).toEqual([join(root, 'src/routes/index.kay')])
      expect(await (await open('src/routes/index.kay:2:3')).json()).toEqual({ opened: false, failed: true })
    }
    finally {
      await stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps serving the stylesheets its pages link while a build of the same project runs beside it', async () => {
    const scratch = join(import.meta.dir, '../node_modules/.cache')

    await mkdir(scratch, { recursive: true })
    const root = await mkdtemp(join(scratch, 'dev-output-'))
    const lines: string[] = []

    await Bun.write(join(root, '.env'), 'PORT=0\n')
    await Bun.write(join(root, 'src/app.css'), 'p { color: red }\n')
    await Bun.write(join(root, 'src/post.css'), 'h1 { color: blue }\n')
    await Bun.write(join(root, 'src/routes/_layout.kay'), '---\nimport \'../app.css\'\n---\nmain\n  slot\n')
    await Bun.write(join(root, 'src/routes/posts/[slug].kay'), '--- server\nconst slug = ctx.params.slug\n---\n---\nimport \'../../post.css\'\n---\nh1 {slug}\n')
    const stop = await dev(root, { log: line => lines.push(line) })

    try {
      await until(() => lines.length === 1, 20_000)

      const url = lines[0]!.split(' ')[2]!
      const page = await (await fetch(`${url}/posts/hello`)).text()
      const stylesheets = [...page.matchAll(/href="(\/_kay\/[^"]+\.css)"/g)].map(([, href]) => href!)

      expect(stylesheets.some(href => href.startsWith('/_kay/[slug]-'))).toBe(true)

      // As `kay build` or a test run does, from a process `kay dev` did not start.
      await buildClient(root)

      for (const href of stylesheets)
        expect((await fetch(url + href)).status).toBe(200)
    }
    finally {
      await stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('builds the client beside the server: again for what an edit reaches only, its maps pointed at the .kay sources, its errors served, and a stylesheet edit sent to the open pages without a restart', async () => {
    const scratch = join(import.meta.dir, '../node_modules/.cache')

    await mkdir(scratch, { recursive: true })
    const root = await mkdtemp(join(scratch, 'dev-client-'))
    const lines: string[] = []
    const children: Subprocess[] = []
    const page = '--- server\nimport { name } from \'../name\'\n---\n---\nimport \'../app.css\'\nimport Counter from \'../counter.kay\'\n---\nh1 {name}\nCounter\n'
    const counter = '---\nimport { signal } from \'kay\'\n\nconst count = signal(0)\n---\nbutton(onClick={() => count.set(n => n + 1)}) {count()}\n'
    const output = join(root, '.kay', `dev${testWorker()}`)
    // The browser build's scripts and stylesheets as each was last written.
    const written = () => Object.fromEntries(readdirSync(join(output, 'dist')).filter(file => !file.endsWith('.map')).map(file => [file, statSync(join(output, 'dist', file)).mtimeMs]))

    await Bun.write(join(root, 'src/app.css'), 'h1 { color: red }\n')
    await Bun.write(join(root, 'src/name.ts'), 'export const name = \'Ada\'\n')
    await Bun.write(join(root, 'src/counter.kay'), counter)
    await Bun.write(join(root, 'src/routes/index.kay'), page)
    // One port for every server, which a port of 0 would change at each restart.
    const probe = Bun.listen({ hostname: 'localhost', port: 0, socket: { data: () => undefined } })
    const port = probe.port

    probe.stop(true)
    const stop = await dev(root, { port, log: line => lines.push(line), onRestart: child => children.push(child) })

    try {
      await until(() => lines.length === 1, 20_000)

      const url = lines[0]!.split(' ')[2]!
      const stylesheet = async () => {
        const href = (/href="(\/_kay\/[^"]+\.css)"/).exec(await (await fetch(url)).text())![1]!

        return (await fetch(url + href)).text()
      }

      expect(await stylesheet()).toContain('red')

      const [chunk] = (await Bun.file(join(output, 'manifest.json')).json() as { islands: Record<string, string[]> }).islands['src/counter.kay']!
      const mapped = async () => ((await (await fetch(`${url}${chunk}.map`)).json()) as { sourcesContent: (string | null)[] }).sourcesContent.includes(counter)

      for (const start = Date.now(); !await mapped(); await Bun.sleep(50)) {
        if (Date.now() - start > 10_000)
          throw new Error('the island\'s map never pointed at counter.kay')
      }

      const events = (await fetch(`${url}/_kay/dev/events`)).body!.getReader()

      await events.read()
      await Bun.write(join(root, 'src/app.css'), 'h1 { color: blue }\n')
      await until(() => lines.some(line => line.includes('src/app.css: stylesheets swapped in')), 10_000)

      expect(new TextDecoder().decode((await events.read()).value)).toStartWith('event: styles\n')
      expect(await stylesheet()).toContain('#00f')
      expect(children).toHaveLength(1)
      await events.cancel()

      const before = written()

      await Bun.write(join(root, 'src/name.ts'), 'export const name = \'Grace\'\n')
      await until(() => lines.length === 3, 10_000)

      expect(await (await fetch(url)).text()).toContain('Grace</h1>')
      expect(written()).toEqual(before)

      await Bun.write(join(root, 'src/routes/index.kay'), `${page}else\n  p no\n`)
      await until(() => lines.length === 4, 10_000)

      const failed = await fetch(url)

      expect(failed.status).toBe(500)
      expect(await failed.text()).toContain('src/routes/index.kay:10:1')

      await Bun.write(join(root, 'src/routes/index.kay'), page)
      await until(() => lines.length === 5, 10_000)

      expect(await (await fetch(url)).text()).toContain('Grace</h1>')
      expect(children).toHaveLength(4)
    }
    finally {
      await stop()
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('keeps one process building the client when the config changes while an island edit builds', async () => {
    const scratch = join(import.meta.dir, '../node_modules/.cache')

    await mkdir(scratch, { recursive: true })
    const root = await mkdtemp(join(scratch, 'dev-builders-'))
    const real = realpathSync(root)
    const lines: string[] = []
    const counter = (step: number) => `---\nimport { signal } from 'kay'\n\nconst count = signal(${step})\n---\nbutton(onClick={() => count.set(n => n + 1)}) {count()}\n`
    // This process's children building the client of this project.
    const builders = () => readdirSync('/proc').filter((pid) => {
      try {
        return PARENT_PID.exec(readFileSync(`/proc/${pid}/stat`, 'utf8'))?.[1] === String(process.pid) && readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('builder.ts') && readlinkSync(`/proc/${pid}/cwd`) === real
      }
      catch {
        return false
      }
    })

    await Bun.write(join(root, 'kay.config.ts'), 'export default {}\n')
    await Bun.write(join(root, 'src/counter.kay'), counter(0))
    await Bun.write(join(root, 'src/routes/index.kay'), '---\nimport Counter from \'../counter.kay\'\n---\nCounter\n')
    const stop = await dev(root, { log: line => lines.push(line) })

    try {
      await until(() => lines.length === 1, 20_000)

      // The config changing at any moment of the island's build.
      for (let step = 1; step <= 8; step++) {
        await Bun.write(join(root, 'src/counter.kay'), counter(step))
        await Bun.sleep(step * 20)
        await Bun.write(join(root, 'kay.config.ts'), `export default {}\n// ${step}\n`)
        await Bun.sleep(300)
      }

      // Settled: no restart for a while.
      for (let seen = lines.length, quiet = Date.now(); Date.now() - quiet < 1500; await Bun.sleep(100)) {
        if (lines.length !== seen) {
          seen = lines.length
          quiet = Date.now()
        }
      }

      const [first] = builders()

      expect(builders()).toHaveLength(1)
      expect(lines.join('\n')).not.toContain('the process building the client exited')

      // One gone on its own starts again with the next build.
      process.kill(Number(first), 'SIGKILL')
      await until(() => builders().length === 0)
      await Bun.write(join(root, 'src/counter.kay'), counter(9))
      await until(() => builders().length === 1 && builders()[0] !== first, 10_000)
    }
    finally {
      await stop()
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('serves the compile errors of a project that failed to boot, and the reload stream', async () => {
    const source = 'p ok\nelse\n  p no\n'
    const error = new KayCompileError([{ file: join(process.cwd(), 'src/broken.kay'), source, start: 5, end: 9, message: '`else` must directly follow an `if`' }])
    const app = bootFailure(error, process.cwd())
    const page = await app.handle(new Request('http://localhost/any/page'))
    const html = await page.text()

    expect(page.status).toBe(500)
    expect(html).toContain(' --&gt; src/broken.kay:2:1\n')
    expect(html).toContain('2 | else\n  | ^^^^')
    expect(html).toContain('new EventSource("/_kay/dev/events")')

    const events = await app.handle(new Request('http://localhost/_kay/dev/events'))

    expect(events.headers.get('content-type')).toBe('text/event-stream')
    // Its code is its own id, so pages on either side of it always reload.
    expect(await firstEvent(events)).toMatch(/^retry: 100\nevent: boot\ndata: ([\w-]+) \1\n\n$/)
  })
})

describe('hot swap', () => {
  it('names the new chunks of the edited islands, and of each island holding their code, for pages on the code before', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-hot-'))
    // As Bun splits them: the counter, which the panel embeds, moves into a chunk of its own, leaving its island chunk a stub; both reach the runtime.
    const islands = { 'src/counter.kay': ['/_kay/counter.js', '/_kay/counter-code.js', '/_kay/runtime.js'], 'src/panel.kay': ['/_kay/panel.js', '/_kay/counter-code.js', '/_kay/runtime.js'], 'src/other.kay': ['/_kay/other.js', '/_kay/runtime.js'] }
    const chunkInputs = { '/_kay/counter.js': [], '/_kay/counter-code.js': ['src/counter.kay'], '/_kay/panel.js': ['src/panel.kay'], '/_kay/other.js': ['src/other.kay'], '/_kay/runtime.js': ['src/runtime/dom.ts'] }
    const client = { islands, chunkInputs, entry: '/_kay/entry.js', entryImports: [], dir: root, styles: new Map(), pages: new Map() }
    const swapAfter = (changed: string[] | string) => {
      process.env.KAY_DEV_FROM = '3'
      process.env.KAY_DEV_CHANGED = typeof changed === 'string' ? changed : JSON.stringify(changed)

      try {
        return hotSwap(root, client)
      }
      finally {
        delete process.env.KAY_DEV_FROM
        delete process.env.KAY_DEV_CHANGED
      }
    }

    await Promise.all(['src/counter.kay', 'src/other.kay', 'src/page.kay'].map(async file => Bun.write(join(root, file), 'p x\n')))

    try {
      expect(swapAfter(['src/counter.kay', 'src/.counter.kay.swp', 'src/counter.kay~'])).toEqual({ from: 3, islands: { 'src/counter.kay': islands['src/counter.kay'], 'src/panel.kay': islands['src/panel.kay'] }, fresh: ['/_kay/counter-code.js'], entry: '/_kay/entry.js' })
      expect(swapAfter(['src/counter.kay', 'src/page.kay'])).toBeUndefined()
      expect(swapAfter(['src/counter.kay', 'src/deleted.ts'])).toBeUndefined()
      expect(swapAfter([])).toBeUndefined()
      expect(swapAfter('null')).toBeUndefined()
      expect(swapAfter('["src/counter.ka')).toBeUndefined()
      expect(hotSwap(root, client)).toBeUndefined()
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('passes each server the files changed since the last one, and the count it started from', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-dev-'))
    const seen = join(root, '.seen')
    const children: Subprocess[] = []

    await Bun.write(join(root, 'src/server.ts'), `await Bun.write(${JSON.stringify(seen)}, \`\${process.env.KAY_DEV_FROM} \${process.env.KAY_DEV_CHANGED}\`)\nsetInterval(() => undefined, 1000)\n`)
    const stop = await dev(root, { onRestart: child => children.push(child) })

    try {
      await until(() => existsSync(seen))
      const [first, none] = (await Bun.file(seen).text()).split(' ')

      expect(none).toBe('[]')

      await rm(seen)
      await Bun.write(join(root, 'src/island.kay'), 'p x\n')
      await until(() => existsSync(seen))

      const [from, changed] = (await Bun.file(seen).text()).split(' ')

      expect(from).toBe(first)
      expect(JSON.parse(changed!)).toContain('src/island.kay')
    }
    finally {
      await stop()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('the editor the inspector opens', () => {
  it('passes the position the way each editor takes it, and runs a terminal editor only when KAY_EDITOR names it', () => {
    const at = ['/p/src/routes/index.kay', 12, 3] as const
    const none = { PATH: '', DISPLAY: ':0' }

    expect(editorCommand(...at, { ...none, EDITOR: 'code --wait' })).toEqual(['code', '--wait', '-g', '/p/src/routes/index.kay:12:3'])
    expect(editorCommand(...at, { ...none, VISUAL: '/usr/bin/zed' })).toEqual(['/usr/bin/zed', '/p/src/routes/index.kay:12:3'])
    expect(editorCommand(...at, { ...none, EDITOR: 'webstorm.sh' })).toEqual(['webstorm.sh', '--line', '12', '--column', '3', '/p/src/routes/index.kay'])
    expect(editorCommand(...at, { ...none, EDITOR: 'nvim' })).toBeUndefined()
    expect(editorCommand(...at, { ...none, EDITOR: 'nvim', KAY_EDITOR: 'kitty nvim' })).toEqual(['kitty', 'nvim', '+12', '/p/src/routes/index.kay'])
    expect(editorCommand(...at, { ...none, KAY_EDITOR: 'tmux new-window hx' })).toEqual(['tmux', 'new-window', 'hx', '/p/src/routes/index.kay:12:3'])
    expect(editorCommand(...at, { ...none, KAY_EDITOR: 'my-editor --flag' })).toEqual(['my-editor', '--flag', '/p/src/routes/index.kay'])
    expect(editorCommand(...at, { ...none, EDITOR: 'nvim', KAY_EDITOR: 'cursor' })).toEqual(['cursor', '-g', '/p/src/routes/index.kay:12:3'])
    expect(editorCommand(...at, { ...none, VISUAL: 'code-server' })).toEqual(['code-server', '--reuse-window', '/p/src/routes/index.kay:12:3'])
  })

  it('opens only code-server on a Linux machine with no display, as one reached over SSH', () => {
    const at = ['/p/src/routes/index.kay', 12, 3] as const
    const bin = mkdtempSync(join(tmpdir(), 'kay-editors-'))

    try {
      for (const name of ['code', 'code-server']) {
        writeFileSync(join(bin, name), '#!/bin/sh\n')
        chmodSync(join(bin, name), 0o755)
      }

      expect(editorCommand(...at, { PATH: bin, VISUAL: 'code --wait' }, 'linux')).toEqual([join(bin, 'code-server'), '--reuse-window', '/p/src/routes/index.kay:12:3'])
      expect(editorCommand(...at, { PATH: bin, WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).toEqual([join(bin, 'code'), '-g', '/p/src/routes/index.kay:12:3'])
      expect(editorCommand(...at, { PATH: bin }, 'darwin')).toEqual([join(bin, 'code'), '-g', '/p/src/routes/index.kay:12:3'])
      expect(editorCommand(...at, { PATH: '', VISUAL: 'code' }, 'linux')).toBeUndefined()
    }
    finally {
      rmSync(bin, { recursive: true, force: true })
    }
  })
})
