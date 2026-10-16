import type { Subprocess } from 'bun'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { dev } from '../src/dev'
import { planReload } from '../src/dev/reload'
import { scratchDir } from './scratch'

async function until(condition: () => boolean | Promise<boolean>, timeout = 15_000) {
  for (const start = Date.now(); !await condition(); await Bun.sleep(20)) {
    if (Date.now() - start > timeout)
      throw new Error('timed out')
  }
}

// A free port, so the servers of one run all take the same.
function freePort(): number {
  const probe = Bun.listen({ hostname: 'localhost', port: 0, socket: { data: () => undefined } })
  const { port } = probe

  probe.stop(true)

  return port
}

// The response at `url`, or none while nothing listens.
async function fetched(url: string): Promise<Response | undefined> {
  try {
    return await fetch(url)
  }
  catch {
    return undefined
  }
}

const ENTRY = (log: string) => `import { Elysia } from 'elysia'\nimport { appendFileSync } from 'node:fs'\nimport { pages } from 'kay/server'\n\nappendFileSync(${JSON.stringify(log)}, 'run\\n')\nexport const app = new Elysia().onStop(() => appendFileSync(${JSON.stringify(log)}, 'stop\\n')).use(await pages()).listen(Number(process.env.PORT))\n`

// A project served by an entry of its own, `kay dev` running it, and what to ask it.
async function served(files: Record<string, string>) {
  const root = await scratchDir('dev-reload-')
  const log = join(root, '.log')
  const children: Subprocess[] = []
  const lines: string[] = []
  const port = freePort()

  await Bun.write(join(root, 'src/server.ts'), ENTRY(log))
  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))
  const stop = await dev(root, { port, log: line => lines.push(line), onRestart: child => children.push(child) })
  const url = `http://localhost:${port}`
  // Empty while the server is down between two processes.
  const text = async (path = '/') => {
    try {
      return await (await fetch(url + path)).text()
    }
    catch {
      return ''
    }
  }

  await until(() => lines.some(line => line.includes('ready in')))

  return {
    root,
    log,
    children,
    lines,
    url,
    text,
    write: async (path: string, content: string) => Bun.write(join(root, path), content),
    // The page at `path` once it says `expected`.
    sees: async (expected: string, path = '/') => until(async () => (await text(path)).includes(expected)),
    ran: () => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [],
    cleanup: async () => {
      await stop()
      await rm(root, { recursive: true, force: true })
    },
  }
}

