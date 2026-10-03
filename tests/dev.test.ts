import type { Subprocess } from 'bun'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { KayCompileError } from '../src/build/transform'
import { dev, watchProject } from '../src/dev'
import { bootFailure } from '../src/server/dev'

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
  })
})

describe('kay dev', () => {
  it('restarts the server on a change and keeps the generated types current', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-dev-'))
    const children: Subprocess[] = []

    await Bun.write(join(root, 'src/server.ts'), 'setInterval(() => undefined, 1000)\n')
    await Bun.write(join(root, 'src/routes/index.kay'), 'p Home\n')
    const stop = await dev(root, { onRestart: child => children.push(child) })

    try {
      expect(children).toHaveLength(1)
      expect(await Bun.file(join(root, '.kay/types/src/routes/index.kay.tsx')).exists()).toBe(true)

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

  it('serves the compile errors of a project that failed to boot, and the reload stream', async () => {
    const source = 'p ok\nelse\n  p no\n'
    const error = new KayCompileError([{ file: join(process.cwd(), 'src/broken.kay'), source, start: 5, end: 9, message: '`else` must directly follow an `if`' }])
    const app = bootFailure(error, process.cwd())
    const page = await app.handle(new Request('http://localhost/any/page'))
    const html = await page.text()

    expect(page.status).toBe(500)
    expect(html).toContain('<h2>src/broken.kay:2:1</h2>')
    expect(html).toContain('2 | else\n  | ^^^^')
    expect(html).toContain('new EventSource("/_kay/dev/events")')

    const events = await app.handle(new Request('http://localhost/_kay/dev/events'))

    expect(events.headers.get('content-type')).toBe('text/event-stream')
    expect(await firstEvent(events)).toMatch(/^retry: 100\nevent: boot\ndata: [\w-]+\n\n$/)
  })
})
