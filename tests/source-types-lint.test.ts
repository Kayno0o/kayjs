import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { sourceTypes } from '../src/check/renamed-exports'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('source-types-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

async function read(root: string, path: string): Promise<string> {
  return Bun.file(join(root, path)).text()
}

describe('deprecated-source-types', () => {
  it('applies the rename of StreamStatus and offers, without applying, the two that change a type', async () => {
    const source = 'import type { StreamStatus, ResourceStatus } from \'kay\'\nimport { ResourceFailure } from \'./mine\'\n\nexport const a = (status: StreamStatus, other: ResourceStatus) => [status, other]\n'
    const root = await project({ 'src/a.ts': source, 'src/b.ts': 'import type { StreamStatus } from \'./mine\'\n\nexport type B = StreamStatus\n', 'src/c.ts': 'import type { ResourceFailure } from \'kay\'\n\nexport const c = (error: ResourceFailure) => error\n' })

    try {
      const found = await sourceTypes(root, {})

      expect(found.map(diagnostic => [diagnostic.file.slice(root.length + 1), diagnostic.line, diagnostic.fixes?.[0]?.safe])).toEqual([['src/a.ts', 1, true], ['src/a.ts', 1, false], ['src/c.ts', 1, false]])
      await applySafeFixes(root, found)
      // The safe fix of one problem and the unsafe edits of the others, which overlap it, stay apart.
      expect(await read(root, 'src/a.ts')).toContain('ConnectionStatus')
      expect(await read(root, 'src/a.ts')).toContain('ResourceStatus')
      expect(await read(root, 'src/b.ts')).toContain('StreamStatus')
      expect(await read(root, 'src/c.ts')).toContain('ResourceFailure')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('finds an import in a .kay fence and renames it with its uses', async () => {
    const page = '---\nimport type { StreamStatus } from \'kay\'\n\nconst done = (status: StreamStatus) => status === \'done\'\n---\np x\n'
    const root = await project({ 'src/routes/index.kay': page })

    try {
      const found = await sourceTypes(root, {})

      expect(found).toHaveLength(1)
      await applySafeFixes(root, found)
      expect(await read(root, 'src/routes/index.kay')).toBe(page.replaceAll('StreamStatus', 'ConnectionStatus'))
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports with no fix a name already taken or declared again in the file, renames only the import of an alias, and honours kay-allow and the level', async () => {
    const taken = 'import type { StreamStatus, ConnectionStatus } from \'kay\'\n\nexport const a = (status: StreamStatus | ConnectionStatus) => status\n'
    const declared = 'import type { StreamStatus } from \'kay\'\n\nexport type Local = StreamStatus\nexport function b() {\n  type StreamStatus = string\n\n  return \'\' as StreamStatus\n}\n'
    const aliased = 'import type { StreamStatus as Status } from \'kay\'\n\nexport const c = (status: Status) => status\n'
    const allowed = '// kay-allow deprecated-source-types\nimport type { StreamStatus } from \'kay\'\n\nexport type D = StreamStatus\n'
    const root = await project({ 'src/taken.ts': taken, 'src/declared.ts': declared, 'src/aliased.ts': aliased, 'src/allowed.ts': allowed })

    try {
      const found = await sourceTypes(root, {})

      expect(found.map(diagnostic => diagnostic.file.slice(root.length + 1)).sort()).toEqual(['src/aliased.ts', 'src/declared.ts', 'src/taken.ts'])
      await applySafeFixes(root, found)
      expect(await read(root, 'src/taken.ts')).toBe(taken)
      expect(await read(root, 'src/declared.ts')).toBe(declared)
      expect(await read(root, 'src/aliased.ts')).toBe(aliased.replace('StreamStatus as Status', 'ConnectionStatus as Status'))
      expect(await read(root, 'src/allowed.ts')).toBe(allowed)
      expect(await sourceTypes(root, { lints: { 'deprecated-source-types': 'allow' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
