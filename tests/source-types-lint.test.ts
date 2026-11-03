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

describe('deprecated-source-types', () => {
  it('renames the import and every use of it, type imports included, and leaves other modules alone', async () => {
    const source = 'import type { StreamStatus, ResourceStatus } from \'kay\'\nimport { ResourceFailure } from \'./mine\'\n\nexport const a = (status: StreamStatus, other: ResourceStatus) => [status, other]\n'
    const root = await project({ 'src/a.ts': source, 'src/b.ts': 'import type { StreamStatus } from \'./mine\'\n\nexport type B = StreamStatus\n' })

    try {
      const found = await sourceTypes(root, {})

      expect(found.map(diagnostic => [diagnostic.file.slice(root.length + 1), diagnostic.line])).toEqual([['src/a.ts', 1], ['src/a.ts', 1]])
      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'src/a.ts')).text()).toBe(source.replace('StreamStatus, ResourceStatus', 'ConnectionStatus, LoadStatus').replace('(status: StreamStatus, other: ResourceStatus)', '(status: ConnectionStatus, other: LoadStatus)'))
      expect(await Bun.file(join(root, 'src/b.ts')).text()).toContain('StreamStatus')
      expect(await sourceTypes(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports with no fix a name already taken, renames only the import of an alias, and is quiet when allowed', async () => {
    const taken = 'import type { ResourceFailure, ApiError } from \'kay\'\n\nexport const a = (error: ResourceFailure | ApiError) => error\n'
    const aliased = 'import type { StreamStatus as Status } from \'kay\'\n\nexport const b = (status: Status) => status\n'
    const root = await project({ 'src/taken.ts': taken, 'src/aliased.ts': aliased })

    try {
      const found = await sourceTypes(root, {})

      expect(found).toHaveLength(2)
      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'src/taken.ts')).text()).toBe(taken)
      expect(await Bun.file(join(root, 'src/aliased.ts')).text()).toBe(aliased.replace('StreamStatus as Status', 'ConnectionStatus as Status'))
      expect(await sourceTypes(root, { lints: { 'deprecated-source-types': 'allow' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
