import type { Duration } from 'kay'
import type { ConversationStore } from './conversation-store'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { logFrom } from 'kay'
import { appDatabase, appStore, configError, durationSeconds } from 'kay/library'
import { personalData } from 'kay/server'
import { pgConversations } from './conversation-pg'
import { CONVERSATIONS_FILE, sqliteConversations } from './conversation-store'

interface Held {
  store: ConversationStore | undefined
  // The app store the held default was made for, so an app store set up again is followed.
  app: unknown
  chosen: ConversationStore | undefined
  // How long a conversation is kept after its last turn, in milliseconds; undefined keeps them.
  age: number | undefined
  // When the store was last asked to drop the conversations past `age`.
  purgedAt: number
}

const log = logFrom('kayjs-ai')
const SLOT = Symbol.for('kayjs-ai.conversations')
const DEFAULT_AGE: Duration = '365d'
const PURGE_EVERY_MS = 60 * 60 * 1000
let warned = false

// On the global, so every copy of the library in the process keeps conversations in one store.
function slot(): Held {
  const holder = globalThis as { [SLOT]?: Held }

  return holder[SLOT] ??= { store: undefined, app: undefined, chosen: undefined, age: ageMs(DEFAULT_AGE), purgedAt: 0 }
}

// Set by `ai({ conversations, conversationAge })`; undefined goes back to the default, opened again on use, so a test calling `ai()` starts on an empty one.
export function useConversations(store: ConversationStore | undefined, age: Duration | false | undefined = undefined): void {
  void closeHeld(slot())
  slot().chosen = store
  slot().store = undefined
  slot().age = age === false ? undefined : ageMs(age ?? DEFAULT_AGE)
  slot().purgedAt = 0
}

function ageMs(age: Duration): number {
  return durationSeconds(age, 'ai({ conversationAge })') * 1000
}

// Drops the conversations not touched for the age they are kept to, looking at most once an hour as a turn is stored or the list read; a store that cannot is logged, not fatal.
export async function purgeAged(store: ConversationStore): Promise<void> {
  const held = slot()
  const now = Date.now()

  if (held.age === undefined || now - held.purgedAt < PURGE_EVERY_MS)
    return

  held.purgedAt = now

  try {
    if (store.deleteOlderThan === undefined)
      log.warn('the conversation store has no deleteOlderThan, so no conversation is dropped for its age; add one, or set ai({ conversationAge: false }) to say so')
    else
      await store.deleteOlderThan(now - held.age)
  }
  catch (error) {
    log.warn('the conversations past their age could not be dropped', error)
  }
}

// What an erase and an export of a user reach, with nothing for the app to declare: the package entry and `ai()` call this, so a user erased in a process that never held a conversation is still reached. A store that cannot erase or list fails the erase or the export, as the account must not go with its conversations kept.
export function registerConversationData(): void {
  personalData.register({
    name: 'ai',
    erase: async (user) => {
      const { eraseOwner } = conversationStore()

      if (eraseOwner === undefined)
        throw configError('ai', 'conversations', 'the conversation store has no eraseOwner(owner), so a user\'s conversations cannot be erased with their account; add it to the store given to ai({ conversations })')

      return eraseOwner(user)
    },
    export: async (user) => {
      const { ownedBy } = conversationStore()

      if (ownedBy === undefined)
        throw configError('ai', 'conversations', 'the conversation store has no ownedBy(owner), so a user\'s conversations cannot be exported; add it to the store given to ai({ conversations })')

      const found = await ownedBy(user)

      return found.length === 0 ? undefined : found.map(({ scope, id, title, updatedAt, turns }) => ({ scope, id, title, updatedAt, turns }))
    },
  })
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
