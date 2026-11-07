import type { SQL } from 'bun'
import type { PgSource } from 'kay/library'
import type { ConversationKey, ConversationStore, StoredConversation } from './conversation-store'
import type { ConversationRow } from './conversation-title'
import { connectionOf, privilegeRefused, relationsMissing } from 'kay/library'
import { MOST_CONVERSATIONS, MOST_TURNS, turnsOf, withinResultCap } from './conversation-store'

// The table the Postgres store keeps its conversations in, for a pg-orm `ignoreTables` of an app that creates it with `createConversationTable`.
export const conversationTable = 'kay_ai_conversations'

const CREATE = 'CREATE TABLE IF NOT EXISTS kay_ai_conversations (owner text NOT NULL, scope text NOT NULL, id text NOT NULL, title text NOT NULL, revision integer NOT NULL, updated_at bigint NOT NULL, turns text NOT NULL, PRIMARY KEY (owner, scope, id))'
const INDEX = 'CREATE INDEX IF NOT EXISTS kay_ai_conversations_updated ON kay_ai_conversations (owner, scope, updated_at)'

interface Row { id: string, title: string, revision: number, updated_at: string, turns: string }

// Creates the table unless it exists, for an app whose role creates nothing: run it as the database's owner, in a boot script, and list `kay_ai_conversations` in pg-orm's `ignoreTables`.
export async function createConversationTable(source: PgSource): Promise<void> {
  const db = connectionOf(source)

  try {
    await db.unsafe(CREATE)
    await db.unsafe(INDEX)
  }
  finally {
    if (typeof source === 'string')
      await db.close()
  }
}

// The conversations of a Chat with `keepOnServer` in the app's Postgres, shared by every process of every replica: `ai({ conversations: pgConversations(db) })`, `db` a Bun `SQL`, a pg-orm `Database` or a connection URL as `pgData` takes. An app whose `store` is `pgData(url)` needs to write nothing.
// The table is created on first use, which takes a role that may create tables.
export function pgConversations(source: PgSource): ConversationStore & { close: () => Promise<void> } {
  const db = connectionOf(source)
  let ready: Promise<SQL> | undefined

  const create = async (): Promise<SQL> => {
    if (!await relationsMissing(db, [conversationTable]))
      return db

    try {
      await createConversationTable(db)
    }
    catch (error) {
      if (privilegeRefused(error))
        throw new Error('kayjs-ai: pgConversations needs its kay_ai_conversations table, and its role may not create it: run `await createConversationTable(db)` from kayjs-ai/pg as the database\'s owner, and list `conversationTable` in pg-orm\'s `ignoreTables`', { cause: error })

      throw error
    }

    return db
  }

  // A failed creation is tried again by the next call rather than kept.
  const connected = async (): Promise<SQL> => {
    ready ??= create()

    try {
      return await ready
    }
    catch (error) {
      ready = undefined

      throw error
    }
  }

  const summaryOf = (row: Row): ConversationRow => ({ id: row.id, title: row.title, updatedAt: Number(row.updated_at) })

  return {
    async list(owner, scope, limit) {
      const rows = await (await connected()).unsafe<Row[]>('SELECT id, title, revision, updated_at, \'\' AS turns FROM kay_ai_conversations WHERE owner = $1 AND scope = $2 ORDER BY updated_at DESC, id DESC LIMIT $3', [owner, scope, limit])

      return rows.map(summaryOf)
    },
    async get({ owner, scope, id }): Promise<StoredConversation | undefined> {
      const [row] = await (await connected()).unsafe<Row[]>('SELECT id, title, revision, updated_at, turns FROM kay_ai_conversations WHERE owner = $1 AND scope = $2 AND id = $3', [owner, scope, id])

      return row === undefined ? undefined : { ...summaryOf(row), revision: row.revision, turns: turnsOf(row.turns) }
    },
    async write({ owner, scope, id }: ConversationKey, revision, { drop, add, title }) {
      const connection = await connected()

      // The row is locked while the revision is checked, so two replicas writing at once cannot both pass it.
      return connection.begin(async (tx): Promise<number | undefined> => {
        const [row] = await tx.unsafe<Row[]>('SELECT id, title, revision, updated_at, turns FROM kay_ai_conversations WHERE owner = $1 AND scope = $2 AND id = $3 FOR UPDATE', [owner, scope, id])

        if ((row?.revision ?? 0) !== revision)
          return undefined

        const turns = row === undefined ? [] : turnsOf(row.turns)
        const next = JSON.stringify(withinResultCap([...turns.slice(0, Math.max(0, turns.length - drop)), ...add].slice(-MOST_TURNS)))

        if (row !== undefined) {
          await tx.unsafe('UPDATE kay_ai_conversations SET revision = $4, updated_at = $5, turns = $6 WHERE owner = $1 AND scope = $2 AND id = $3', [owner, scope, id, revision + 1, Date.now(), next])

          return revision + 1
        }

        // Two writers creating the same conversation: the one the insert skips lost.
        const created = await tx.unsafe<unknown[]>('INSERT INTO kay_ai_conversations (owner, scope, id, title, revision, updated_at, turns) VALUES ($1, $2, $3, $4, 1, $5, $6) ON CONFLICT DO NOTHING RETURNING id', [owner, scope, id, title, Date.now(), next])

        if (created.length === 0)
          return undefined

        await tx.unsafe('DELETE FROM kay_ai_conversations WHERE owner = $1 AND scope = $2 AND id NOT IN (SELECT id FROM kay_ai_conversations WHERE owner = $1 AND scope = $2 ORDER BY updated_at DESC, id DESC LIMIT $3)', [owner, scope, MOST_CONVERSATIONS])

        return 1
      })
    },
    async rename({ owner, scope, id }, title) {
      return (await (await connected()).unsafe<unknown[]>('UPDATE kay_ai_conversations SET title = $1 WHERE owner = $2 AND scope = $3 AND id = $4 RETURNING id', [title, owner, scope, id])).length > 0
    },
    async delete({ owner, scope, id }) {
      return (await (await connected()).unsafe<unknown[]>('DELETE FROM kay_ai_conversations WHERE owner = $1 AND scope = $2 AND id = $3 RETURNING id', [owner, scope, id])).length > 0
    },
    close: async () => {
      if (typeof source === 'string')
        await db.close()
    },
  }
}
