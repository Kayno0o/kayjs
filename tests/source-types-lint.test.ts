import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { durationSeconds } from '../src/check/duration-seconds'
import { applySafeFixes } from '../src/check/fixes'
import { contextName, exportNames, roomTypes, sourceTypes } from '../src/check/renamed-exports'
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

describe('deprecated-room-types', () => {
  it('renames the three old names with their uses, and leaves a name of another module', async () => {
    const source = 'import type { AsyncRoomStore, AsyncRooms, StoreRooms } from \'kay/server\'\n\nexport type A = [AsyncRoomStore, AsyncRooms<string>, StoreRooms<string>]\n'
    const root = await project({ 'src/a.ts': source, 'src/b.ts': 'import type { AsyncRooms } from \'./mine\'\n\nexport type B = AsyncRooms\n' })

    try {
      const found = await roomTypes(root, {})

      expect(found).toHaveLength(3)
      expect(found.every(diagnostic => diagnostic.fixes?.[0]?.safe)).toBe(true)
      await applySafeFixes(root, found)
      expect(await read(root, 'src/a.ts')).toBe('import type { RoomStore, Rooms, Rooms } from \'kay/server\'\n\nexport type A = [RoomStore, Rooms<string>, Rooms<string>]\n')
      expect(await read(root, 'src/b.ts')).toContain('AsyncRooms')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports with no fix when the new name is already taken, and honours the level', async () => {
    const taken = 'import type { AsyncRooms, Rooms } from \'kay/server\'\n\nexport type A = AsyncRooms<string> | Rooms<string>\n'
    const root = await project({ 'src/taken.ts': taken })

    try {
      const found = await roomTypes(root, {})

      expect(found).toHaveLength(1)
      expect(found[0]?.fixes).toBeUndefined()
      expect(await roomTypes(root, { lints: { 'deprecated-room-types': 'allow' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('deprecated-context-name', () => {
  it('renames the import and its calls, and leaves a context of another module or a local one', async () => {
    const source = 'import { context } from \'kay\'\n\nexport const Theme = context<\'light\' | \'dark\'>(\'light\')\n'
    const root = await project({ 'src/a.ts': source, 'src/b.ts': 'import { context } from \'./mine\'\n\nexport const B = context(1)\n', 'src/c.ts': 'import { context } from \'kay\'\n\nexport function c() {\n  const context = 1\n\n  return context\n}\n' })

    try {
      const found = await contextName(root, {})

      expect(found.map(diagnostic => [diagnostic.file.slice(root.length + 1), diagnostic.fixes?.[0]?.safe])).toEqual([['src/a.ts', true], ['src/c.ts', undefined]])
      await applySafeFixes(root, found)
      expect(await read(root, 'src/a.ts')).toBe('import { createContext } from \'kay\'\n\nexport const Theme = createContext<\'light\' | \'dark\'>(\'light\')\n')
      expect(await read(root, 'src/b.ts')).toContain('context(1)')
      expect(await contextName(root, { lints: { 'deprecated-context-name': 'allow' } })).toEqual([])

      await Bun.write(join(root, 'src/d.ts'), 'export { context, context as theme } from \'kay\'\n')
      await applySafeFixes(root, await contextName(root, {}))
      expect(await read(root, 'src/d.ts')).toBe('export { createContext as context, createContext as theme } from \'kay\'\n')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('deprecated-duration-seconds', () => {
  it('writes an integer literal as seconds with its unit and reports any other number with no fix', async () => {
    const source = 'import { lifetime } from \'@kaynooo/kayjs-auth\'\nimport { durationWords as words } from \'kay/library\'\n\nexport const a = [lifetime(86400, \'en\'), words(3600, \'fr\'), lifetime(1.5, \'en\'), lifetime(\'24h\', \'en\')]\n'
    const root = await project({ 'src/a.ts': source, 'src/b.ts': 'import { lifetime } from \'./mine\'\n\nexport const b = lifetime(5, \'en\')\n' })

    try {
      const found = await durationSeconds(root, {})

      expect(found).toHaveLength(3)
      await applySafeFixes(root, found)
      expect(await read(root, 'src/a.ts')).toBe(source.replace('lifetime(86400', 'lifetime(\'86400s\'').replace('words(3600', 'words(\'3600s\''))
      expect(await read(root, 'src/b.ts')).toContain('lifetime(5')
      expect(await durationSeconds(root, { lints: { 'deprecated-duration-seconds': 'allow' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('deprecated-export-names', () => {
  it('renames an export of the module it is imported from with its uses, and leaves the same name of another module', async () => {
    const source = 'import { cssColours } from \'@kaynooo/kayjs-mail\'\nimport { EveryOptions, jobTables } from \'kay/server\'\nimport { jobTables as definitions } from \'kay/pg-orm\'\n\nexport const a = [cssColours(\'\'), jobTables, definitions] as [unknown, unknown, unknown]\nexport type B = EveryOptions\n'
    const root = await project({ 'src/a.ts': source, 'src/b.ts': 'import { cssColours } from \'./mine\'\nimport { EveryOptions } from \'kay\'\n\nexport const b = [cssColours, {} as EveryOptions]\n' })

    try {
      const found = await exportNames(root, {})

      expect(found).toHaveLength(3)
      expect(found.every(diagnostic => diagnostic.fixes?.[0]?.safe)).toBe(true)
      await applySafeFixes(root, found)
      expect(await read(root, 'src/a.ts')).toBe('import { cssColors } from \'@kaynooo/kayjs-mail\'\nimport { ScheduleEveryOptions, jobTableNames } from \'kay/server\'\nimport { jobTables as definitions } from \'kay/pg-orm\'\n\nexport const a = [cssColors(\'\'), jobTableNames, definitions] as [unknown, unknown, unknown]\nexport type B = ScheduleEveryOptions\n')
      expect(await read(root, 'src/b.ts')).toContain('cssColours')
      expect(await read(root, 'src/b.ts')).toContain('EveryOptions')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('renames the rate limit types to the names that replace them', async () => {
    const root = await project({ 'src/limits.ts': 'import type { ApiRateLimit } from \'kay/server\'\nimport type { Limit } from \'@kaynooo/kayjs-auth\'\nimport type { LimitOptions } from \'@kaynooo/kayjs-ai\'\n\nexport type All = [ApiRateLimit, Limit, LimitOptions]\n' })

    try {
      const found = await exportNames(root, {})

      expect(found).toHaveLength(3)
      await applySafeFixes(root, found)
      expect(await read(root, 'src/limits.ts')).toContain('export type All = [RateLimit, AuthRateLimit, AskLimit]')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('drops the old specifier when the new name is already imported from kay', async () => {
    const root = await project({ 'src/other.ts': 'import type { RateLimit } from \'kay\'\nimport type { ApiRateLimit } from \'kay/server\'\n\nexport type All = [ApiRateLimit, RateLimit]\n', 'src/mixed.ts': 'import type { RateLimit } from \'kay\'\nimport type { ApiRateLimit, Limiter } from \'kay/server\'\n\nexport type All = [ApiRateLimit, RateLimit, Limiter]\n' })

    try {
      const found = await exportNames(root, {})

      expect(found).toHaveLength(2)
      await applySafeFixes(root, found)
      expect(await read(root, 'src/mixed.ts')).toBe('import type { RateLimit } from \'kay\'\nimport type { Limiter } from \'kay/server\'\n\nexport type All = [RateLimit, RateLimit, Limiter]\n')
      expect(await read(root, 'src/other.ts')).toBe('import type { RateLimit } from \'kay\'\n\nexport type All = [RateLimit, RateLimit]\n')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('renames the library types and functions by the module they come from', async () => {
    const files = {
      'src/_guard.ts': 'import { guard } from \'@kaynooo/kayjs-auth\'\n\nexport default guard({ redirect: \'/login\' })\n',
      'src/ai.ts': 'import type { Message, Reply } from \'@kaynooo/kayjs-ai\'\n\nexport const a = (reply: Reply, history: Message[]) => [reply, history]\n',
      'src/mail.ts': 'import type { Reply } from \'@kaynooo/kayjs-mail\'\nimport type { Member } from \'@kaynooo/kayjs-cms/room\'\nimport type { SeedEntry } from \'@kaynooo/kayjs-cms/pg\'\n\nexport const m = (reply: Reply, member: Member, seed: SeedEntry) => [reply, member, seed]\n',
    }
    const root = await project(files)

    try {
      const found = await exportNames(root, {})

      expect(found).toHaveLength(6)
      await applySafeFixes(root, found)
      expect(await read(root, 'src/_guard.ts')).toBe(files['src/_guard.ts'].replaceAll('guard', 'authGuard'))
      expect(await read(root, 'src/ai.ts')).toContain('(reply: AiReply, history: AiMessage[])')
      expect(await read(root, 'src/mail.ts')).toContain('(reply: MailReply, member: CmsMember, seed: CmsSeedEntry)')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports with no fix when the new name is already taken, and honours the level', async () => {
    const root = await project({ 'src/taken.ts': 'import { cssColors, cssColours } from \'@kaynooo/kayjs-mail\'\n\nexport const a = [cssColors, cssColours]\n' })

    try {
      const found = await exportNames(root, {})

      expect(found).toHaveLength(1)
      expect(found[0]?.fixes).toBeUndefined()
      expect(await exportNames(root, { lints: { 'deprecated-export-names': 'allow' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
