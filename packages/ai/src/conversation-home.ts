import type { ConversationStore } from './conversation-store'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { logFrom } from 'kay'
import { appDatabase, appStore } from 'kay/library'
import { pgConversations } from './conversation-pg'
import { CONVERSATIONS_FILE, sqliteConversations } from './conversation-store'

interface Held {
  store: ConversationStore | undefined
  // The app store the held default was made for, so an app store set up again is followed.
  app: unknown
  chosen: ConversationStore | undefined
}

const log = logFrom('kayjs-ai')
const SLOT = Symbol.for('kayjs-ai.conversations')
let warned = false

// On the global, so every copy of the library in the process keeps conversations in one store.
function slot(): Held {
  const holder = globalThis as { [SLOT]?: Held }

  return holder[SLOT] ??= { store: undefined, app: undefined, chosen: undefined }
}

// Set by `ai({ conversations })`; undefined goes back to the default, opened again on use, so a test calling `ai()` starts on an empty one.
export function useConversations(store: ConversationStore | undefined): void {
  void closeHeld(slot())
  slot().chosen = store
  slot().store = undefined
}

async function closeHeld(held: Held): Promise<void> {
  try {
    await (held.store as { close?: () => unknown } | undefined)?.close?.()
  }
  catch (error) {
    log.warn('the conversation store could not be closed', error)
  }
}

// The default: the database of the app's `store` (the Postgres connection of `pgData`, or the SQLite file of `sqliteData`), else `data/ai-conversations.sqlite`. A `data/ai-conversations.sqlite` that exists keeps being read, so an app upgrading loses no conversation; production warns once when conversations go to a local file.
function defaultStore(held: Held): ConversationStore {
  const app = process.env.NODE_ENV === 'test' ? undefined : appStore()

  if (held.store !== undefined && held.app === app)
    return held.store

  void closeHeld(held)

  const testing = process.env.NODE_ENV === 'test'
  const database = testing ? undefined : appDatabase()
  const followed = database !== undefined && !existsSync(CONVERSATIONS_FILE) ? database : undefined
  const file = followed?.kind === 'sqlite' ? followed.path : CONVERSATIONS_FILE

  if (process.env.NODE_ENV === 'production' && !warned && followed === undefined) {
    warned = true
    log.warn(database === undefined
      ? `the conversations are kept in ${CONVERSATIONS_FILE}, a SQLite file: set the app's \`store\` (\`sqliteData\` or \`pgData\`) in kay.config.ts, or give \`ai({ conversations })\` a store, for a database that outlives a deploy`
      : `the conversations are kept in ${CONVERSATIONS_FILE}, which exists, though the app's store names a database: to use that database, move the conversations into it (or delete the file when it holds none)`)
  }

  held.app = app
  held.store = followed?.kind === 'pg' ? pgConversations(followed.source) : sqliteConversations(testing ? ':memory:' : file)

  return held.store
}

// The store `ai()` was given, else the default, in memory under `bun test`, opened once per store setup.
export function conversationStore(): ConversationStore {
  const held = slot()

  return held.chosen ?? defaultStore(held)
}
