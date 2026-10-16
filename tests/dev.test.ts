import type { Subprocess } from 'bun'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { PassThrough } from 'node:stream'
import { describe, expect, it, spyOn } from 'bun:test'
import { testWorker } from '../src/build/assets'
import { buildClient } from '../src/build/client'
import { KayCompileError } from '../src/build/transform'
import { readShadowSettings } from '../src/check/shadow'
import { loadConfig } from '../src/config'
import { ConfigRefused, dev, networkAddress, watchProject } from '../src/dev'
import { startClientBuilder } from '../src/dev/client'
import { InspectorAddressInUse, inspectorProxy } from '../src/dev/inspector'
import { TypesProcess } from '../src/dev/types-process'
import { bootFailure, hotSwap } from '../src/server/dev'
import { editorCommand } from '../src/server/editor'

// The parent's pid in /proc/<pid>/stat, after the command name and the state.
const PARENT_PID = /\) \S+ (\d+)/

// This process's children running `script` for the project at `real`, its real path: `builder.ts` building its client, `preload.ts` its servers.
function childrenRunning(real: string, script: string): string[] {
  return readdirSync('/proc').filter((pid) => {
    try {
      return PARENT_PID.exec(readFileSync(`/proc/${pid}/stat`, 'utf8'))?.[1] === String(process.pid) && readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(script) && readlinkSync(`/proc/${pid}/cwd`) === real
    }
    catch {
      return false
    }
  })
}

// Written by a server, which creates the file before it writes it: read as soon as it exists, it may still be empty.
function filled(path: string): boolean {
  return (statSync(path, { throwIfNoEntry: false })?.size ?? 0) > 0
}

// Whether this host has the loopback address: one without IPv6 has no ::1.
function binds(hostname: string): boolean {
  try {
    Bun.listen({ hostname, port: 0, socket: { data: () => undefined } }).stop(true)

    return true
  }
  catch {
    return false
  }
}

async function until(condition: () => boolean, timeout = 5000) {
  for (const start = Date.now(); !condition(); await Bun.sleep(20)) {
    if (Date.now() - start > timeout)
      throw new Error('timed out')
  }
}

// What a stream sent up to the first event named `name`, however its chunks split it.
async function eventsUntil(reader: ReadableStreamDefaultReader<Uint8Array>, name: string): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''

  while (!text.includes(`event: ${name}\ndata: `) || !text.endsWith('\n\n'))
    text += decoder.decode((await reader.read()).value)

  return text
}

async function firstEvent(response: Response): Promise<string> {
  const reader = response.body!.getReader()
  const { value } = await reader.read()

  await reader.cancel()

  return typeof value === 'string' ? value : new TextDecoder().decode(value)
}

describe.concurrent('the dev watcher', () => {
  async function watched(files: Record<string, string>, options: { rootNaming?: boolean } = {}) {
    const root = await mkdtemp(join(tmpdir(), 'kay-watch-'))
    const changes: string[] = []

    await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))
    const stop = watchProject(root, file => changes.push(file), options)
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

  it('hands the files editors write beside a source to onScratch, at the root as below it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-watch-'))
    const changes: string[] = []
    const scratch = ['.env.swp', '.env~', '.env___jb_old___', 'src/.server.ts.swp', 'src/server.ts~', 'src/4913', 'src/server.ts___jb_tmp___', 'src/.#server.ts']
    let scratchWritten = 0

    await Bun.write(join(root, '.env'), '')
    await Bun.write(join(root, 'src/server.ts'), '')
    const stop = watchProject(root, file => changes.push(file), { onScratch: () => scratchWritten++ })

    try {
      for (const file of scratch)
        await Bun.write(join(root, file), '')

      await until(() => scratchWritten >= scratch.length)
      await Bun.write(join(root, 'src/server.ts'), 'edited')
      await until(() => changes.includes('src/server.ts'))
      expect(changes.filter(file => file !== 'src/server.ts')).toEqual([])
    }
    finally {
      stop()
      await rm(root, { recursive: true, force: true })
    }
  })

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

  it('reports a root Markdown file once asked for the root files a stylesheet\'s pruning reads, and still not a licence', async () => {
    const { root, sees, cleanup } = await watched({ 'src/server.ts': '', 'README.md': '', 'LICENSE': '' }, { rootNaming: true })

    try {
      expect(await sees('README.md', async attempt => Bun.write(join(root, 'README.md'), String(attempt)))).toBe(true)
      expect(await sees('LICENSE', async attempt => Bun.write(join(root, 'LICENSE'), String(attempt)), 300)).toBe(false)
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
    const seen = join(root, '.seen')

    await Bun.write(join(root, '.env'), 'KAY_GREETING=hello\nKAY_FROM_SHELL=file\n')
    await Bun.write(join(root, 'src/server.ts'), `await Bun.write(${JSON.stringify(seen)}, \`\${process.env.KAY_GREETING}|\${process.env.KAY_FROM_SHELL}\`)\nsetInterval(() => undefined, 1000)\n`)
    // The command runs in the project, so Bun loads its .env into the process that restarts the server.
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'dev'], { cwd: root, env: { ...process.env, KAY_FROM_SHELL: 'shell' }, stdout: 'ignore', stderr: 'ignore' })

    try {
      await until(() => filled(seen), 10_000)
      expect(await Bun.file(seen).text()).toBe('hello|shell')

      await rm(seen)
      await Bun.write(join(root, '.env'), 'KAY_GREETING=changed\nKAY_FROM_SHELL=file\n')
      await until(() => filled(seen), 10_000)
      expect(await Bun.file(seen).text()).toBe('changed|shell')
    }
    finally {
      child.kill('SIGINT')
      await child.exited
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})

