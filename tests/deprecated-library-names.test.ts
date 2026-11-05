import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { libraryNames, pgLoaderSource } from '../src/check/library-names'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('library-names-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

const read = async (root: string, path: string) => Bun.file(join(root, path)).text()
const names = (root: string, found: { file: string }[]) => found.map(one => one.file.slice(root.length + 1)).sort()

describe('deprecated-library-names', () => {
  it('renames an import and its uses, a type import, a fence import and a shorthand, and leaves what is not the library\'s', async () => {
    const plain = 'import { createAuth, memoryAuthStore } from \'@kaynooo/kayjs-auth\'\nimport { pgStore } from \'@kaynooo/kayjs-auth/pg\'\n\nexport const auth = createAuth({ store: memoryAuthStore() })\nexport const stores = { pgStore }\nexport const own = { createAuth: 1 }.createAuth\n'
    const type = 'import type { PgJobsSource } from \'kay/library\'\n\nexport type Source = PgJobsSource\n'
    const fence = '--- server\nimport { createEntryForm } from \'@kaynooo/kayjs-cms/form\'\n\nexport const form = createEntryForm({ prefix: \'/admin\', collection: {} as never })\n---\np x\n'
    const mail = 'import { createMailSuppressionTable, mailListTables } from \'@kaynooo/kayjs-mail/pg\'\n\nexport const run = async (db: string) => { await createMailSuppressionTable(db); return mailListTables }\n'
    const rootMail = 'import { createMailSuppressionTable } from \'@kaynooo/kayjs-mail\'\n\nexport const run = createMailSuppressionTable\n'
    const another = 'import { createAuth } from \'./mine\'\n\nexport const auth = createAuth({})\n'
    const root = await project({ 'src/plain.ts': plain, 'src/type.ts': type, 'src/routes/fence.kay': fence, 'src/mail.ts': mail, 'src/root-mail.ts': rootMail, 'src/another.ts': another })

    try {
      const found = await libraryNames(root, {})

      expect(names(root, found)).toEqual(['src/mail.ts', 'src/mail.ts', 'src/plain.ts', 'src/plain.ts', 'src/plain.ts', 'src/routes/fence.kay', 'src/type.ts'])
      await applySafeFixes(root, found)
      expect(await read(root, 'src/plain.ts')).toBe('import { authCore, memoryAuth } from \'@kaynooo/kayjs-auth\'\nimport { pgAuth } from \'@kaynooo/kayjs-auth/pg\'\n\nexport const auth = authCore({ store: memoryAuth() })\nexport const stores = { pgStore: pgAuth }\nexport const own = { createAuth: 1 }.createAuth\n')
      expect(await read(root, 'src/type.ts')).toBe(type.replaceAll('PgJobsSource', 'PgSource'))
      expect(await read(root, 'src/routes/fence.kay')).toBe(fence.replaceAll('createEntryForm', 'cmsEntryForm'))
      expect(await read(root, 'src/mail.ts')).toBe(mail.replaceAll('createMailSuppressionTable', 'createMailSuppressionTables').replace('mailListTables', 'mailListTableNames').replace('return mailListTables', 'return mailListTableNames'))
      expect(await read(root, 'src/root-mail.ts')).toBe(rootMail)
      expect(await read(root, 'src/another.ts')).toBe(another)
      expect(await libraryNames(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports an aliased import by its import alone, and a taken or redeclared new name with no fix', async () => {
    const aliased = 'import { createGate as gate } from \'@kaynooo/kayjs-auth\'\n\nexport const used = gate\n'
    const taken = 'import { createDrafts, cmsDrafts } from \'@kaynooo/kayjs-cms\'\n\nexport const both = [createDrafts, cmsDrafts]\n'
    const redeclared = 'import { pgStore } from \'@kaynooo/kayjs-auth/pg\'\n\nexport function pgStore() {}\n'
    const templated = '--- server\nimport { createWsAuthStore } from \'@kaynooo/kayjs-auth\'\n\nexport const store = createWsAuthStore\n---\np {createWsAuthStore}\n'
    const root = await project({ 'src/aliased.ts': aliased, 'src/taken.ts': taken, 'src/redeclared.ts': redeclared, 'src/routes/templated.kay': templated })

    try {
      const found = await libraryNames(root, {})

      expect(found.map(one => [one.file.slice(root.length + 1), one.fixes === undefined]).sort()).toEqual([
        ['src/aliased.ts', false],
        ['src/redeclared.ts', true],
        ['src/routes/templated.kay', true],
        ['src/taken.ts', true],
      ])
      await applySafeFixes(root, found)
      expect(await read(root, 'src/aliased.ts')).toBe(aliased.replace('createGate', 'authGate'))
      expect(await read(root, 'src/taken.ts')).toBe(taken)
      expect(await read(root, 'src/redeclared.ts')).toBe(redeclared)
      expect(await libraryNames(root, { lints: { 'deprecated-library-names': 'allow' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('deprecated-library-names on re-exports and dynamic imports', () => {
  it('keeps a re-export\'s public name, and renames the member of a dynamic import as the config templates write it', async () => {
    const reexport = 'export { createAuth } from \'@kaynooo/kayjs-auth\'\n'
    const template = 'export const store = async () => (await import(\'@kaynooo/kayjs-auth/pg\')).pgStore(1)\nexport const plain = import(\'@kaynooo/kayjs-cms\').then(cms => cms.createDrafts)\nexport const direct = (import(\'@kaynooo/kayjs-cms\') as never as { createDrafts: unknown }).createDrafts\n'
    const fence = '--- server\nconst { pgStore } = await import(\'@kaynooo/kayjs-auth/pg\')\nexport const made = (await import(\'@kaynooo/kayjs-auth/pg\')).pgStore\n---\np x\n'
    const other = 'export const store = async () => (await import(\'./mine\')).pgStore(1)\nexport const computed = async () => (await import(\'@kaynooo/kayjs-auth/pg\'))[\'pgStore\']\n'
    const root = await project({ 'src/reexport.ts': reexport, 'src/template.ts': template, 'src/routes/fence.kay': fence, 'src/other.ts': other })

    try {
      const found = await libraryNames(root, {})

      expect(names(root, found)).toEqual(['src/reexport.ts', 'src/routes/fence.kay', 'src/template.ts', 'src/template.ts'].sort())
      await applySafeFixes(root, found)
      expect(await read(root, 'src/reexport.ts')).toBe('export { authCore as createAuth } from \'@kaynooo/kayjs-auth\'\n')
      expect(await read(root, 'src/template.ts')).toBe(template.replace('.pgStore(1)', '.pgAuth(1)').replace('.createDrafts)', '.createDrafts)').replace('}).createDrafts\n', '}).cmsDrafts\n'))
      expect(await read(root, 'src/routes/fence.kay')).toBe(fence.replace('made = (await import(\'@kaynooo/kayjs-auth/pg\')).pgStore', 'made = (await import(\'@kaynooo/kayjs-auth/pg\')).pgAuth'))
      expect(await read(root, 'src/other.ts')).toBe(other)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('deprecated-library-names on pgLoader', () => {
  it('renames the sql key, its shorthand and a namespace call, and leaves a source beside it, another loader and a spread', async () => {
    const keyed = 'import { pgLoader } from \'@kaynooo/kayjs-cms/pg\'\n\nexport const posts = pgLoader({ name: \'posts\', sql: process.env.DATABASE_URL })\n'
    const shorthand = 'import { pgLoader } from \'@kaynooo/kayjs-cms/pg\'\n\nconst sql = process.env.DATABASE_URL\n\nexport const posts = pgLoader({ name: \'posts\', sql })\n'
    const namespaced = 'import * as pg from \'@kaynooo/kayjs-cms/pg\'\n\nexport const posts = pg.pgLoader({ name: \'posts\', sql: \'x\' })\n'
    const fence = '--- server\nimport { pgLoader } from \'@kaynooo/kayjs-cms/pg\'\n\nexport const loader = pgLoader({ name: \'a\', sql: \'x\' })\n---\np x\n'
    const clash = 'import { pgLoader } from \'@kaynooo/kayjs-cms/pg\'\n\nexport const posts = pgLoader({ name: \'posts\', sql: \'a\', source: \'b\' })\n'
    const current = 'import { pgLoader } from \'@kaynooo/kayjs-cms/pg\'\n\nexport const posts = pgLoader({ name: \'posts\', source: \'a\' })\n'
    const other = 'import { pgLoader } from \'./mine\'\n\nexport const posts = pgLoader({ name: \'posts\', sql: \'a\' })\n'
    const spread = 'import { pgLoader } from \'@kaynooo/kayjs-cms/pg\'\n\nexport const posts = (options: object) => pgLoader({ ...options, name: \'posts\' })\n'
    const spreadSql = 'import { pgLoader } from \'@kaynooo/kayjs-cms/pg\'\n\nexport const posts = (options: object) => pgLoader({ ...options, sql: \'a\' })\n'
    const root = await project({ 'src/keyed.ts': keyed, 'src/shorthand.ts': shorthand, 'src/namespaced.ts': namespaced, 'src/routes/fence.kay': fence, 'src/clash.ts': clash, 'src/current.ts': current, 'src/other.ts': other, 'src/spread.ts': spread, 'src/spread-sql.ts': spreadSql })

    try {
      const found = await pgLoaderSource(root, {})

      expect(found.map(one => [one.file.slice(root.length + 1), one.fixes === undefined]).sort()).toEqual([
        ['src/clash.ts', true],
        ['src/keyed.ts', false],
        ['src/namespaced.ts', false],
        ['src/routes/fence.kay', false],
        ['src/shorthand.ts', false],
        ['src/spread-sql.ts', true],
      ])
      await applySafeFixes(root, found)
      expect(await read(root, 'src/keyed.ts')).toBe(keyed.replace('sql:', 'source:'))
      expect(await read(root, 'src/shorthand.ts')).toBe(shorthand.replace('{ name: \'posts\', sql })', '{ name: \'posts\', source: sql })'))
      expect(await read(root, 'src/namespaced.ts')).toBe(namespaced.replace('sql:', 'source:'))
      expect(await read(root, 'src/routes/fence.kay')).toBe(fence.replace('sql:', 'source:'))
      expect(await read(root, 'src/clash.ts')).toBe(clash)
      expect(await read(root, 'src/other.ts')).toBe(other)
      expect(await read(root, 'src/spread-sql.ts')).toBe(spreadSql)
      expect((await pgLoaderSource(root, {})).map(one => one.file.slice(root.length + 1))).toEqual(['src/clash.ts', 'src/spread-sql.ts'])
      expect(await pgLoaderSource(root, { lints: { 'deprecated-library-names': 'allow' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
