import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, it } from 'bun:test'
import { setupStore } from '../../../src/server/app-store'
import { scratchDir } from '../../../tests/scratch'
import { sqliteConversations } from '../src/conversation-store'

afterEach(() => setupStore(undefined))

describe('the conversations table', () => {
  it('renames kai_conversations of a file written before 1.88 and keeps its rows', async () => {
    const file = join(await scratchDir('ai-old-table'), 'old.sqlite')
    const old = new Database(file)

    old.run('CREATE TABLE kai_conversations (owner TEXT NOT NULL, scope TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, turns TEXT NOT NULL, PRIMARY KEY (owner, scope, id))')
    old.run('CREATE INDEX kai_conversations_updated ON kai_conversations (owner, scope, updated_at)')
    old.run('INSERT INTO kai_conversations VALUES (\'ann\', \'/a\', \'c1\', \'Kept\', 3, 5, \'[]\')')
    old.close()

    const store = sqliteConversations(file)

    expect((await store.get({ owner: 'ann', scope: '/a', id: 'c1' }))?.title).toBe('Kept')

    const check = new Database(file)

    expect(check.query('SELECT name FROM sqlite_master WHERE name LIKE \'kai_%\'').all()).toEqual([])
    check.close()
  })
})

describe('the default store', () => {
  it('follows the database of the app\'s store, and the old file while it exists', async () => {
    const mode = process.env.NODE_ENV
    const root = await scratchDir('ai-home')
    const cwd = process.cwd()

    process.env.NODE_ENV = 'development'
    process.chdir(root)

    try {
      const { conversationStore, useConversations } = await import('../src/conversation-home')

      useConversations(undefined)
      setupStore({ database: `sqlite://${join(root, 'app.sqlite')}` })
      await conversationStore().write({ owner: 'a', scope: 's', id: 'i' }, 0, { drop: 0, add: [], title: 't' })
      expect(new Database(join(root, 'app.sqlite')).query('SELECT COUNT(*) AS n FROM kay_ai_conversations').get()).toEqual({ n: 1 })

      useConversations(undefined)
      mkdirSync(join(root, 'data'))
      writeFileSync(join(root, 'data', 'ai-conversations.sqlite'), '')
      await conversationStore().write({ owner: 'a', scope: 's', id: 'j' }, 0, { drop: 0, add: [], title: 't' })
      expect(new Database(join(root, 'data', 'ai-conversations.sqlite')).query('SELECT COUNT(*) AS n FROM kay_ai_conversations').get()).toEqual({ n: 1 })
    }
    finally {
      process.chdir(cwd)
      process.env.NODE_ENV = mode ?? 'test'
      const { useConversations } = await import('../src/conversation-home')

      useConversations(undefined)
    }
  })
})
