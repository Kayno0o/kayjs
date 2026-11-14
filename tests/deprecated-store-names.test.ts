import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { storeNames } from '../src/check/store-names'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('store-names-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

describe('deprecated-store-names', () => {
  it('renames the imports of the ai, mail and cms store helpers and every use of them', async () => {
    const root = await project({
      'src/stores.ts': [
        'import { conversationTable, createConversationTable, pgConversations } from \'@kayjs/ai/pg\'',
        'import { sqliteConversations } from \'@kayjs/ai/sqlite\'',
        'import { mailListTableNames } from \'@kayjs/mail/pg\'',
        'import { openLists } from \'@kayjs/mail/sqlite\'',
        'import { pgLoader } from \'@kayjs/cms/pg\'',
        'import { sqliteLoader } from \'@kayjs/cms/sqlite\'',
        '',
        'export const a = [pgConversations, sqliteConversations, createConversationTable, conversationTable, mailListTableNames, openLists, pgLoader, sqliteLoader]',
        '',
      ].join('\n'),
    })
    const found = await storeNames(root, {})

    expect(found).toHaveLength(8)
    expect(found.every(one => one.code === 'deprecated-store-names' && one.fixes?.[0]?.safe === true)).toBe(true)
    await applySafeFixes(root, found)

    const fixed = await Bun.file(join(root, 'src/stores.ts')).text()

    for (const name of ['pgAi', 'sqliteAi', 'createAiTables', 'aiTables', 'mailTables', 'sqliteLists', 'pgCms', 'sqliteCms'])
      expect(fixed).toContain(name)

    for (const name of ['pgConversations', 'sqliteConversations', 'createConversationTable', 'conversationTable', 'mailListTableNames', 'openLists', 'pgLoader', 'sqliteLoader'])
      expect(fixed).not.toContain(name)
  })

  it('renames the conversations option of ai(), and moves a lone listStore or suppressionStore of mailer() under store', async () => {
    const script = [
      'import { ai } from \'@kayjs/ai\'',
      'import { mailer } from \'@kayjs/mail\'',
      '',
      'export const a = ai({ conversations: mine })',
      'export const b = mailer({ listStore: lists, from: \'a@b.c\' })',
      'export const c = mailer({ suppressionStore })',
      'export const d = mailer({ listStore: lists, suppressionStore: bounces })',
      'export const e = mailer({ store: { lists }, listStore: lists })',
      'export const f = ai({ store: mine })',
      '',
    ].join('\n')
    const root = await project({ 'src/calls.ts': script, 'src/other.ts': 'export const x = { listStore: 1, conversations: 2 }\n' })
    const found = await storeNames(root, {})

    expect(found).toHaveLength(6)
    expect(found.filter(one => one.fixes?.[0]?.safe === true)).toHaveLength(3)
    await applySafeFixes(root, found)
    expect(await Bun.file(join(root, 'src/calls.ts')).text()).toBe(script
      .replace('{ conversations: mine }', '{ store: mine }')
      .replace('{ listStore: lists, from', '{ store: { lists: lists }, from')
      .replace('{ suppressionStore })', '{ store: { suppressions: suppressionStore } })'))
    expect(await Bun.file(join(root, 'src/other.ts')).text()).toBe('export const x = { listStore: 1, conversations: 2 }\n')
  })

  it('reads nothing off a pgConversations or an ai that is not the library\'s', async () => {
    const root = await project({ 'src/own.ts': 'import { pgConversations } from \'./mine\'\nimport { ai } from \'./mine\'\nexport const a = [pgConversations, ai({ conversations: 1 })]\n' })

    expect(await storeNames(root, {})).toEqual([])
  })

  it('is silent when the lint is allowed', async () => {
    const root = await project({ 'src/a.ts': 'import { pgLoader } from \'@kayjs/cms/pg\'\nexport const a = pgLoader\n' })

    expect(await storeNames(root, { lints: { 'deprecated-store-names': 'allow' } })).toEqual([])
  })
})
