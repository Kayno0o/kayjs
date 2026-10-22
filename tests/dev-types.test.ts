import type { DevError } from '../src/server/dev-errors'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { KAY_DIR, testWorker } from '../src/build/assets'
import { dev } from '../src/dev'
import { CHECK, REFUSE } from '../src/dev/refuse'
import { TypesProcess } from '../src/dev/types-process'
import { DEV_ERRORS_FILE } from '../src/server/dev-errors'
import { scratchDir } from './scratch'

interface Event {
  event: string
  url?: string
  errors?: { file: string, line: number, column: number, code: string, message: string }[]
}

async function until(condition: () => boolean, timeout = 60_000) {
  for (const start = Date.now(); !condition(); await Bun.sleep(50)) {
    if (Date.now() - start > timeout)
      throw new Error('timed out')
  }
}

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('dev-types-')

  await Promise.all(Object.entries({ 'tsconfig.json': '{ "extends": "kay/tsconfig.json" }\n', ...files }).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

// Whether any process of the group is left.
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)

    return true
  }
  catch {
    return false
  }
}

async function midCheck(): Promise<{ types: TypesProcess, pid: number, stdin: { end: () => unknown } }> {
  const root = await project({ 'src/routes/index.kay': 'h1 Home\n' })
  const types = new TypesProcess(root, undefined)
  const checking = types.write(false, REFUSE, CHECK)
  const current = () => (types as unknown as { child?: { pid: number, stdin: { end: () => unknown } } }).child

  void (async () => {
    try {
      await checking
    }
    catch {}
  })()
  await until(() => current() !== undefined)

  const child = current()!

  await until(() => groupAlive(child.pid))

  return { types, pid: child.pid, stdin: child.stdin }
}

function listedTypeErrors(root: string): DevError[] {
  const file = join(root, KAY_DIR, `dev${testWorker()}`, DEV_ERRORS_FILE)

  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { errors: DevError[] }).errors.filter(error => error.kind === 'type') : []
}

describe('the type check beside kay dev', () => {
  it('types the project after the first tree and after each edit, showing its errors at the .kay line in the terminal event, errors.json and the pages, and says when they are fixed', async () => {
    const root = await project({ 'src/routes/index.kay': '---\nconst count: number = \'one\'\n---\np {count}\n' })
    const events: Event[] = []
    const stop = await dev(root, { format: 'json', port: 0, log: line => void events.push(JSON.parse(line) as Event) })

    try {
      await until(() => events.some(({ event }) => event === 'types'))

      const first = events.find(({ event }) => event === 'types')!

      expect(first.errors).toEqual([{ file: 'src/routes/index.kay', line: 2, column: 7, code: 'TS2322', message: 'Type \'string\' is not assignable to type \'number\'.' }])
      await until(() => listedTypeErrors(root).length === 1)
      expect(listedTypeErrors(root)).toEqual([expect.objectContaining({ kind: 'type', message: expect.stringContaining('not assignable'), problems: [expect.objectContaining({ file: 'src/routes/index.kay', line: 2 })], report: expect.stringMatching(/^error\[TS2322\]: .*\n --> src\/routes\/index\.kay:2:7\n/) })])

      const { url } = events.find(({ event }) => event === 'ready')!
      const page = await (await fetch(url!)).text()

      expect(page).toMatch(/<script type="application\/json" id="kay-type-problems">\["error\[TS2322\]/)

      // The edit fixes it: the terminal says so, errors.json forgets it, and the next page carries no block.
      const before = events.length

      await Bun.write(join(root, 'src/routes/index.kay'), '---\nconst count: number = 1\n---\np {count}\n')
      await until(() => events.slice(before).some(({ event, errors }) => event === 'types' && errors?.length === 0))
      await until(() => listedTypeErrors(root).length === 0)
      expect(await (await fetch(url!)).text()).not.toContain('kay-type-problems')
    }
    finally {
      await stop()
    }
  }, 120_000)

  it('shows the lints only the types find, a warning too, and keeps the errors listed in errors.json through a restart of the server', async () => {
    const root = await project({ 'src/routes/index.kay': '---\nconst count: 1 | 2 = Math.random() > 0.5 ? 1 : 2\n---\nmatch count\n  when 1\n    p One\n' })
    const events: Event[] = []
    const stop = await dev(root, { format: 'json', port: 0, log: line => void events.push(JSON.parse(line) as Event) })

    try {
      await until(() => events.some(({ event }) => event === 'types'))
      expect(events.find(({ event }) => event === 'types')!.errors).toEqual([expect.objectContaining({ code: 'incomplete-match', file: 'src/routes/index.kay' })])
      await until(() => listedTypeErrors(root).length === 1)

      // A new server process starts from the file and is told the set again.
      const before = events.length

      await Bun.write(join(root, '.env'), 'A=1\n')
      await until(() => events.slice(before).some(({ event }) => event === 'restart'))
      await Bun.sleep(1500)
      expect(listedTypeErrors(root)).toHaveLength(1)
    }
    finally {
      await stop()
    }
  }, 120_000)

  it('lists none of the type errors a previous run left once the config fails to load for the type check and the first check is skipped', async () => {
    const root = await project({ 'kay.config.ts': '// The server loads it, the process typing the project does not.\nif (process.argv[1]?.endsWith(\'types.ts\'))\n  throw new Error(\'no config\')\n\nexport default {}\n', 'src/routes/index.kay': 'p Fixed\n' })
    const file = join(root, KAY_DIR, `dev${testWorker()}`, DEV_ERRORS_FILE)
    const stale = { kind: 'type', time: new Date().toISOString(), message: 'old', problems: [{ file: 'src/routes/index.kay', line: 1, column: 1, code: 'TS2322', message: 'old' }], report: 'old' }

    await Bun.write(file, JSON.stringify({ errors: [stale] }))

    const stop = await dev(root, { format: 'json', port: 0, log: () => undefined })

    try {
      await until(() => listedTypeErrors(root).length === 0)
      await Bun.sleep(1500)
      expect(listedTypeErrors(root)).toEqual([])
    }
    finally {
      await stop()
    }
  }, 60_000)

  it('checks nothing with --no-types, and in a project without a tsconfig', async () => {
    const off = await project({ 'src/routes/index.kay': '---\nconst count: number = \'one\'\n---\np {count}\n' })
    const bare = await scratchDir('dev-types-')

    await Bun.write(join(bare, 'src/routes/index.kay'), '---\nconst count: number = \'one\'\n---\np {count}\n')

    for (const [root, types] of [[off, false], [bare, undefined]] as const) {
      const events: Event[] = []
      const stop = await dev(root, { format: 'json', port: 0, types, log: line => void events.push(JSON.parse(line) as Event) })

      try {
        await until(() => events.some(({ event }) => event === 'ready'))
        await Bun.sleep(4000)
        expect(events.map(({ event }) => event)).not.toContain('types')
        expect(listedTypeErrors(root)).toEqual([])
      }
      finally {
        await stop()
      }
    }
  }, 60_000)

  it('leaves no process of its group once closed mid-check', async () => {
    const { types, pid } = await midCheck()

    types.close()
    await until(() => !groupAlive(pid), 10_000)
  }, 60_000)

  it('ends its whole group when its stdin closes mid-check, as a kay dev killed outright leaves it', async () => {
    const { types, pid, stdin } = await midCheck()

    try {
      void stdin.end()
      await until(() => !groupAlive(pid), 10_000)
    }
    finally {
      types.close()
    }
  }, 60_000)
})