describe.concurrent('kay dev reloading', () => {
  it('ends on the last edit of a burst, in the one process', async () => {
    const project = await served({ 'src/routes/index.kay': 'h1 Burst 0\n' })

    try {
      for (let edit = 1; edit <= 6; edit++) {
        await project.write('src/routes/index.kay', `h1 Burst ${edit}\n`)
        await Bun.sleep(15)
      }

      await project.sees('Burst 6')
      expect(project.children).toHaveLength(1)
    }
    finally {
      await project.cleanup()
    }
  })

  it('shows an edit of a page, a component and an API module without a new process, and stops the app it replaced', async () => {
    const project = await served({
      'src/routes/index.kay': '---\nimport Greeting from \'../greeting.kay\'\n---\nh1 Home\nGreeting\n',
      'src/greeting.kay': 'p Hello\n',
      'src/api/hello.ts': 'import { api } from \'kay/server\'\n\nexport default api().get(\'/\', () => ({ hello: \'one\' }))\n',
    })

    try {
      const [first] = project.children

      expect(await project.text()).toContain('Hello')
      expect(await project.text('/api/hello')).toContain('one')
      expect(project.ran()).toEqual(['run'])

      await project.write('src/greeting.kay', 'p Bonjour\n')
      await project.sees('Bonjour')

      await project.write('src/routes/index.kay', '---\nimport Greeting from \'../greeting.kay\'\n---\nh1 Accueil\nGreeting\n')
      await project.sees('Accueil')

      await project.write('src/api/hello.ts', 'import { api } from \'kay/server\'\n\nexport default api().get(\'/\', () => ({ hello: \'two\' }))\n')
      await until(async () => (await project.text('/api/hello')).includes('two'))

      expect(project.children).toEqual([first!])
      expect(first!.exitCode).toBeNull()
      // The entry ran again for each edit, and the app it replaced stopped before: its hooks end what it started.
      await until(() => project.ran().filter(line => line === 'run').length === 4)
      expect(project.ran().filter(line => line === 'stop')).toHaveLength(3)
      expect(project.lines.filter(line => line.includes('restarted in'))).toHaveLength(3)
    }
    finally {
      await project.cleanup()
    }
  }, 60_000)

  it('reloads a helper only pages import, and starts a new process for the server entry, the config and the environment', async () => {
    const project = await served({
      'src/routes/index.kay': '--- server\nimport { word } from \'../word\'\n---\nh1 {word}\n',
      'src/word.ts': 'export const word = \'first\'\n',
      'kay.config.ts': 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({})\n',
    })

    try {
      expect(project.children).toHaveLength(1)

      await project.write('src/word.ts', 'export const word = \'second\'\n')
      await project.sees('second')
      expect(project.children).toHaveLength(1)

      await project.write('kay.config.ts', 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ lang: \'fr\' })\n')
      await until(() => project.children.length === 2)
      await project.sees('lang="fr"')
      expect(project.children[0]!.killed).toBe(true)

      await project.write('src/server.ts', `${ENTRY(project.log)}// changed\n`)
      await until(() => project.children.length === 3)
      await project.sees('second')

      await project.write('.env', 'KAY_EXAMPLE=1\n')
      await until(() => project.children.length === 4)
      await project.sees('second')
    }
    finally {
      await project.cleanup()
    }
  }, 60_000)

  it('starts a new process for an entry that asks for another address, and for one that stops listening', async () => {
    const project = await served({ 'src/routes/index.kay': 'h1 Home\n' })

    try {
      const other = freePort()

      // The reload finds the new entry asking for a port the server does not listen on.
      await project.write('src/server.ts', ENTRY(project.log).replace('Number(process.env.PORT)', String(other)))
      await project.write('src/routes/index.kay', 'h1 Moved\n')
      await until(() => project.children.length === 2)
      await until(async () => (await fetched(`http://localhost:${other}`))?.ok === true)
    }
    finally {
      await project.cleanup()
    }
  }, 60_000)

  it('tells the pages open on the server that new code runs, as a new process would', async () => {
    const project = await served({ 'src/routes/index.kay': 'h1 Home\n' })

    try {
      const reader = (await fetch(`${project.url}/_kay/dev/events`)).body!.getReader()
      const decoder = new TextDecoder()
      const boots: string[] = []
      const read = async () => {
        for (;;) {
          const { value, done } = await reader.read()

          if (done)
            return

          for (const [, id] of decoder.decode(value).matchAll(/event: boot\ndata: (\S+) /g))
            boots.push(id!)
        }
      }
      const reading = read()

      await until(() => boots.length === 1)
      await project.write('src/routes/index.kay', 'h1 Changed\n')
      await until(() => boots.length === 2)

      expect(boots[1]).not.toBe(boots[0])
      expect(project.children).toHaveLength(1)
      await reader.cancel()
      await reading
    }
    finally {
      await project.cleanup()
    }
  }, 60_000)

  it('serves the compile error of an edit and the page again once it is fixed, in the same process', async () => {
    const project = await served({ 'src/routes/index.kay': 'h1 Home\n' })

    try {
      await project.write('src/routes/index.kay', 'h1 Home\nelse\n  p no\n')
      await until(async () => (await fetched(project.url))?.status === 500)
      expect(await project.text()).toContain('src/routes/index.kay:2:1')

      await project.write('src/routes/index.kay', 'h1 Fixed\n')
      await project.sees('Fixed')
      expect(project.children).toHaveLength(1)
    }
    finally {
      await project.cleanup()
    }
  }, 60_000)

  it('holds the same memory after sixty edits of a large page as after thirty', async () => {
    const project = await served({ 'src/routes/index.kay': 'h1 Edit 0\n' })
    const heaps = join(project.root, '.heaps')

    try {
      // The server process measures itself once the entry ran again, which the page changing waits on.
      await project.write('src/server.ts', `${ENTRY(project.log)}\nBun.gc(true)\nawait Bun.write(${JSON.stringify(heaps)}, \`\${await Bun.file(${JSON.stringify(heaps)}).text().catch(() => '')}\${process.memoryUsage().heapUsed}\\n\`)\n`)
      await until(() => project.children.length === 2)
      await project.sees('Edit 0')

      const measured = () => existsSync(heaps) ? readFileSync(heaps, 'utf8').split('\n').filter(Boolean).map(Number) : []

      for (let edit = 1; edit <= 60; edit++) {
        await project.write('src/routes/index.kay', `h1 Edit ${edit}\np ${'x'.repeat(200_000)} ${edit}\n`)
        await project.sees(`Edit ${edit}`)
      }

      await until(() => measured().length >= 61)
      const sizes = measured()

      // The heap settles within a few dozen edits; one keeping each version of the page, 200 KB, would grow by 6 MB over the next thirty.
      expect(project.children).toHaveLength(2)
      expect(sizes.at(-1)!).toBeLessThan(sizes[30]! + 3_000_000)
    }
    finally {
      await project.cleanup()
    }
  }, 120_000)
})

