import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { localState } from '../src/check/local-state'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('local-state-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

const read = async (root: string, path: string) => Bun.file(join(root, path)).text()
const HEAD = 'import { local } from \'kay\'\nimport { save } from \'./notes\'\n\nconst notes = local({ key: \'id\', read: () => [], put: save })\n'

describe('deprecated-local-state', () => {
  it('renames pending() and a status() compared with a string, in a script, a fence and a template', async () => {
    const script = `${HEAD}\nexport const waiting = () => notes.pending()\nexport const offline = () => notes.status() === 'offline'\nexport const queued = () => 'pending' !== notes.status()\nexport function label() {\n  switch (notes.status()) {\n    case 'pending':\n      return 'queued'\n    case "synced":\n      return 'ok'\n    default:\n      return ''\n  }\n}\n`
    const page = `---\n${HEAD}---\np {notes.pending()} waiting\nif notes.status() === 'pending'\n  p wait\nif notes.status()==="offline"\n  p off\n`
    const root = await project({ 'src/script.ts': script, 'src/routes/page.kay': page })

    try {
      const found = await localState(root, {})

      expect(found).toHaveLength(7)
      expect(found.every(one => one.code === 'deprecated-local-state' && one.fixes?.[0]?.safe === true)).toBe(true)
      await applySafeFixes(root, found)
      expect(await read(root, 'src/script.ts')).toBe(script.replace('notes.pending()', 'notes.unsynced()').replace('notes.status() === \'offline\'', 'notes.syncStatus() === \'offline\'').replace('\'pending\' !== notes.status()', '\'unsynced\' !== notes.syncStatus()').replace('switch (notes.status())', 'switch (notes.syncStatus())').replace('case \'pending\'', 'case \'unsynced\''))
      expect(await read(root, 'src/routes/page.kay')).toBe(page.replace('notes.pending()', 'notes.unsynced()').replace('notes.status() === \'pending\'', 'notes.syncStatus() === \'unsynced\'').replace('notes.status()==="offline"', 'notes.syncStatus()==="offline"'))
      expect(await localState(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a status() read in any other way with no fix', async () => {
    const script = `${HEAD}\nexport const now = () => notes.status()\nexport const state = notes.status\nexport const text = () => \`\${notes.status()}\`\n`
    const page = `---\n${HEAD}---\np {notes.status()}\n`
    const root = await project({ 'src/script.ts': script, 'src/routes/page.kay': page })

    try {
      const found = await localState(root, {})

      expect(found).toHaveLength(4)
      expect(found.every(one => one.fixes === undefined)).toBe(true)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves other receivers alone: another module\'s local, a name bound twice, an emitter and other properties', async () => {
    const other = 'import { local } from \'./mine\'\n\nconst notes = local()\n\nnotes.pending()\nnotes.status()\n'
    const twice = `${HEAD}\nexport function again(notes: { pending: () => number }) {\n  return notes.pending()\n}\nfunction other() {\n  const notes = new Map()\n\n  return notes\n}\n`
    const same = `${HEAD}\nexport const rows = () => notes.rows()\nexport const issues = () => notes.issues().length + notes.unsynced() + notes.syncStatus().length\nexport const nested = () => holder.notes.pending()\n`
    const page = `---\n${HEAD}---\np {holder.notes.pending()} {notes.pendingCount} {other.pending()}\n`
    const root = await project({ 'src/other.ts': other, 'src/twice.ts': twice, 'src/same.ts': same, 'src/routes/page.kay': page })

    try {
      expect(await localState(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('honours levels and kay-allow', async () => {
    const script = `${HEAD}\n// kay-allow deprecated-local-state\nexport const a = () => notes.pending()\nexport const b = () => notes.pending()\n`
    const root = await project({ 'src/script.ts': script })

    try {
      expect(await localState(root, {})).toHaveLength(1)
      expect(await localState(root, { lints: { 'deprecated-local-state': 'allow' } })).toEqual([])
      expect((await localState(root, { lints: { 'deprecated-local-state': 'deny' } }))[0]?.severity).toBe('error')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('finds a collection made through a namespace import', async () => {
    const script = 'import * as kay from \'kay\'\nimport { save } from \'./notes\'\n\nconst notes = kay.local({ key: \'id\', read: () => [], put: save })\n\nexport const waiting = () => notes.pending()\n'
    const root = await project({ 'src/script.ts': script })

    try {
      expect(await localState(root, {})).toHaveLength(1)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
