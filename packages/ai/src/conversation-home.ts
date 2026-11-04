import type { ConversationStore } from './conversation-store'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { logFrom } from 'kay'
import { appDatabase } from 'kay/library'
import { pgConversations } from './conversation-pg'
import { CONVERSATIONS_FILE, sqliteConversations } from './conversation-store'

const log = logFrom('kayjs-ai')

interface Held {
  store: ConversationStore | undefined
  // What the held default was made for, so an app store set up again is followed.
  home: string | undefined
  chosen: ConversationStore | undefined
}

const SLOT = Symbol.for('kayjs-ai.conversations')
let warned = false

// On the global, so every copy of the library in the process keeps conversations in one store.
function slot(): Held {
  const holder = globalThis as { [SLOT]?: Held }

  return holder[SLOT] ??= { store: undefined, home: undefined, chosen: undefined }
}

// Set by `ai({ conversations })`; undefined goes back to the default, opened again on use, so a test calling `ai()` starts on an empty one.
export function useConversations(store: ConversationStore | undefined): void {
  slot().chosen = store
  slot().store = undefined
}

// The default: the database of the app's `store` (a Postgres, or the SQLite file of `sqliteData`), else `data/ai-conversations.sqlite`. A `data/ai-conversations.sqlite` that exists keeps being read, so an app upgrading loses no conversation; production warns once when conversations go to a local file.
function defaultStore(held: Held): ConversationStore {
  const testing = process.env.NODE_ENV === 'test'
  const database = testing ? undefined : appDatabase()
  const followed = database !== undefined && !existsSync(CONVERSATIONS_FILE) ? database : undefined
  const where = followed?.kind === 'pg' ? followed.url : followed?.path ?? CONVERSATIONS_FILE
  const home = testing ? ':memory:' : where

  if (held.store !== undefined && held.home === home)
    return held.store

  if (process.env.NODE_ENV === 'production' && !warned && home === CONVERSATIONS_FILE) {
    warned = true
    log.warn(database === undefined
      ? `the conversations are kept in ${CONVERSATIONS_FILE}, a SQLite file: set the app's \`store\` (\`sqliteData\` or \`pgData\`) in kay.config.ts, or give \`ai({ conversations })\` a store, for a database that outlives a deploy`
      : `the conversations are kept in ${CONVERSATIONS_FILE}, which exists, though the app's store names a database: to use that database, move the conversations into it (or delete the file when it holds none)`)
  }

  held.home = home
  held.store = followed?.kind === 'pg' ? pgConversations(followed.url) : sqliteConversations(home)

  return held.store
}

// The store `ai()` was given, else the default, in memory under `bun test`, opened once.
export function conversationStore(): ConversationStore {
  const held = slot()

  return held.chosen ?? defaultStore(held)
}
