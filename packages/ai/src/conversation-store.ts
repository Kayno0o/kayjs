import type { Database } from 'bun:sqlite'
import type { ConversationRow } from './conversation-title'
import type { Source } from './types'
import { openSqlite } from 'kay/library'

// A tool call a reply made and what the model was told of it, as the next ask replays them.
export interface StoredCall {
  id: string
  name: string
  // The arguments as the JSON object the provider was sent back.
  arguments: string
  result: string
  ok: boolean
}

// A turn as a conversation keeps it: its text, the sources a reply cites, whether it was stopped and the tool calls of a reply, never its files.
export interface StoredTurn {
  role: 'user' | 'assistant'
  content: string
  // The calls of each request a reply made to the model, in order, which are left out of what a Chat shows.
  steps?: StoredCall[][] | undefined
  sources?: Source[] | undefined
  stopped?: boolean | undefined
  // The id of the Chat's reply whose write added it, which a store keeps with the turn: a tab whose write lost to another's is then refused its next send.
  reply?: string | undefined
}

export interface StoredConversation extends ConversationRow {
  // Counts the writes of its turns, so a Chat posting to an older one is told another tab moved on.
  revision: number
  turns: StoredTurn[]
}

// A conversation is its owner's (the user the request names), under the action it was held by (`scope`, the action's path), by the id its Chat made.
export interface ConversationKey {
  owner: string
  scope: string
  id: string
}

export interface ConversationChange {
  // The trailing turns a regenerate or an edit replaces.
  drop: number
  add: StoredTurn[]
  // The title of a conversation this write creates; a stored one keeps its own.
  title: string
}

// Where `ask` keeps the conversations of a Chat with `keepOnServer`: `pgConversations(db)` or `sqliteConversations(path)`, or one of the app's own given to `ai({ conversations })`; left out, the database of the app's `store`.
export interface ConversationStore {
  // The owner's conversations under `scope`, the most recently updated first, `limit` at most.
  list: (owner: string, scope: string, limit: number) => Promise<ConversationRow[]>
  get: (key: ConversationKey) => Promise<StoredConversation | undefined>
  // Applies `change` when the conversation is still at `revision` (0 for one not stored yet) and answers its new revision, or undefined, writing nothing, when another write came first.
  write: (key: ConversationKey, revision: number, change: ConversationChange) => Promise<number | undefined>
  // Answer whether the conversation was there.
  rename: (key: ConversationKey, title: string) => Promise<boolean>
  delete: (key: ConversationKey) => Promise<boolean>
}

export const CONVERSATIONS_FILE = 'data/ai-conversations.sqlite'
// What one owner keeps under one action: the least recently updated conversation goes past it, and the oldest turns of a conversation past its own.
export const MOST_CONVERSATIONS = 200
export const MOST_TURNS = 500
// The tool results one conversation keeps, in characters (each is clipped on its own too): past it the oldest turns' results are replaced by `LEFT_OUT`, as the replay shortens them once the ask is full.
export const MOST_STORED_RESULTS = 200_000
// What a result becomes once it is shortened.
export const LEFT_OUT = '(left out)'

// The turns with the results of the oldest replaced by `LEFT_OUT` until the results kept fit `MOST_STORED_RESULTS`; the turns of the latest exchange are never touched.
export function withinResultCap(turns: StoredTurn[]): StoredTurn[] {
  const size = (turn: StoredTurn) => (turn.steps ?? []).reduce((sum, calls) => sum + calls.reduce((inner, call) => inner + call.result.length, 0), 0)
  let total = turns.reduce((sum, turn) => sum + size(turn), 0)

  if (total <= MOST_STORED_RESULTS)
    return turns

  return turns.map((turn, at) => {
    if (total <= MOST_STORED_RESULTS || at >= turns.length - 2 || turn.steps === undefined)
      return turn

    const before = size(turn)
    const shortened = { ...turn, steps: turn.steps.map(calls => calls.map(call => call.result.length > LEFT_OUT.length ? { ...call, result: LEFT_OUT } : call)) }

    total -= before - size(shortened)

    return shortened
  })
}

interface Row {
  id: string
  title: string
  revision: number
  updated_at: number
  turns: string
}

export function turnsOf(text: string): StoredTurn[] {
  try {
    const value: unknown = JSON.parse(text)

    return Array.isArray(value) ? value as StoredTurn[] : []
  }
  catch {
    return []
  }
}