describe('the modules a change leaves stale', () => {
  it('evicts the importers of an edited helper however far, and stops at modules that do not import it', async () => {
    const dir = await scratchDir('reload-plan-')

    await Bun.write(join(dir, 'src/routes/index.kay'), '--- server\nimport { label } from \'../components/card.kay\'\n---\nh1 {label}\n')
    await Bun.write(join(dir, 'src/components/card.kay'), '--- server\nimport { word } from \'../lib/word\'\nexport const label = word\n---\np x\n')
    await Bun.write(join(dir, 'src/lib/word.ts'), 'export const word = 1\n')
    await Bun.write(join(dir, 'src/routes/other.kay'), 'p other\n')
    await Bun.write(join(dir, 'src/server.ts'), 'import \'./routes/other.kay\'\n')
    await Bun.write(join(dir, 'kay.config.ts'), 'export default {}\n')

    try {
      const real = realpathSync(dir)
      const at = (file: string) => join(real, file)
      const loaded = ['src/routes/index.kay', 'src/components/card.kay', 'src/lib/word.ts', 'src/routes/other.kay', 'src/server.ts', 'kay.config.ts'].map(at)
      const input = { root: dir, loaded, owned: [at('src/routes'), at('src/api')], config: at('kay.config.ts'), entry: at('src/server.ts') }
      const plan = planReload({ ...input, changed: ['src/lib/word.ts'] })

      expect('evict' in plan && plan.evict.sort()).toEqual(['src/components/card.kay', 'src/lib/word.ts', 'src/routes/index.kay', 'src/server.ts'].map(at).sort())
      // The entry imports a page, so a page's edit needs it new: it is code kay does not load itself.
      expect(planReload({ ...input, changed: ['src/routes/other.kay'] })).toEqual({ restart: 'src/server.ts is code kay does not load itself' })
      expect(planReload({ ...input, changed: ['kay.config.ts'] })).toEqual({ restart: 'kay.config.ts is the config' })
      expect(planReload({ ...input, changed: ['src/server.ts'] })).toEqual({ restart: 'src/server.ts is the server entry' })
      expect(planReload({ ...input, changed: ['content/post.md'] })).toEqual({ restart: 'content/post.md is no module kay loaded' })
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('follows the files import.meta.glob names, and a module the config imports reaches the config', async () => {
    const dir = await scratchDir('reload-plan-')

    await Bun.write(join(dir, 'src/routes/index.kay'), 'p home\n')
    await Bun.write(join(dir, 'src/routes/b.kay'), 'p b\n')
    await Bun.write(join(dir, 'src/api/list.ts'), 'export const files = import.meta.glob(\'../routes/*.kay\')\n')
    await Bun.write(join(dir, 'kay.config.ts'), 'import \'./src/api/list\'\nexport default {}\n')

    try {
      const real = realpathSync(dir)
      const at = (file: string) => join(real, file)
      const loaded = ['src/routes/index.kay', 'src/routes/b.kay', 'src/api/list.ts', 'kay.config.ts'].map(at)
      const input = { root: dir, loaded, owned: [at('src/routes'), at('src/api')], config: at('kay.config.ts'), entry: at('src/server.ts') }

      expect(planReload({ ...input, changed: ['src/routes/b.kay'] })).toEqual({ restart: 'the config imports a file that changed' })
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