describe.concurrent('kay dev', () => {
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
      await until(() => children.length === 2, 15_000)

      expect(children[0]!.killed).toBe(true)
      // The new server starts first; the types follow it.
      await until(() => existsSync(join(root, '.kay/types/src/routes/about.kay.tsx')), 15_000)
    }
    finally {
      await stop()
      await rm(root, { recursive: true, force: true })
    }
    expect(children.at(-1)!.killed).toBe(true)
  }, 40_000)

  it('writes no types for an edit of a markdown entry or a media file, but for a public file or a source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-dev-'))
    const children: Subprocess[] = []
    const settings = join(root, '.kay/types/kay-shadow.json')

    await Bun.write(join(root, 'src/server.ts'), 'setInterval(() => undefined, 1000)\n')
    await Bun.write(join(root, 'src/routes/index.kay'), 'p Home\n')
    await Bun.write(join(root, 'kay.config.ts'), 'export default { publicDir: \'static\' }\n')
    await Bun.write(join(root, 'src/posts/one.md'), 'one\n')
    await Bun.write(join(root, 'src/logo.png'), 'a')
    const stop = await dev(root, { onRestart: child => children.push(child) })

    // The restart the edit made, and a moment more for a types process it would have started.
    const restarted = async (edit: () => Promise<unknown>) => {
      const count = children.length

      await edit()
      await until(() => children.length === count + 1, 20_000)
      await Bun.sleep(1500)
    }

    try {
      await until(() => existsSync(settings), 20_000)
      expect(readShadowSettings(root).publicDir).toBe(join(root, 'static'))

      for (const edit of [async () => Bun.write(join(root, 'src/posts/one.md'), 'two\n'), async () => Bun.write(join(root, 'src/logo.png'), 'b')]) {
        await rm(settings, { force: true })
        await restarted(edit)
        expect(existsSync(settings)).toBe(false)
      }

      for (const edit of [async () => Bun.write(join(root, 'static/logo.png'), 'c'), async () => Bun.write(join(root, 'src/routes/about.kay'), 'p About\n')]) {
        await rm(settings, { force: true })
        await restarted(edit)
        await until(() => existsSync(settings), 20_000)
      }
    }
    finally {
      await stop()
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('writes types through one process across edits of sources, whatever the config prints, and boots another once something else changes or the process went', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-dev-'))
    const loads = join(root, 'loads')
    const shadow = join(root, '.kay/types/src/routes/index.kay.tsx')
    const config = (dir: string) => `import { appendFileSync } from 'node:fs'\n\nappendFileSync(${JSON.stringify(loads)}, 'x')\nprocess.stdout.write('printed by the config')\n\nexport default { publicDir: '${dir}' }\n`

    await Bun.write(join(root, 'src/routes/index.kay'), 'p Home\n')
    await Bun.write(join(root, 'kay.config.ts'), config('one'))
    const types = new TypesProcess(root, undefined)
    const count = () => existsSync(loads) ? readFileSync(loads, 'utf8').length : 0

    try {
      expect(await types.write(false, '')).toBe(0)
      expect(readShadowSettings(root).publicDir).toBe(join(root, 'one'))

      for (const text of ['p Second\n', 'p Third\n']) {
        await Bun.write(join(root, 'src/routes/index.kay'), text)
        expect(await types.write(false, '')).toBe(0)
        expect(readFileSync(shadow, 'utf8')).toContain(text.slice(2, -1))
      }

      expect(count()).toBe(1)
      await Bun.write(join(root, 'kay.config.ts'), config('two'))
      expect(await types.write(false, '')).toBe(0)
      expect(readShadowSettings(root).publicDir).toBe(join(root, 'one'))
      expect(await types.write(true, '')).toBe(0)
      expect(readShadowSettings(root).publicDir).toBe(join(root, 'two'))
      expect(count()).toBe(2)
    }
    finally {
      types.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it.serial('boots a new types process when r is pressed, as the config or a module it imports may have changed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-dev-'))
    const keys = new PassThrough()
    const tty = process.stdout.isTTY
    const noColor = process.env.NO_COLOR
    const lines: string[] = []
    const printed = spyOn(console, 'log').mockImplementation((line: string) => void lines.push(line))
    const written = spyOn(process.stdout, 'write').mockImplementation(() => true)
    let stop: (() => Promise<void>) | undefined
    const helper = `${root}-helper.ts`

    const free = Bun.serve({ port: 0, fetch: () => new Response() })
    const port = free.port!

    await free.stop()
    await Bun.write(join(root, 'src/server.ts'), `Bun.serve({ port: ${port}, fetch: () => new Response() })\n`)
    await Bun.write(join(root, 'src/routes/index.kay'), 'p Home\n')
    await Bun.write(helper, 'export const dir = \'one\'\n')
    await Bun.write(join(root, 'kay.config.ts'), `import { dir } from ${JSON.stringify(helper)}\n\nexport default { publicDir: dir }\n`)
    process.stdout.isTTY = true
    process.env.NO_COLOR = '1'

    try {
      stop = await dev(root, { keys })
      await until(() => existsSync(join(root, '.kay/types/kay-shadow.json')), 20_000)
      expect(readShadowSettings(root).publicDir).toBe(join(root, 'one'))
      await Bun.write(helper, 'export const dir = \'second\'\n')
      await until(() => lines.some(line => line.includes('press o')), 20_000)
      keys.write('r')
      await until(() => readShadowSettings(root).publicDir === join(root, 'second'), 20_000)
    }
    finally {
      await stop?.()
      await rm(helper, { force: true })
      process.stdout.isTTY = tty
      printed.mockRestore()
      written.mockRestore()

      if (noColor === undefined)
        delete process.env.NO_COLOR
      else
        process.env.NO_COLOR = noColor

      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('stops without waiting on a types process stuck importing the config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-dev-'))
    const children: Subprocess[] = []

    await Bun.write(join(root, 'src/server.ts'), 'setInterval(() => undefined, 1000)\n')
    await Bun.write(join(root, 'kay.config.ts'), 'export default {}\n')
    const stop = await dev(root, { onRestart: child => children.push(child) })

    try {
      // The restart this change makes writes the types again, from a config that never loads.
      await Bun.write(join(root, 'kay.config.ts'), 'await new Promise(() => undefined)\n')
      await until(() => children.length === 2, 20_000)
      await Bun.sleep(500)

      const started = performance.now()
      const stopping = stop()

      // The servers are killed at once, not after the types process is.
      await until(() => children.every(child => child.killed), 1000)
      await stopping
      expect(performance.now() - started).toBeLessThan(10_000)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 40_000)

  it('writes the types from kay.config.ts as it is once it changed, without a restart of kay dev', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-dev-'))
    const config = join(root, 'kay.config.ts')

    await Bun.write(join(root, 'src/server.ts'), 'setInterval(() => undefined, 1000)\n')
    await Bun.write(join(root, 'src/routes/index.kay'), 'p Home\n')
    await Bun.write(config, 'export default { lints: { \'unread-name\': \'allow\' } }\n')
    const stop = await dev(root, { config: await loadConfig(root) })

    try {
      expect(readShadowSettings(root).lints).toEqual({ 'unread-name': 'allow' })

      await Bun.write(config, 'export default { lints: { \'unread-name\': \'deny\' } }\n')
      await until(() => readShadowSettings(root).lints?.['unread-name'] === 'deny')
    }
    finally {
      await stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('writes the types from the config as a module it imports left it, not only when kay.config.ts itself changed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-dev-'))
    const lints = join(root, 'lints.ts')

    await Bun.write(join(root, 'src/server.ts'), 'setInterval(() => undefined, 1000)\n')
    await Bun.write(join(root, 'src/routes/index.kay'), 'p Home\n')
    await Bun.write(join(root, 'kay.config.ts'), 'import { lints } from \'./lints\'\n\nexport default { lints }\n')
    await Bun.write(lints, 'export const lints = { \'unread-name\': \'allow\' } as const\n')
    const stop = await dev(root)

    try {
      await until(() => readShadowSettings(root).lints?.['unread-name'] === 'allow')
      await Bun.write(lints, 'export const lints = { \'unread-name\': \'deny\' } as const\n')
      await until(() => readShadowSettings(root).lints?.['unread-name'] === 'deny')
    }
    finally {
      await stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses to start on a kay.config.ts that does not load when asked, and loads none itself otherwise', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-dev-'))
    const children: Subprocess[] = []
    const said = spyOn(console, 'error').mockImplementation(() => undefined)

    await Bun.write(join(root, 'src/server.ts'), 'setInterval(() => undefined, 1000)\n')
    await Bun.write(join(root, 'src/routes/index.kay'), 'p Home\n')
    await Bun.write(join(root, 'kay.config.ts'), 'throw new Error(\'config broke\')\n')

    try {
      await expect(dev(root, { refuseConfig: true, onRestart: child => children.push(child) })).rejects.toBeInstanceOf(ConfigRefused)
      // No server started to print the same error again.
      expect(children).toHaveLength(0)

      await Bun.write(join(root, 'kay.config.ts'), 'export default {}\n')

      const stop = await dev(root, { refuseConfig: true })

      // The config is read by the processes writing the types and serving, not by this one.
      expect(Object.keys(require.cache).some(path => path.startsWith(join(root, 'kay.config')))).toBe(false)
      await stop()
    }
    finally {
      said.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  }, 40_000)

  it('starts the client builder at once only when an earlier run left a client build', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-dev-'))
    const said = spyOn(console, 'error').mockImplementation(() => undefined)

    await Bun.write(join(root, 'src/server.ts'), 'setInterval(() => undefined, 1000)\n')
    await Bun.write(join(root, 'src/routes/index.kay'), 'p Home\n')
    await Bun.write(join(root, 'kay.config.ts'), 'export default {}\n')

    const real = realpathSync(root)

    try {
      // No build before: the server never asks for the client, so no builder starts.
      const first = await dev(root)

      await Bun.sleep(1500)
      expect(childrenRunning(real, 'builder.ts')).toHaveLength(0)
      await first()

      await Bun.write(join(root, '.kay/dev/manifest.json'), '{}')

      const second = await dev(root)

      await until(() => childrenRunning(real, 'builder.ts').length === 1, 5000)
      await second()

      // A config that does not load is refused before any builder starts, so its error shows once.
      await Bun.write(join(root, 'kay.config.ts'), 'throw new Error(\'config broke\')\n')
      await expect(dev(root, { refuseConfig: true })).rejects.toBeInstanceOf(ConfigRefused)
      expect(childrenRunning(real, 'builder.ts')).toHaveLength(0)
    }
    finally {
      said.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('writes the types with the defaults while kay.config.ts does not load', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-dev-'))

    await Bun.write(join(root, 'src/server.ts'), 'setInterval(() => undefined, 1000)\n')
    await Bun.write(join(root, 'src/routes/index.kay'), 'p Home\n')
    await Bun.write(join(root, 'kay.config.ts'), 'export default {\n')
    const stop = await dev(root)

    try {
      expect(await Bun.file(join(root, '.kay/types/src/routes/index.kay.tsx')).exists()).toBe(true)
    }
    finally {
      await stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('loads the .kay modules and globs the entry imports before it calls pages()', async () => {
    const base = join(import.meta.dir, '../node_modules/.cache')

    await mkdir(base, { recursive: true })
    const root = await mkdtemp(join(base, 'kay-dev-'))
    const seen = join(root, '.seen')

    await Bun.write(join(root, 'src/mails/welcome.kay'), 'p Welcome\n')
    await Bun.write(join(root, 'src/mailer.ts'), 'import Welcome from \'./mails/welcome.kay\'\n\nexport const mails = { Welcome, ...import.meta.glob(\'./mails/*.kay\', { eager: true, import: \'default\' }) }\n')
    await Bun.write(join(root, 'src/server.ts'), `import { mails } from './mailer'\n\nawait Bun.write(${JSON.stringify(seen)}, Object.entries(mails).map(([name, mail]) => \`\${name}: \${typeof mail}\`).join(', '))\nsetInterval(() => undefined, 1000)\n`)
    const stop = await dev(root)

    try {
      await until(() => filled(seen), 15_000)
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

  it.serial('runs from the command line on the project a directory names, or with the entry --entry names, on the port --port names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-dev-'))
    const seen = join(root, '.seen')
    const cli = join(import.meta.dir, '../src/cli.ts')
    const report = (name: string) => `await Bun.write(${JSON.stringify(seen)}, \`${name}|\${process.cwd()}|\${process.env.PORT}\`)\nsetInterval(() => undefined, 1000)\n`
    const port = process.env.PORT

    await Bun.write(join(root, 'src/server.ts'), report('server'))
    await Bun.write(join(root, 'src/other.ts'), report('other'))

    try {
      // An entry file in place of the directory, as `kay dev` took before, runs in the current directory.
      for (const [args, expected, cwd] of [[[root], `server|${root}|${port}`, undefined], [[root, '--entry', join(root, 'src/other.ts')], `other|${root}|${port}`, undefined], [['src/other.ts'], `other|${root}|${port}`, root], [[root, '--port', '4123'], `server|${root}|4123`, undefined]] as const) {
        const child = Bun.spawn(['bun', cli, 'dev', ...args], { cwd: cwd ?? process.cwd(), stdout: 'ignore', stderr: 'pipe' })

        await until(() => filled(seen) && readFileSync(seen, 'utf8') === expected, 10_000)
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

      const exposed = Bun.spawn(['bun', cli, 'dev', root, '--inspect=0.0.0.0:0'], { stdout: 'ignore', stderr: 'pipe' })

      expect(await exposed.exited).toBe(1)
      expect(await new Response(exposed.stderr).text()).toContain('--inspect=0.0.0.0:0 opens the debugger past this machine')

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
    const seen = join(root, '.seen')
    const children: Subprocess[] = []

    await Bun.write(join(root, '.env'), 'KAY_GREETING=hello\n')
    await Bun.write(join(root, 'src/server.ts'), `await Bun.write(${JSON.stringify(seen)}, \`\${process.env.KAY_GREETING}|\${import.meta.main}\`)\nsetInterval(() => undefined, 1000)\n`)
    const stop = await dev(root, { onRestart: child => children.push(child) })

    try {
      await until(() => filled(seen))
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

  it.serial('restarts once per save, however the editor writes the file, on a machine slow enough to stretch the save', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-dev-'))
    const server = join(root, 'src/server.ts')
    const children: Subprocess[] = []
    const body = (n: number) => `// ${n}\nsetInterval(() => undefined, 1000)\n`

    await Bun.write(server, body(0))
    // What kay dev printed, so a failure names the file each extra restart was for.
    const printed: string[] = []
    const stop = await dev(root, { onRestart: child => children.push(child), log: line => printed.push(line) })
    const saves = [
      async () => Bun.write(server, body(1)),
      // A temporary file renamed over the source.
      async () => {
        await Bun.write(`${server}.tmp`, body(2))
        await Bun.sleep(30)
        await rename(`${server}.tmp`, server)
      },
      // The source moved to a backup, written anew and the backup deleted, as Vim saves.
      async () => {
        await rename(server, `${server}~`)
        await Bun.sleep(30)
        await Bun.write(server, body(3))
        await Bun.sleep(30)
        await rm(`${server}~`)
      },
      // A JetBrains IDE's safe write: a temporary copy, the source renamed away, the copy renamed over it.
      async () => {
        await Bun.write(`${server}___jb_tmp___`, body(4))
        await rename(server, `${server}___jb_old___`)
        await Bun.sleep(30)
        await rename(`${server}___jb_tmp___`, server)
        await rm(`${server}___jb_old___`)
      },
    ]

    try {
      await until(() => children.length === 1)

      for (const [index, save] of saves.entries()) {
        await Bun.sleep(200)
        await save()
        await until(() => children.length === index + 2)
      }

      await Bun.sleep(300)
      expect({ restarts: children.length, printed }).toEqual({ restarts: saves.length + 1, printed })
    }
    finally {
      await stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.serial('waits for a source an editor moved to its backup, and a deleted one beside a stale backup, for a moment only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-dev-'))
    const server = join(root, 'src/server.ts')
    const restarts: number[] = []
    const body = 'setInterval(() => undefined, 1000)\n'

    await Bun.write(server, body)
    const stop = await dev(root, { onRestart: () => restarts.push(performance.now()) })

    try {
      await until(() => restarts.length === 1)
      await Bun.sleep(300)

      // Moved away and never written back: waited for, then restarted once.
      const moved = performance.now()

      await rename(server, `${server}~`)
      await until(() => restarts.length === 2)
      expect(restarts[1]! - moved).toBeGreaterThanOrEqual(150)
      await Bun.sleep(300)
      expect(restarts).toHaveLength(2)

      await Bun.write(server, body)
      await until(() => restarts.length === 3)
      // Past the wait, so only the backup still beside it holds the next one.
      await Bun.sleep(400)
      expect(restarts).toHaveLength(3)

      const deleted = performance.now()

      await rm(server)
      await until(() => restarts.length === 4)
      expect(restarts[3]! - deleted).toBeGreaterThanOrEqual(150)
    }
    finally {
      await stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('serves the pages itself while the project has no server entry, and runs one written meanwhile at the next restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-dev-'))
    // Hidden, so the server writing it restarts nothing.
    const seen = join(root, '.seen')
    const children: Subprocess[] = []

    await Bun.write(join(root, '.env'), 'PORT=0\n')
    await Bun.write(join(root, 'src/routes/index.kay'), 'p Home\n')
    const stop = await dev(root, { onRestart: child => children.push(child) })

    try {
      await Bun.sleep(500)
      expect(children[0]!.exitCode).toBeNull()

      await Bun.write(join(root, 'src/server.ts'), `await Bun.write(${JSON.stringify(seen)}, 'server')\nsetInterval(() => undefined, 1000)\n`)
      await until(() => filled(seen), 10_000)
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
      await until(() => children.length > count && filled(seen))
      // A save can come as several events, each restarting once their debounce settles.
      await Bun.sleep(200)
      await until(() => filled(seen))

      return Bun.file(seen).text()
    }

    try {
      await until(() => filled(seen))
      const first = await Bun.file(seen).text()

      expect(await restartAfter('src/app.css', 'p { color: blue }\n')).toBe(first)
      const edited = Number(await restartAfter('src/routes/index.kay', 'p Home\n'))

      expect(edited).toBeGreaterThan(Number(first))

      // A page left open across two runs takes the next run's count for new code.
      await stop()
      await rm(seen, { force: true })
      stop = await dev(root, { onRestart: child => children.push(child) })
      await until(() => filled(seen))
      expect(Number(await Bun.file(seen).text())).toBeGreaterThan(edited)
    }
    finally {
      await stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.serial('reports the address once, then each restart with what changed, and a server exiting on its own', async () => {
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

  it.serial('says no restart when quiet, the address and a server exiting on its own still said', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-dev-'))
    const lines: string[] = []
    const free = Bun.serve({ port: 0, fetch: () => new Response() })
    const port = free.port!
    const answer = async () => {
      try {
        return await (await fetch(`http://localhost:${port}`)).text()
      }
      catch {
        return ''
      }
    }

    await free.stop()
    await Bun.write(join(root, 'src/version.ts'), 'export default \'a\'\n')
    await Bun.write(join(root, 'src/server.ts'), `import version from './version'\n\nif (await Bun.file('src/exit.ts').exists()) process.exit(3)\nBun.serve({ port: ${port}, fetch: () => new Response(version) })\n`)
    const stop = await dev(root, { log: line => lines.push(line), quiet: true })

    try {
      await until(() => lines.length === 1)
      expect(lines[0]).toMatch(new RegExp(`^kay dev: http://localhost:${port} \\(ready in \\d+ ms\\)$`))

      // The restarted server answers with the new version, the restart said nowhere.
      await Bun.write(join(root, 'src/version.ts'), 'export default \'b\'\n')
      for (let tries = 0; await answer() !== 'b'; tries++) {
        expect(tries).toBeLessThan(100)
        await Bun.sleep(50)
      }
      expect(lines).toHaveLength(1)

      await Bun.write(join(root, 'src/exit.ts'), '')
      await until(() => lines.length === 2)
      expect(lines[1]).toMatch(/^\d\d:\d\d:\d\d the server exited with code 3, waiting for a change$/)
    }
    finally {
      await stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.serial('moves off a busy port, saying which was in use, and stays on the port it moved to after a restart', async () => {
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

  it('names the network address of the first interface no container, bridge or VPN made, on Linux and macOS alike', () => {
    const entry = (address: string, internal = false) => ({ address, netmask: '255.255.255.0', family: 'IPv4' as const, mac: '00:00:00:00:00:00', internal, cidr: `${address}/24` })

    for (const name of ['docker0', 'br-1a2b', 'veth9', 'virbr0', 'tun0', 'wg0', 'tailscale0', 'utun3', 'bridge100'])
      expect(networkAddress({ lo0: [entry('127.0.0.1', true)], [name]: [entry('10.0.0.2')], en0: [entry('192.168.1.20')] })).toBe('192.168.1.20')

    expect(networkAddress({ lo: [entry('127.0.0.1', true)], utun3: [entry('10.0.0.2')] })).toBe('10.0.0.2')
    expect(networkAddress({ lo: [entry('127.0.0.1', true)] })).toBeUndefined()
  })

  it.serial('listens on localhost alone unless --host opens it, keeping a hostname the app names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-dev-'))
    const lines: string[] = []

    // The first server, the one kay dev reports, answers with its own hostname and the second's, which names one.
    await Bun.write(join(root, 'src/server.ts'), 'const server = Bun.serve({ port: 0, fetch: () => new Response(`${server.hostname} ${named.hostname}`) })\nconst named = Bun.serve({ port: 0, hostname: \'127.0.0.1\', fetch: () => new Response() })\n')

    try {
      for (const [host, expected] of [[undefined, 'localhost 127.0.0.1'], ['0.0.0.0', '0.0.0.0 127.0.0.1']] as const) {
        lines.length = 0
        const stop = await dev(root, { host, log: line => lines.push(line) })

        try {
          await until(() => lines.length > 0)
          const [, port] = (/^kay dev: http:\/\/localhost:(\d+) \(ready in \d+ ms\)$/).exec(lines[0]!) ?? []

          expect(await (await fetch(`http://localhost:${port}`)).text()).toBe(expected)

          // Opened to the network, the address a phone on it reaches, when this machine has one.
          const network = networkAddress()

          if (host !== undefined && network !== undefined) {
            await until(() => lines.length === 2)
            expect(lines[1]).toBe(`kay dev: http://${network}:${port} on the network`)
          }

          await Bun.sleep(100)
          expect(lines).toHaveLength(host !== undefined && network !== undefined ? 2 : 1)
        }
        finally {
          await stop()
        }
      }
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.serial.each(['127.0.0.1', '::1'].filter(binds))('moves off a port %s alone holds, where Bun would take the other loopback address', async (hostname) => {
    const root = await mkdtemp(join(tmpdir(), 'kay-dev-'))
    const lines: string[] = []
    const holder = Bun.listen({ hostname, port: 0, socket: { data: () => undefined } })
    const busy = holder.port

    await Bun.write(join(root, 'src/server.ts'), `Bun.serve({ port: ${busy}, fetch: () => new Response('ok') })\n`)
    const stop = await dev(root, { log: line => lines.push(line) })

    try {
      await until(() => lines.length === 1)
      expect(lines[0]).toMatch(new RegExp(`^kay dev: http://localhost:\\d+ \\(ready in \\d+ ms, ${busy} was in use\\)$`))
    }
    finally {
      holder.stop(true)
      await stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.serial('opens the address in the BROWSER command once, not on a restart', async () => {
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

  it.serial('collapses identical rebuild lines into one with a count on a terminal, and leaves every line elsewhere', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-dev-'))
    const lines: string[] = []
    const keys = new PassThrough()
    const printed = spyOn(console, 'log').mockImplementation((line: string) => void lines.push(line))
    const written = spyOn(process.stdout, 'write').mockImplementation(() => true)
    const tty = process.stdout.isTTY
    const noColor = process.env.NO_COLOR
    let stop: (() => Promise<void>) | undefined

    const free = Bun.serve({ port: 0, fetch: () => new Response() })
    const port = free.port!

    await free.stop()
    await Bun.write(join(root, 'src/server.ts'), `Bun.serve({ port: ${port}, fetch: () => new Response() })\n`)
    process.stdout.isTTY = true
    process.env.NO_COLOR = '1'

    try {
      stop = await dev(root, { keys })
      await until(() => lines.length === 2)

      keys.write('r')
      await until(() => lines.length === 3)
      expect(lines[2]).toMatch(/^\d\d:\d\d:\d\d r pressed: restarted in \d+ ms$/)

      keys.write('r')
      await until(() => lines.length === 4)
      expect(lines[3]).toMatch(/^\d\d:\d\d:\d\d r pressed: restarted in \d+ ms \(x2\)$/)
      // The first line is rewritten: the cursor goes up one row and the rest clears.
      expect(written).toHaveBeenCalledWith('\x1B[1A\x1B[J')

      keys.write('r')
      await until(() => lines.length === 5)
      expect(lines[4]).toEndWith('(x3)')

      // Another line between ends the run.
      keys.write('c')
      keys.write('r')
      await until(() => lines.length === 6)
      expect(lines[5]).not.toContain('(x')
    }
    finally {
      await stop?.()
      process.stdout.isTTY = tty
      printed.mockRestore()
      written.mockRestore()

      if (noColor === undefined)
        delete process.env.NO_COLOR
      else
        process.env.NO_COLOR = noColor
    }

    const plain: string[] = []
    const piped = new PassThrough()

    process.stdout.isTTY = false
    const quiet = await dev(root, { keys: piped, log: line => plain.push(line) })

    try {
      await until(() => plain.length === 2)
      piped.write('r')
      await until(() => plain.length === 3)
      piped.write('r')
      await until(() => plain.length === 4)
      expect(plain.join('\n')).not.toContain('(x')
    }
    finally {
      await quiet()
      process.stdout.isTTY = tty
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it.serial('keeps a rebuild line the app printed after, so it never rewrites the app\'s output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-dev-'))
    const lines: string[] = []
    const keys = new PassThrough()
    const printed = spyOn(console, 'log').mockImplementation((line: string) => void lines.push(line))
    const written = spyOn(process.stdout, 'write').mockImplementation(() => true)
    const tty = process.stdout.isTTY
    const free = Bun.serve({ port: 0, fetch: () => new Response() })
    const port = free.port!
    let stop: (() => Promise<void>) | undefined

    await free.stop()
    await Bun.write(join(root, 'src/server.ts'), `Bun.serve({ port: ${port}, fetch: () => new Response() })\nsetTimeout(() => process.stderr.write('app output\\n'), 300)\n`)
    process.stdout.isTTY = true

    try {
      stop = await dev(root, { keys })
      await until(() => lines.length === 2)
      keys.write('r')
      await until(() => lines.length === 3)
      // Past the app's own line.
      await Bun.sleep(1000)
      keys.write('r')
      await until(() => lines.length === 4)
      expect(lines[3]).not.toContain('(x')
      expect(written).not.toHaveBeenCalledWith(expect.stringContaining('\x1B[1A'))
    }
    finally {
      await stop?.()
      process.stdout.isTTY = tty
      printed.mockRestore()
      written.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it.serial('takes keys from the terminal it is given: o opens the address, r restarts, q quits, listed once under the ready line', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-dev-'))
    const lines: string[] = []
    const opened = join(root, '..', `${root.split('/').at(-1)}-opened.txt`)
    const browser = `${opened}.sh`
    const previous = process.env.BROWSER
    const keys = new PassThrough()
    let quit = 0
    const free = Bun.serve({ port: 0, fetch: () => new Response() })
    const port = free.port!

    await free.stop()
    await Bun.write(browser, `#!/bin/sh\necho "$1" >> ${JSON.stringify(opened)}\n`)
    chmodSync(browser, 0o755)
    await Bun.write(join(root, 'src/server.ts'), `Bun.serve({ port: ${port}, fetch: () => new Response() })\n`)
    process.env.BROWSER = browser
    const stop = await dev(root, { keys, onQuit: () => quit++, log: line => lines.push(line) })

    try {
      await until(() => lines.length === 2)
      const [, address] = (/^kay dev: (\S+) /).exec(lines[0]!) ?? []

      expect(lines[1]).toBe('kay dev: press o to open it in the browser, r to restart, c to clear the screen, q to quit')

      keys.write('o')
      await until(() => existsSync(opened))
      keys.write('r')
      await until(() => lines.length === 3)
      expect(lines[2]).toMatch(/^\d\d:\d\d:\d\d r pressed: restarted in \d+ ms$/)
      expect(readFileSync(opened, 'utf8')).toBe(`${address}\n`)

      // Alt+q, an escape sequence, presses no key.
      keys.write('\x1Bq')
      keys.write('q')
      // Ctrl+C, which a terminal in raw mode sends as a key rather than a signal.
      keys.write('\x03')
      await until(() => quit === 2)
      await Bun.sleep(50)
      expect(quit).toBe(2)

      // Pressed with only a stylesheet changed, which would only swap it in, it restarts all the same: r goes in once a watcher saw the change, before kay dev's debounce swaps the stylesheet alone.
      const stopWatching = watchProject(root, (file) => {
        if (file === 'src/app.css')
          setImmediate(() => keys.write('r'))
      })

      try {
        await Bun.write(join(root, 'src/app.css'), 'p { color: red }\n')
        await until(() => lines.length === 4)
      }
      finally {
        stopWatching()
      }
      expect(lines[3]).toMatch(/^\d\d:\d\d:\d\d (?:src\/app\.css|r pressed): restarted in \d+ ms$/)
    }
    finally {
      process.env.BROWSER = previous
      await stop()
      await rm(root, { recursive: true, force: true })
      await rm(opened, { force: true })
      await rm(browser, { force: true })
    }
  })

  it('reads no key and says nothing of them when the terminal is not a TTY', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-dev-'))

    await Bun.write(join(root, 'src/server.ts'), 'Bun.serve({ port: 0, fetch: () => new Response() })\n')
    const child = Bun.spawn(['bun', join(import.meta.dir, '../src/cli.ts'), 'dev', root], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' })
    let output = ''
    const reading = (async () => {
      for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream()))
        output += chunk
    })()

    try {
      await until(() => output.includes('ready in'), 20_000)
      void child.stdin.write('q')
      await child.stdin.flush()
      await Bun.sleep(300)
      expect(child.exitCode).toBeNull()
      expect(output).toMatch(/^kay dev: \S+ \(ready in \d+ ms\)\n$/)
    }
    finally {
      child.kill()
      await child.exited
      await reading
      await rm(root, { recursive: true, force: true })
    }
  })

  it.serial('opens the debugger --inspect names on every server it runs, at the address it prints once, which a client closing as it connects never ends', async () => {
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
  }, 60_000)

  it.serial('lets no page of another site reach the debugger, as Bun\'s inspector does', async () => {
    const proxy = inspectorProxy('ws://localhost:0/kay', () => undefined, () => 3000)
    const status = async (headers: Record<string, string>) => (await fetch(proxy.url.replace('ws:', 'http:'), { headers })).status

    try {
      // Not a WebSocket upgrade, the answer once both checks pass.
      expect(await status({})).toBe(426)
      expect(await status({ host: '127.0.0.1', origin: 'https://debug.bun.sh' })).toBe(426)
      expect(await status({ origin: 'http://localhost:3000' })).toBe(426)
      expect(await status({ origin: 'http://127.0.0.1:3000' })).toBe(426)
      // Another app on this machine is no more trusted than another site.
      expect(await status({ origin: 'http://localhost:5173' })).toBe(403)
      expect(await status({ host: 'evil.example' })).toBe(400)
      expect(await status({ origin: 'https://evil.example' })).toBe(403)
      expect(await status({ origin: 'http://localhost.evil.example' })).toBe(403)
    }
    finally {
      await proxy.stop()
    }
  })

  it.each(['127.0.0.1', '::1'].filter(binds))('takes localhost\'s port as in use when %s holds it, as Bun would bind the other address', (hostname) => {
    const held = Bun.listen({ hostname, port: 0, socket: { data: () => undefined } })

    try {
      expect(() => inspectorProxy(`ws://localhost:${held.port}/kay`, () => undefined)).toThrow(InspectorAddressInUse)
    }
    finally {
      held.stop(true)
    }
  })

  // Whatever the host: ::1 held, as only a dual-stack one shows, while 127.0.0.1 is free.
  it('takes localhost\'s port as in use when only ::1 holds it, on a host without IPv6 too', () => {
    const free = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => undefined } })
    const { port } = free

    free.stop(true)

    const listen = Bun.listen.bind(Bun)
    const probed = spyOn(Bun, 'listen').mockImplementation(((options: Parameters<typeof Bun.listen>[0]) => {
      if ('hostname' in options && options.hostname === '::1')
        throw Object.assign(new Error('in use'), { code: 'EADDRINUSE' })

      return listen(options)
    }) as typeof Bun.listen)

    try {
      expect(() => inspectorProxy(`ws://localhost:${port}/kay`, () => undefined)).toThrow(InspectorAddressInUse)
    }
    finally {
      probed.mockRestore()
    }
  })

  it('drops the line an entry prints once it listens, which kay dev prints itself', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-dev-'))
    const messages: unknown[] = []

    await Bun.write(join(root, 'server.ts'), 'const server = Bun.serve({ port: 0, fetch: () => new Response() })\nconsole.log(`Listening on http://localhost:${server.port}`)\nconsole.log(`Listening on http://localhost:${server.port + 1}`)\nconsole.log(\'Listening on\', server.port)\nawait server.stop()\n')
    const child = Bun.spawn([process.execPath, '--preload', join(import.meta.dir, '../src/dev/preload.ts'), join(root, 'server.ts')], { cwd: root, stdin: 'pipe', stdout: 'pipe', stderr: 'inherit', ipc: message => messages.push(message) })

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

  it('reports the app\'s output to kay dev only when told it collapses', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-dev-'))

    await Bun.write(join(root, 'server.ts'), 'const server = Bun.serve({ port: 0, fetch: () => new Response() })\nconsole.log(\'a\')\nprocess.stderr.write(\'b\\n\')\nawait server.stop()\n')

    const run = async (env: Record<string, string>) => {
      const messages: unknown[] = []
      const child = Bun.spawn([process.execPath, '--preload', join(import.meta.dir, '../src/dev/preload.ts'), join(root, 'server.ts')], { cwd: root, env: { ...process.env, ...env }, stdin: 'pipe', stdout: 'ignore', stderr: 'ignore', ipc: message => messages.push(message) })

      try {
        void child.stdin.write('start 0\n')
        void child.stdin.flush()
        await child.exited

        return messages.filter(message => typeof message === 'object' && message !== null && 'output' in message)
      }
      finally {
        child.kill()
      }
    }

    try {
      expect(await run({})).toHaveLength(0)
      expect((await run({ KAY_DEV_REPORTS_OUTPUT: '1' })).length).toBeGreaterThan(0)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('marks its pages for the inspector, serves it, opens the file it names in KAY_EDITOR, telling when that fails, and answers 421 to a host not its own', async () => {
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
      expect(page).toContain('<script type="module" src="/_kay/dev/tool.js"></script><script type="module" src="/_kay/dev/inspector.js"></script>')
      expect(await (await fetch(`${url}/_kay/dev/inspector.js`)).text()).toContain('if (window.$kayDev) startInspector(window.$kayDev)')
      expect(await (await fetch(`${url}/_kay/dev/tool.js`)).text()).toContain('window.$kayDev = startDevTool()')

      const open = async (source: string, headers: Record<string, string> = { 'x-kay-dev': '1' }) => fetch(`${url}/_kay/dev/open`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ source }) })

      expect((await open('src/routes/index.kay:2:3', {})).status).toBe(403)
      expect((await open('../outside.kay:1:1')).status).toBe(404)
      expect((await open('.env:1:1')).status).toBe(404)
      expect(await (await open('src/routes/index.kay:2:3')).json()).toEqual({ opened: true })
      await until(() => filled(seen))
      expect(JSON.parse(readFileSync(seen, 'utf8'))).toEqual([join(root, 'src/routes/index.kay')])
      // A script's position too, as an error page names, the recording editor failing this time.
      expect((await open('../outside.ts:1:1')).status).toBe(404)
      expect(await (await open('record.ts:2:1')).json()).toEqual({ opened: false, failed: true })
      // A page of another site that renamed itself to this machine's address sends its own name as the Host.
      expect((await fetch(url, { headers: { host: 'rebound.example' } })).status).toBe(421)
      expect((await fetch(url, { headers: { host: 'app.localhost' } })).status).toBe(200)
      expect((await fetch(url, { headers: { host: '127.0.0.1' } })).status).toBe(200)
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

      // The dev tool says what was swapped in, and how long it took.
      expect(await eventsUntil(events, 'built')).toMatch(/^event: styles\ndata: \d+\n\nevent: built\ndata: \{"id":"[\w-]+","at":\d+,"changed":"src\/app\.css","ms":\d+,"styles":true\}\n\n$/)
      expect(await stylesheet()).toContain('#00f')
      expect(children).toHaveLength(1)
      await events.cancel()

      const before = written()

      await Bun.write(join(root, 'src/name.ts'), 'export const name = \'Grace\'\n')
      await until(() => lines.length === 3, 10_000)

      expect(await (await fetch(url)).text()).toContain('Grace</h1>')
      expect(written()).toEqual(before)
      // As it does of a restart, to a page connecting after it.
      expect(await eventsUntil((await fetch(`${url}/_kay/dev/events`)).body!.getReader(), 'built')).toMatch(/\nevent: built\ndata: \{"id":"[\w-]+","at":\d+,"changed":"src\/name\.ts","ms":\d+\}\n\n$/)

      await Bun.write(join(root, 'src/routes/index.kay'), `${page}else\n  p no\n`)
      await until(() => lines.length === 4, 10_000)

      const failed = await fetch(url)

      expect(failed.status).toBe(500)
      expect(await failed.text()).toContain('src/routes/index.kay:10:1')

      await Bun.write(join(root, 'src/routes/index.kay'), page)
      await until(() => lines.length === 5, 10_000)

      expect(await (await fetch(url)).text()).toContain('Grace</h1>')
      // The edits to the helper and the page reloaded the one server.
      expect(children).toHaveLength(1)
    }
    finally {
      await stop()
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it.serial('keeps one process building the client when the config changes while an island edit builds', async () => {
    const scratch = join(import.meta.dir, '../node_modules/.cache')

    await mkdir(scratch, { recursive: true })
    const root = await mkdtemp(join(scratch, 'dev-builders-'))
    const real = realpathSync(root)
    const lines: string[] = []
    const counter = (step: number) => `---\nimport { signal } from 'kay'\n\nconst count = signal(${step})\n---\nbutton(onClick={() => count.set(n => n + 1)}) {count()}\n`
    const builders = () => childrenRunning(real, 'builder.ts')

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
        await Bun.sleep(150)
      }

      // Settled: no restart for a while.
      for (let seen = lines.length, quiet = Date.now(); Date.now() - quiet < 800; await Bun.sleep(100)) {
        if (lines.length !== seen) {
          seen = lines.length
          quiet = Date.now()
        }
      }

      // A builder let go of still exiting under load is not a second one: what is checked is that one is left.
      await until(() => builders().length === 1, 10_000)

      const [first] = builders()

      expect(lines.join('\n')).not.toContain('the process building the client exited')

      // One gone on its own starts again with the next build.
      process.kill(Number(first), 'SIGKILL')
      // A restart still finishing under load may start the next one at once, so the wait is for this one gone, not for none.
      // Reaped, not just out of the list: a dying process empties its cmdline before kay dev hears it exit, and an edit in between asks the dead one to build.
      await until(() => !existsSync(`/proc/${first}`), 20_000)
      await Bun.write(join(root, 'src/counter.kay'), counter(9))
      await until(() => builders().length === 1 && builders()[0] !== first, 10_000)
    }
    finally {
      await stop()
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it.serial('replaces a process that built before and died before answering, once, and not one failing as it starts', async () => {
    const scratch = join(import.meta.dir, '../node_modules/.cache')

    await mkdir(scratch, { recursive: true })
    const root = await mkdtemp(join(scratch, 'dev-builder-retry-'))
    const real = realpathSync(root)
    const starts = join(root, 'starts')

    await Bun.write(join(root, 'kay.config.ts'), 'export default {}\n')
    await Bun.write(join(root, 'src/routes/index.kay'), 'h1 Home\n')
    const builder = startClientBuilder(root, process.env)

    try {
      expect(await builder.build(null)).toBeDefined()

      const [first] = childrenRunning(real, 'builder.ts')

      // Killed as a change comes in, before the exit is heard.
      process.kill(Number(first), 'SIGKILL')
      const outcome = await builder.build(null)

      expect(outcome).toBeDefined()
      expect(outcome?.failed).toBe(false)
      expect(builder.gone()).toBe(false)
      expect(childrenRunning(real, 'builder.ts')).not.toContain(first!)
    }
    finally {
      await builder.stop()
    }

    // A config failing to load ends the process before it ever built: asked again by the next change, not at once.
    await Bun.write(join(root, 'kay.config.ts'), `import { appendFileSync } from 'node:fs'\n\nappendFileSync(${JSON.stringify(starts)}, 'x')\n\nthrow new Error('no config')\n`)
    const failing = startClientBuilder(root, process.env)

    try {
      expect(await failing.build(null)).toBeUndefined()
      expect(failing.gone()).toBe(true)
      expect(readFileSync(starts, 'utf8')).toBe('x')
    }
    finally {
      await failing.stop()
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it.serial('keeps one process building the client for builds riding one that died, and none once stopped meanwhile', async () => {
    const scratch = join(import.meta.dir, '../node_modules/.cache')

    await mkdir(scratch, { recursive: true })
    const root = await mkdtemp(join(scratch, 'dev-builder-respawn-'))
    const real = realpathSync(root)
    const running = () => childrenRunning(real, 'builder.ts').filter(pid => existsSync(`/proc/${pid}`) && !readFileSync(`/proc/${pid}/stat`, 'utf8').includes(') Z'))

    await Bun.write(join(root, 'kay.config.ts'), 'export default {}\n')
    await Bun.write(join(root, 'src/routes/index.kay'), 'h1 Home\n')
    const builder = startClientBuilder(root, process.env)

    try {
      expect(await builder.build(null)).toBeDefined()
      process.kill(Number(running()[0]), 'SIGKILL')

      const outcomes = await Promise.all([builder.build(null), builder.build(null)])

      expect(outcomes.every(outcome => outcome !== undefined)).toBe(true)
      expect(running()).toHaveLength(1)
      expect(builder.gone()).toBe(false)

      // Stopped while the next one replaces a dead one.
      process.kill(Number(running()[0]), 'SIGKILL')
      const build = builder.build(null)

      await builder.stop()
      await build
      await Bun.sleep(300)
      expect(running()).toEqual([])
      expect(builder.gone()).toBe(true)
    }
    finally {
      await builder.stop()
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it.serial('asks the process that replaced a dead one for a build that heard of the death after the swap', async () => {
    const scratch = join(import.meta.dir, '../node_modules/.cache')

    await mkdir(scratch, { recursive: true })
    const root = await mkdtemp(join(scratch, 'dev-builder-late-'))
    const real = realpathSync(root)

    await Bun.write(join(root, 'kay.config.ts'), 'export default {}\n')
    await Bun.write(join(root, 'src/routes/index.kay'), 'h1 Home\n')
    const builder = startClientBuilder(root, process.env)

    try {
      expect(await builder.build(null)).toBeDefined()

      // The second build starts a few microtasks after the first, so one of them lands after the first swapped the process in.
      for (let delay = 0; delay < 6; delay++) {
        process.kill(Number(childrenRunning(real, 'builder.ts')[0]), 'SIGKILL')
        await until(() => builder.gone())

        const first = builder.build(null)

        for (let tick = 0; tick < delay; tick++)
          await Promise.resolve()

        const outcomes = await Promise.all([first, builder.build(null)])

        expect(outcomes.map(outcome => outcome?.failed)).toEqual([false, false])
      }
    }
    finally {
      await builder.stop()
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('starts no process building the client once stopping, for a server asking for it as it stops', async () => {
    const scratch = join(import.meta.dir, '../node_modules/.cache')

    await mkdir(scratch, { recursive: true })
    const root = await mkdtemp(join(scratch, 'dev-stopping-'))
    const ran = join(root, 'ran')

    await Bun.write(join(root, 'kay.config.ts'), 'export default {}\n')
    await Bun.write(join(root, 'src/routes/index.kay'), 'h1 Home\n')
    // Asks as kay's server does once it boots, but only as it is told to stop.
    await Bun.write(join(root, 'src/server.ts'), `import process from 'node:process'\n\nprocess.on('SIGTERM', () => {\n  process.send!({ wantsClient: true })\n  setTimeout(() => process.exit(0), 100)\n})\nsetInterval(() => undefined, 1000)\nawait Bun.write(${JSON.stringify(ran)}, '')\n`)
    const stop = await dev(root, { log: () => undefined })

    try {
      await until(() => existsSync(ran), 20_000)
    }
    finally {
      await stop()
    }

    await Bun.sleep(500)
    expect(childrenRunning(realpathSync(root), 'builder.ts')).toEqual([])
    await rm(root, { recursive: true, force: true })
  }, 60_000)

  it.serial('says once that the process building the client exited, until a build succeeds again', async () => {
    const scratch = join(import.meta.dir, '../node_modules/.cache')

    await mkdir(scratch, { recursive: true })
    const root = await mkdtemp(join(scratch, 'dev-builder-exit-'))
    const lines: string[] = []
    const exits = () => lines.filter(line => line.endsWith('the process building the client exited; each change starts it again, the servers building their own until one build succeeds')).length
    const counter = (step: number) => `---\nimport { signal } from 'kay'\n\nconst count = signal(${step})\n---\nbutton(onClick={() => count.set(n => n + 1)}) {count()}\n`
    // No line for a while: the restarts and the builds a change started are over.
    const settled = async () => {
      for (let seen = lines.length, quiet = Date.now(); Date.now() - quiet < 800; await Bun.sleep(100)) {
        if (lines.length !== seen) {
          seen = lines.length
          quiet = Date.now()
        }
      }
    }

    await Bun.write(join(root, 'kay.config.ts'), 'export default {}\n')
    await Bun.write(join(root, 'src/counter.kay'), counter(0))
    await Bun.write(join(root, 'src/routes/index.kay'), '---\nimport Counter from \'../counter.kay\'\n---\nCounter\n')
    const stop = await dev(root, { log: line => lines.push(line) })

    try {
      await until(() => lines.length === 1, 20_000)

      // A config that does not load ends every process building the client mid-build.
      await Bun.write(join(root, 'kay.config.ts'), 'export default {\n')
      await until(() => exits() === 1, 20_000)
      await Bun.write(join(root, 'src/counter.kay'), counter(1))
      await settled()

      expect(exits()).toBe(1)

      await Bun.write(join(root, 'kay.config.ts'), 'export default {}\n')
      await until(() => lines.at(-1)!.includes('restarted'), 20_000)
      await settled()
      await Bun.write(join(root, 'kay.config.ts'), 'export default {\n')
      await until(() => exits() === 2, 20_000)
    }
    finally {
      await stop()
      await rm(root, { recursive: true, force: true })
    }
  }, 90_000)

  it('serves the compile errors of a project that failed to boot on every page, logging them only as it boots, and the reload stream', async () => {
    const source = 'p ok\nelse\n  p no\n'
    const error = new KayCompileError([{ file: join(process.cwd(), 'src/broken.kay'), source, start: 5, end: 9, message: '`else` must directly follow an `if`' }])
    const app = bootFailure(error, process.cwd())
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const page = await app.handle(new Request('http://localhost/any/page'))
    const html = await page.text()

    await app.handle(new Request('http://localhost/other'))
    logged.mockRestore()
    expect(logged).not.toHaveBeenCalled()
    expect(page.status).toBe(500)
    expect(html).toContain(' --&gt; src/broken.kay:2:1\n')
    expect(html).toContain('2 | else\n  | ^^^^')
    expect(html).toContain('new EventSource("/_kay/dev/events")')

    const events = await app.handle(new Request('http://localhost/_kay/dev/events'))

    expect(events.headers.get('content-type')).toBe('text/event-stream')
    // Its code is its own id, so pages on either side of it always reload.
    expect(await firstEvent(events)).toMatch(/^event: boot\ndata: ([\w-]+) \1\n\n$/)
  })

  it('answers under kay dev only to localhost, an IP address, the site and the names KAY_DEV_HOSTS lists', async () => {
    const saved = { KAY_DEV_CODE: process.env.KAY_DEV_CODE, KAY_DEV_HOST: process.env.KAY_DEV_HOST, KAY_DEV_HOSTS: process.env.KAY_DEV_HOSTS, SITE_URL: process.env.SITE_URL }

    Object.assign(process.env, { KAY_DEV_CODE: '0', KAY_DEV_HOST: 'localhost', KAY_DEV_HOSTS: 'tunnel.example, Dev.Example', SITE_URL: 'https://shop.example' })

    try {
      const app = bootFailure(new Error('down'), process.cwd())
      const status = async (host: string, served = app) => (await served.handle(new Request('http://localhost/', { headers: { host } }))).status

      for (const host of ['localhost.:3000', 'localhost:3000', 'app.localhost', '127.0.0.1:3000', '[::1]:3000', '192.168.1.20:3000', 'shop.example', 'tunnel.example', 'dev.example:8080'])
        expect(await status(host)).toBe(500)

      for (const host of ['rebound.example', 'localhost.rebound.example', 'shop.example.rebound.example', `${hostname()}.local`])
        expect(await status(host)).toBe(421)

      // Opened to the network, it answers to this machine's own names as well.
      process.env.KAY_DEV_HOST = '0.0.0.0'
      const opened = bootFailure(new Error('down'), process.cwd())

      expect(await status(`${hostname()}.local:3000`, opened)).toBe(500)
      expect(await status(hostname(), opened)).toBe(500)
    }
    finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined)
          delete process.env[name]
        else
          process.env[name] = value
      }
    }
  })
})

describe.concurrent('hot swap', () => {
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
      await until(() => filled(seen))
      const [first, none] = (await Bun.file(seen).text()).split(' ')

      expect(none).toBe('[]')

      await rm(seen)
      await Bun.write(join(root, 'src/island.kay'), 'p x\n')
      await until(() => filled(seen))

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