// The conversations in one SQLite file, which the processes of the machine opening it share; the file is readable by the server's user alone.
export function sqliteConversations(path: string = CONVERSATIONS_FILE): ConversationStore {
  let opened: ReturnType<typeof open> | undefined

  // Opened by the first query, so building or checking an app makes no file.
  const db = () => opened ??= open(path)

  return {
    list: async (owner, scope, limit) => Promise.resolve(db().list.all(owner, scope, limit).map(row => ({ id: row.id, title: row.title, updatedAt: row.updated_at }))),
    get: async ({ owner, scope, id }) => {
      const row = db().get.get(owner, scope, id)

      return Promise.resolve(row === null ? undefined : { id: row.id, title: row.title, updatedAt: row.updated_at, revision: row.revision, turns: turnsOf(row.turns) })
    },
    write: async (key, revision, change) => Promise.resolve(db().write(key, revision, change)),
    rename: async ({ owner, scope, id }, title) => Promise.resolve(db().rename.run(title, owner, scope, id).changes > 0),
    delete: async ({ owner, scope, id }) => Promise.resolve(db().remove.run(owner, scope, id).changes > 0),
  }
}

function open(path: string) {
  const db: Database = openSqlite(path)

  // The table had a `kai_` prefix before it followed the `kay_<library>_*` naming: a file from then keeps its conversations under the new name. The old name is built, as the naming test would otherwise take it for a table kept.
  const legacy = ['kai', 'conversations'].join('_')
  const tableNamed = (name: string) => db.query('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = ?').get(name) !== null

  // Two processes opening the file at once take turns: the check is made again inside the write lock, and a new table another process made empty first is replaced by the old one.
  const migrate = db.transaction(() => {
    if (!tableNamed(legacy))
      return

    if (tableNamed('kay_ai_conversations')) {
      if (db.query('SELECT 1 FROM kay_ai_conversations LIMIT 1').get() !== null)
        return

      db.run('DROP TABLE kay_ai_conversations')
    }

    db.run(`DROP INDEX IF EXISTS ${legacy}_updated`)
    db.run(`ALTER TABLE ${legacy} RENAME TO kay_ai_conversations`)
  })

  if (tableNamed(legacy))
    migrate.immediate()

  db.run('CREATE TABLE IF NOT EXISTS kay_ai_conversations (owner TEXT NOT NULL, scope TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, turns TEXT NOT NULL, PRIMARY KEY (owner, scope, id))')
  db.run('CREATE INDEX IF NOT EXISTS kay_ai_conversations_updated ON kay_ai_conversations (owner, scope, updated_at)')

  const list = db.query<Row, [string, string, number]>('SELECT id, title, revision, updated_at, \'\' AS turns FROM kay_ai_conversations WHERE owner = ?1 AND scope = ?2 ORDER BY updated_at DESC, rowid DESC LIMIT ?3')
  const get = db.query<Row, [string, string, string]>('SELECT id, title, revision, updated_at, turns FROM kay_ai_conversations WHERE owner = ?1 AND scope = ?2 AND id = ?3')
  const upsert = db.query('INSERT INTO kay_ai_conversations (owner, scope, id, title, revision, updated_at, turns) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT (owner, scope, id) DO UPDATE SET revision = ?5, updated_at = ?6, turns = ?7')
  const prune = db.query('DELETE FROM kay_ai_conversations WHERE owner = ?1 AND scope = ?2 AND id NOT IN (SELECT id FROM kay_ai_conversations WHERE owner = ?1 AND scope = ?2 ORDER BY updated_at DESC, rowid DESC LIMIT ?3)')
  // A rename keeps the conversation's place in the list and among the ones kept, which only its turns move.
  const rename = db.query('UPDATE kay_ai_conversations SET title = ?1 WHERE owner = ?2 AND scope = ?3 AND id = ?4')
  const remove = db.query('DELETE FROM kay_ai_conversations WHERE owner = ?1 AND scope = ?2 AND id = ?3')

  // The check of the revision and the write are one transaction, so two processes writing at once cannot both pass it.
  const write = db.transaction(({ owner, scope, id }: ConversationKey, revision: number, { drop, add, title }: ConversationChange): number | undefined => {
    const row = get.get(owner, scope, id)

    if ((row?.revision ?? 0) !== revision)
      return undefined

    const turns = row === null ? [] : turnsOf(row.turns)
    const next = withinResultCap([...turns.slice(0, Math.max(0, turns.length - drop)), ...add].slice(-MOST_TURNS))

    upsert.run(owner, scope, id, title, revision + 1, Date.now(), JSON.stringify(next))

    if (row === null)
      prune.run(owner, scope, MOST_CONVERSATIONS)

    return revision + 1
  })

  return { list, get, write: (key: ConversationKey, revision: number, change: ConversationChange) => write.immediate(key, revision, change), rename, remove }
}
