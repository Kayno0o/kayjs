import type { Database } from 'bun:sqlite'
import type { ConversationSummary } from './conversation-title'
import type { Source } from './types'
import process from 'node:process'
import { openSqlite } from 'kay/library'

// A turn as a conversation keeps it: its text, the sources a reply cites and whether it was stopped, never its files nor its tool calls.
export interface StoredTurn {
  role: 'user' | 'assistant'
  content: string
  sources?: Source[] | undefined
  stopped?: boolean | undefined
  // The id of the Chat's reply whose write added it, which a store keeps with the turn: a tab whose write lost to another's is then refused its next send.
  reply?: string | undefined
}

export interface StoredConversation extends ConversationSummary {
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

// Where `ask` keeps the conversations of a Chat with `keepOnServer`: `sqliteConversations(path)` by default, or one of the app's own given to `ai({ conversations })`.
export interface ConversationStore {
  // The owner's conversations under `scope`, the most recently updated first, `limit` at most.
  list: (owner: string, scope: string, limit: number) => Promise<ConversationSummary[]>
  get: (key: ConversationKey) => Promise<StoredConversation | undefined>
  // Applies `change` when the conversation is still at `revision` (0 for one not stored yet) and answers its new revision, or undefined, writing nothing, when another write came first.
  write: (key: ConversationKey, revision: number, change: ConversationChange) => Promise<number | undefined>
  // Answer whether the conversation was there.
  rename: (key: ConversationKey, title: string) => Promise<boolean>
  remove: (key: ConversationKey) => Promise<boolean>
}

export const CONVERSATIONS_FILE = 'data/ai-conversations.sqlite'
// What one owner keeps under one action: the least recently updated conversation goes past it, and the oldest turns of a conversation past its own.
export const MOST_CONVERSATIONS = 200
export const MOST_TURNS = 500

interface Row {
  id: string
  title: string
  revision: number
  updated_at: number
  turns: string
}

function turnsOf(text: string): StoredTurn[] {
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
    remove: async ({ owner, scope, id }) => Promise.resolve(db().remove.run(owner, scope, id).changes > 0),
  }
}

function open(path: string) {
  const db: Database = openSqlite(path)

  db.run('CREATE TABLE IF NOT EXISTS kai_conversations (owner TEXT NOT NULL, scope TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, turns TEXT NOT NULL, PRIMARY KEY (owner, scope, id))')
  db.run('CREATE INDEX IF NOT EXISTS kai_conversations_updated ON kai_conversations (owner, scope, updated_at)')

  const list = db.query<Row, [string, string, number]>('SELECT id, title, revision, updated_at, \'\' AS turns FROM kai_conversations WHERE owner = ?1 AND scope = ?2 ORDER BY updated_at DESC, rowid DESC LIMIT ?3')
  const get = db.query<Row, [string, string, string]>('SELECT id, title, revision, updated_at, turns FROM kai_conversations WHERE owner = ?1 AND scope = ?2 AND id = ?3')
  const upsert = db.query('INSERT INTO kai_conversations (owner, scope, id, title, revision, updated_at, turns) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT (owner, scope, id) DO UPDATE SET revision = ?5, updated_at = ?6, turns = ?7')
  const prune = db.query('DELETE FROM kai_conversations WHERE owner = ?1 AND scope = ?2 AND id NOT IN (SELECT id FROM kai_conversations WHERE owner = ?1 AND scope = ?2 ORDER BY updated_at DESC, rowid DESC LIMIT ?3)')
  // A rename keeps the conversation's place in the list and among the ones kept, which only its turns move.
  const rename = db.query('UPDATE kai_conversations SET title = ?1 WHERE owner = ?2 AND scope = ?3 AND id = ?4')
  const remove = db.query('DELETE FROM kai_conversations WHERE owner = ?1 AND scope = ?2 AND id = ?3')

  // The check of the revision and the write are one transaction, so two processes writing at once cannot both pass it.
  const write = db.transaction(({ owner, scope, id }: ConversationKey, revision: number, { drop, add, title }: ConversationChange): number | undefined => {
    const row = get.get(owner, scope, id)

    if ((row?.revision ?? 0) !== revision)
      return undefined

    const turns = row === null ? [] : turnsOf(row.turns)
    const next = [...turns.slice(0, Math.max(0, turns.length - drop)), ...add].slice(-MOST_TURNS)

    upsert.run(owner, scope, id, title, revision + 1, Date.now(), JSON.stringify(next))

    if (row === null)
      prune.run(owner, scope, MOST_CONVERSATIONS)

    return revision + 1
  })

  return { list, get, write: (key: ConversationKey, revision: number, change: ConversationChange) => write.immediate(key, revision, change), rename, remove }
}

const SLOT = Symbol.for('kayjs-ai.conversations')

// On the global, so every copy of the library in the process keeps conversations in one store.
function slot(): { store: ConversationStore | undefined, chosen: ConversationStore | undefined } {
  const holder = globalThis as { [SLOT]?: { store: ConversationStore | undefined, chosen: ConversationStore | undefined } }

  return holder[SLOT] ??= { store: undefined, chosen: undefined }
}

// Set by `ai({ conversations })`; undefined goes back to the default file, opened again on use, so a test calling `ai()` starts on an empty one.
export function useConversations(store: ConversationStore | undefined): void {
  slot().chosen = store
  slot().store = undefined
}

// The store `ai()` was given, else the default file, in memory under `bun test`, opened once.
export function conversationStore(): ConversationStore {
  const held = slot()

  return held.chosen ?? (held.store ??= sqliteConversations(process.env.NODE_ENV === 'test' ? ':memory:' : CONVERSATIONS_FILE))
}
