import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { SESSION_STORES, sessionStores } from '../src/check/renamed-exports'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('session-stores-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

describe('deprecated-session-stores', () => {
  it('names the session stores kay keeps as aliases', async () => {
    const source = await Bun.file(join(import.meta.dir, '../src/server/session.ts')).text()

    expect(Object.fromEntries([...source.matchAll(/@deprecated since 1\.84: `(\w+)`[^\n]*\n\s*export function (\w+)\(/g)].map(([, now, old]) => [old, now]))).toEqual({ ...SESSION_STORES })
  })

  it('renames the import and every use of it, in a fence and in a module', async () => {
    const page = '--- server\nimport { memoryStore, session } from \'kay/server\'\n\nexport const sessions = session({ store: memoryStore() })\nconst kept = { memoryStore }\nconst member = kept.memoryStore\n---\np x\n'
    const module = 'import * as server from \'kay/server\'\nimport { sqliteStore as open } from \'kay/server\'\n\nexport const a = server.sqliteStore(\'data/a.sqlite\')\nexport const b = open(\'data/b.sqlite\')\n'
    const untouched = 'import { memoryStore } from \'./my-store\'\nimport type { sqliteStore } from \'kay/server\'\n\nexport const c = memoryStore()\n// kay-allow deprecated-session-stores\nimport { sqliteStore as d } from \'kay/server\'\n'
    const root = await project({ 'src/routes/index.kay': page, 'src/stores.ts': module, 'src/untouched.ts': untouched })

    try {
      const found = await sessionStores(root, {})

      expect(found.map(diagnostic => [diagnostic.file.slice(root.length + 1), diagnostic.line, diagnostic.severity]).sort()).toEqual([
        ['src/routes/index.kay', 2, 'warning'],
        ['src/stores.ts', 2, 'warning'],
        ['src/stores.ts', 4, 'warning'],
      ])

      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'src/routes/index.kay')).text()).toBe('--- server\nimport { memorySessions, session } from \'kay/server\'\n\nexport const sessions = session({ store: memorySessions() })\nconst kept = { memoryStore: memorySessions }\nconst member = kept.memoryStore\n---\np x\n')
      expect(await Bun.file(join(root, 'src/stores.ts')).text()).toBe(module.replace('sqliteStore as open', 'sqliteSessions as open').replace('server.sqliteStore(', 'server.sqliteSessions('))
      expect(await Bun.file(join(root, 'src/untouched.ts')).text()).toBe(untouched)
      expect(await sessionStores(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('is quiet when allowed', async () => {
    const root = await project({ 'src/a.ts': 'import { memoryStore } from \'kay/server\'\n\nexport const a = memoryStore()\n' })

    try {
      expect(await sessionStores(root, { lints: { 'deprecated-session-stores': 'allow' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('deprecated-session-stores, fixes that would change the code', () => {
  const report = async (source: string, kind = 'ts') => {
    const root = await project({ [`src/a.${kind}`]: source })

    try {
      const found = await sessionStores(root, {})

      await applySafeFixes(root, found)

      return { count: found.length, fixed: found.filter(diagnostic => diagnostic.fixes).length, text: await Bun.file(join(root, `src/a.${kind}`)).text() }
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  it('reports with no fix an export, an annotated declaration, a taken new name and a template read', async () => {
    for (const source of [
      'import { memoryStore } from \'kay/server\'\n\nexport { memoryStore }\n',
      'import { memoryStore } from \'kay/server\'\n\nexport const f = (memoryStore: number) => memoryStore\n',
      'import { memoryStore } from \'kay/server\'\n\nconst { memoryStore: x } = { memoryStore }\nexport const y = x\n',
      'import { memoryStore } from \'kay/server\'\n\nconst memorySessions = 1\nexport const z = [memoryStore(), memorySessions]\n',
    ]) {
      const result = await report(source)

      expect([result.count, result.fixed, result.text]).toEqual([1, 0, source])
    }

    const page = '--- server\nimport { memoryStore } from \'kay/server\'\n\nconst store = memoryStore()\n---\np= String(memoryStore)\n'

    expect(await report(page, 'kay')).toEqual({ count: 1, fixed: 0, text: page })
  })

  it('leaves the members and keys of that name, and types, as they are', async () => {
    const source = 'import { memoryStore } from \'kay/server\'\n\nclass K { memoryStore() { return 1 } }\ninterface I { memoryStore: number }\nexport const a = [new K().memoryStore(), memoryStore(), ({ memoryStore: 1 }).memoryStore] as unknown as I\n'
    const result = await report(source)

    expect(result.text).toBe(source.replace('{ memoryStore }', '{ memorySessions }').replace('memoryStore(), (', 'memorySessions(), (').replace('import { memoryStore }', 'import { memorySessions }'))
  })
})
