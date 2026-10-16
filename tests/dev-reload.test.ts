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

// The entry with `extra` after the server it starts, which restarts the process once.
async function entryWith(project: Awaited<ReturnType<typeof served>>, extra: string) {
  await project.write('src/server.ts', `${ENTRY(project.log)}\n${extra}`)
  await until(() => project.children.length === 2)
  await project.sees('Edit 0')
}

function lines(file: string): string[] {
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
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

  it('holds one listener and one interval of the entry after twenty reloads', async () => {
    const project = await served({ 'src/routes/index.kay': 'h1 Edit 0\n' })
    const counts = join(project.root, '.counts')
    const ticks = join(project.root, '.ticks')

    try {
      await entryWith(project, `import { readFileSync } from 'node:fs'\nprocess.on('SIGUSR2', () => {})\nprocess.once('beforeExit', () => {})\nconst run = readFileSync(${JSON.stringify(project.log)}, 'utf8').split('\\n').length\nsetInterval(() => appendFileSync(${JSON.stringify(ticks)}, \`\${run}\\n\`), 10)\nappendFileSync(${JSON.stringify(counts)}, \`\${process.listenerCount('SIGUSR2')} \${process.listenerCount('beforeExit')}\\n\`)\n`)

      for (let edit = 1; edit <= 20; edit++) {
        await project.write('src/routes/index.kay', `h1 Edit ${edit}\n`)
        await project.sees(`Edit ${edit}`)
      }

      await until(() => lines(counts).length >= 21)
      await Bun.write(ticks, '')
      await Bun.sleep(200)

      expect(project.children).toHaveLength(2)
      // The entry's two listeners, and the one Elysia adds to stop its server.
      expect(new Set(lines(counts))).toEqual(new Set(['1 2']))
      // Only the run that is current still ticks.
      expect(new Set(lines(ticks)).size).toBe(1)
    }
    finally {
      await project.cleanup()
    }
  }, 120_000)

  it('closes the rooms and the session store the earlier run opened, and the pool its entry opened', async () => {
    const project = await served({ 'src/routes/index.kay': 'h1 Edit 0\n' })
    const states = join(project.root, '.states')

    try {
      const probes = ['previous.rooms.members(\'r\')', 'previous.store.get(\'x\')', 'await previous.pool`select 1`']
      const check = probes.map(probe => `try { ${probe}; state += 'open ' } catch { state += 'closed ' }`).join('\n')

      await entryWith(project, `import { SQL } from 'bun'\nimport { sqliteRooms, sqliteStore } from 'kay/server'\nconst previous = (globalThis as any).kept\nlet state = 'none'\n;(globalThis as any).kept = { rooms: sqliteRooms(${JSON.stringify(join(project.root, 'rooms.sqlite'))}), store: sqliteStore(':memory:'), pool: new SQL('sqlite://:memory:') }\nif (previous) {\nstate = ''\n${check}\n}\nappendFileSync(${JSON.stringify(states)}, state.trim() + '\\n')\n`)

      for (let edit = 1; edit <= 20; edit++) {
        await project.write('src/routes/index.kay', `h1 Edit ${edit}\n`)
        await project.sees(`Edit ${edit}`)
      }

      await until(() => lines(states).length >= 21)
      expect(project.children).toHaveLength(2)
      expect(lines(states).slice(1)).toEqual(Array.from<string>({ length: 20 }).fill('closed closed closed'))
    }
    finally {
      await project.cleanup()
    }
  }, 120_000)

  it('closes what an API module opened when it is edited, and keeps what one that did not run again opened', async () => {
    const ticks = join(await scratchDir('dev-reload-ticks-'), '.ticks')
    const api = (edit: number, name: string) => `import { appendFileSync } from 'node:fs'\nimport { api } from 'kay/server'\nimport { sqliteRooms } from 'kay/server'\n\nconst rooms = sqliteRooms(${JSON.stringify(`${ticks}-${name}.sqlite`)})\nconst previous = (globalThis as any).${name}\n;(globalThis as any).${name} = rooms\nsetInterval(() => appendFileSync(${JSON.stringify(ticks)}, '${name}${edit}\\n'), 10)\n\nexport default api().get('/', () => {\n  try {\n    previous?.members('r')\n\n    return { previous: previous ? 'open' : 'none', edit: ${edit} }\n  }\n  catch {\n    return { previous: 'closed', edit: ${edit} }\n  }\n})\n`
    const project = await served({ 'src/routes/index.kay': 'h1 Home\n', 'src/api/one.ts': api(0, 'one'), 'src/api/two.ts': api(0, 'two') })

    try {
      expect(await project.text('/api/one')).toContain('"previous":"none"')
      expect(await project.text('/api/two')).toContain('"previous":"none"')
      await project.write('src/api/one.ts', api(1, 'one'))
      await until(async () => (await project.text('/api/one')).includes('"edit":1'))
      expect(await project.text('/api/one')).toContain('"previous":"closed"')
      await Bun.write(ticks, '')
      await Bun.sleep(200)

      const seen = new Set(lines(ticks))

      // The edited module's first interval stopped and its second ticks; the other module's rooms and interval go on.
      expect(seen.has('one0')).toBe(false)
      expect(seen.has('one1')).toBe(true)
      expect(seen.has('two0')).toBe(true)
      expect(await project.text('/api/two')).toContain('"previous":"none"')
      expect(project.children).toHaveLength(1)
    }
    finally {
      await project.cleanup()
    }
  }, 60_000)

  it('keeps a pool a module that did not run again opened', async () => {
    const api = (edit: number) => `import { api } from 'kay/server'\nimport { state } from '../lib/db'\n\nexport default api().get('/', async () => ({ pool: await state(), edit: ${edit} }))\n`
    const project = await served({
      'src/routes/index.kay': 'h1 Home\n',
      'src/lib/db.ts': 'import { SQL } from \'bun\'\n\nconst sql = new SQL(\'sqlite://:memory:\')\n\nexport async function state() {\n  try {\n    await sql`select 1`\n\n    return \'open\'\n  }\n  catch {\n    return \'closed\'\n  }\n}\n',
      'src/api/hello.ts': api(0),
    })

    try {
      for (let edit = 1; edit <= 3; edit++) {
        await project.write('src/api/hello.ts', api(edit))
        await until(async () => (await project.text('/api/hello')).includes(`"edit":${edit}`))
        expect(await project.text('/api/hello')).toContain('"pool":"open"')
      }

      expect(project.children).toHaveLength(1)
    }
    finally {
      await project.cleanup()
    }
  }, 60_000)
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

  it('shows a file added to or deleted from an import.meta.glob on the next request, in the one process', async () => {
    const project = await served({
      'src/routes/index.kay': '---\nconst names = Object.keys(import.meta.glob(\'../cards/*.txt\')).sort().join(\',\')\nconst rooted = Object.keys(import.meta.glob(\'/src/cards/*.txt\')).length\n---\np Cards {names} of {rooted}\n',
      'src/cards/a.txt': 'a',
    })

    try {
      await project.sees('Cards ../cards/a.txt of 1')
      await project.write('src/cards/b.txt', 'b')
      await project.sees('Cards ../cards/a.txt,../cards/b.txt of 2')
      await rm(join(project.root, 'src/cards/a.txt'))
      await project.sees('Cards ../cards/b.txt of 1')
      expect(project.children).toHaveLength(1)
    }
    finally {
      await project.cleanup()
    }
  })

  it('evicts the module holding a glob for a file added to it, a /-rooted pattern resolving from the project root', async () => {
    const dir = await scratchDir('reload-plan-')

    await Bun.write(join(dir, 'src/routes/index.kay'), '---\nconst a = import.meta.glob(\'../cards/*.txt\')\nconst b = import.meta.glob([\'/src/more/*.txt\', \'!/src/more/skip.txt\'])\n---\np home\n')
    await Bun.write(join(dir, 'src/routes/other.kay'), 'p other\n')

    try {
      const real = realpathSync(dir)
      const at = (file: string) => join(real, file)
      const input = { root: dir, loaded: ['src/routes/index.kay', 'src/routes/other.kay'].map(at), owned: [at('src/routes')], config: at('kay.config.ts'), entry: at('src/server.ts') }
      const evicted = (changed: string) => {
        const plan = planReload({ ...input, changed: [changed] })

        return 'evict' in plan ? plan.evict : plan
      }

      expect(evicted('src/cards/new.txt')).toEqual([at('src/routes/index.kay'), at('src/server.ts')])
      expect(evicted('src/more/new.txt')).toEqual([at('src/routes/index.kay'), at('src/server.ts')])
      expect(evicted('src/more/skip.txt')).toEqual({ restart: 'src/more/skip.txt is no module kay loaded' })
      expect(evicted('src/elsewhere/new.txt')).toEqual({ restart: 'src/elsewhere/new.txt is no module kay loaded' })
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('leaves out of a glob what the loader does, and follows a glob held by a TypeScript module, an exclusion and a file added later', async () => {
    const dir = await scratchDir('reload-plan-')

    await Bun.write(join(dir, 'src/routes/index.kay'), '---\nconst a = import.meta.glob([\'../cards/*.kay\', \'!../cards/skip.kay\'])\n---\np home\n')
    await Bun.write(join(dir, 'src/cards/a.kay'), 'p a\n')
    await Bun.write(join(dir, 'src/cards/skip.kay'), 'p skip\n')
    await Bun.write(join(dir, 'src/cards/b.kay'), '---\nimport Shared from \'../shared.kay\'\n---\nShared\n')
    await Bun.write(join(dir, 'src/shared.kay'), 'p shared\n')
    await Bun.write(join(dir, 'src/api/list.ts'), 'export const files = import.meta.glob(\'../cards/*.txt\')\n')
    await Bun.write(join(dir, 'src/lib/helper.ts'), 'export const files = import.meta.glob(\'../cards/*.txt\')\n')

    try {
      const real = realpathSync(dir)
      const at = (file: string) => join(real, file)
      const files = ['src/routes/index.kay', 'src/cards/a.kay', 'src/cards/skip.kay', 'src/shared.kay', 'src/api/list.ts', 'src/lib/helper.ts']
      const input = { root: dir, loaded: files.map(at), owned: [at('src/routes'), at('src/api')], config: at('kay.config.ts'), entry: at('src/server.ts') }
      const plan = (changed: string, loaded = input.loaded) => {
        const planned = planReload({ ...input, loaded, changed: [changed] })

        return 'evict' in planned ? planned.evict.sort() : planned
      }

      // A glob held by a module of the API folder is evicted, one held by code the entry may import is not.
      expect(plan('src/cards/new.txt', input.loaded.filter(file => !file.endsWith('helper.ts')))).toEqual([at('src/api/list.ts'), at('src/server.ts')].sort())
      expect(plan('src/cards/new.txt', input.loaded.filter(file => !file.endsWith('list.ts')))).toEqual({ restart: 'src/lib/helper.ts is code kay does not load itself' })

      // A file the glob excludes, a dotfile and a file under node_modules reach no module.
      expect(plan('src/cards/skip.kay')).toEqual([at('src/cards/skip.kay'), at('src/server.ts')].sort())
      expect(plan('src/cards/.hidden.txt')).toEqual({ restart: 'src/cards/.hidden.txt is no module kay loaded' })
      expect(plan('src/cards/node_modules/x/y.txt')).toEqual({ restart: 'src/cards/node_modules/x/y.txt is no module kay loaded' })

      // A file added to the glob, then a module it imports edited: the holder follows the new file.
      expect(plan('src/cards/b.kay')).toContain(at('src/routes/index.kay'))

      const loaded = [...input.loaded, at('src/cards/b.kay')]

      expect(plan('src/shared.kay', loaded)).toContain(at('src/routes/index.kay'))
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// Apart from the others: the growth limit is read from the environment the server process starts with.
describe('kay dev memory', () => {
  // A project whose server process starts with the given growth limit.
  async function servedWithin(limitMb: number) {
    const before = process.env.KAY_DEV_RELOAD_GROWTH_MB

    process.env.KAY_DEV_RELOAD_GROWTH_MB = String(limitMb)

    try {
      return await served({ 'src/routes/index.kay': 'h1 Edit 0\n' })
    }
    finally {
      if (before === undefined)
        delete process.env.KAY_DEV_RELOAD_GROWTH_MB
      else
        process.env.KAY_DEV_RELOAD_GROWTH_MB = before
    }
  }

  // The entry measures its own process once it ran again, which the page changing waits on.
  async function measuring(project: Awaited<ReturnType<typeof served>>, file: string) {
    const memory = JSON.stringify(file)

    await entryWith(project, `Bun.gc(true)\nawait Bun.write(${memory}, \`\${await Bun.file(${memory}).text().catch(() => '')}\${process.memoryUsage().heapUsed} \${process.memoryUsage.rss()}\\n\`)\n`)
  }

  async function editing(project: Awaited<ReturnType<typeof served>>, file: string) {
    for (let edit = 1; edit <= 60; edit++) {
      await project.write('src/routes/index.kay', `h1 Edit ${edit}\np ${'x'.repeat(200_000)} ${edit}\n`)
      await project.sees(`Edit ${edit}`)
    }

    await until(() => lines(file).length >= 61)

    return lines(file).map(line => line.split(' ').map(Number) as [heap: number, rss: number])
  }

  it('holds the same heap after sixty edits of a large page as after thirty', async () => {
    const project = await servedWithin(4096)
    const file = join(project.root, '.memory')

    try {
      await measuring(project, file)

      const sizes = await editing(project, file)

      // The heap settles within a few dozen edits; one keeping each version of the page, 200 KB, would grow by 6 MB over the next thirty.
      expect(project.children).toHaveLength(2)
      expect(sizes.at(-1)![0]).toBeLessThan(sizes[30]![0] + 3_000_000)
    }
    finally {
      await project.cleanup()
    }
  }, 120_000)

  it('holds its resident memory within the growth limit over sixty edits of a large page', async () => {
    const LIMIT_MB = 8
    const project = await servedWithin(LIMIT_MB)
    const file = join(project.root, '.memory')

    try {
      await measuring(project, file)

      const rss = (await editing(project, file)).map(([, resident]) => resident)

      // Bun keeps the code of every module it evaluates again, about 1 MB per edit of this page, so the process is replaced once it grew by the limit instead of by the edits.
      expect(Math.max(...rss) - rss[3]!).toBeLessThan((LIMIT_MB + 16) * 2 ** 20)
      expect(project.children.length).toBeGreaterThan(2)
    }
    finally {
      await project.cleanup()
    }
  }, 180_000)
})
