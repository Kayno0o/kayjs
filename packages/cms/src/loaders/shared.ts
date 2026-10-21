import type { ContentLoader, LoadedEntry } from 'kay/content'
import { contentKey } from 'kay/content'
import { durationSeconds, invalidateLocally, onKeysInvalidated } from 'kay/library'

// An entry a loader holds from its first start: the app's initial content.
export interface SeedEntry {
  slug: string
  // In a localized collection, the locale whose folder holds the entry.
  locale?: string | undefined
  data: Record<string, unknown>
  body?: string | undefined
}

export interface LoaderOptions {
  // The collection's name in the loader, keying its rows: any name unique among the collections sharing the table.
  name: string
  // The entries written once per collection, never again, so an entry an editor deleted stays deleted: a list, or a function returning it. Processes starting together may each run the function, one writing its result.
  seed?: readonly SeedEntry[] | (() => readonly SeedEntry[] | Promise<readonly SeedEntry[]>) | undefined
  // The table holding every collection's entries, `kay_content` by default.
  table?: string | undefined
  // How long the entries are served before the next read refreshes them, as `collection()` loaders keep them.
  ttl?: ContentLoader['ttl']
  // How often the loader looks for a change another process or a hand edit made, so this process serves it without a restart or a `ttl`: `'1s'` for SQLite and `'2s'` for Postgres by default, `false` to look no more. A save made here is not looked for again.
  watch?: ContentLoader['ttl'] | false | undefined
}

export interface SavedEntry {
  slug: string
  locale?: string | undefined
  data: unknown
  body?: string | undefined
}

export interface Row {
  place: string
  data: string
  body: string | null
}

const IDENTIFIER = /^[A-Z_]\w*$/i
const DEFAULT_TABLE = 'kay_content'

// The table name, which goes into SQL text, so only a plain identifier is taken, quoted so a reserved word works.
export function tableOf(table: string | undefined): string {
  const name = table ?? DEFAULT_TABLE

  if (!IDENTIFIER.test(name))
    throw new Error(`kayjs-cms: the loader's table ${JSON.stringify(name)} is not a plain identifier`)

  return `"${name}"`
}

// The key of an entry in its collection: the slug, with the locale before it in a localized collection.
export function placeOf(entry: { slug: string, locale?: string | undefined }): string {
  return entry.locale === undefined ? entry.slug : `${entry.locale}/${entry.slug}`
}

// The row naming that a collection was seeded, which no collection name matches as it starts with a control character.
export function seededKey(name: string): string {
  return `\u0001seeded:${name}`
}

export function loadedOf(row: Row): LoadedEntry {
  return row.body === null ? { slug: row.place, data: JSON.parse(row.data) as unknown } : { slug: row.place, data: JSON.parse(row.data) as unknown, body: row.body }
}

export async function seedEntries(seed: LoaderOptions['seed']): Promise<readonly SeedEntry[]> {
  return typeof seed === 'function' ? seed() : seed ?? []
}

export function existsError(name: string, place: string): Error {
  return new Error(`${name}: ${place} exists already`)
}

export interface Watcher {
  // Takes the database's present state as the one the entries were read at, and looks for a change on every interval from then on; a second call does nothing.
  start: () => Promise<void>
  // Takes the state a save of this process left as known, so the poll does not report it as someone else's.
  settle: () => Promise<void>
}

// The longest delay a timer holds before it fires at once.
const MAX_INTERVAL_MS = 2 ** 31 - 1

const scopes = new WeakMap<object, number>()
let scopeCount = 0

// Names the database a loader was given: its path or URL, else an id for the object the app handed over.
export function scopeOf(database: string | object): string {
  if (typeof database === 'string')
    return database

  let id = scopes.get(database)

  if (id === undefined)
    scopes.set(database, id = ++scopeCount)

  return `#${id}`
}

// The running watcher of each collection, so a module a dev server evaluates again replaces its loader's timer instead of adding one.
const running = new Map<string, () => void>()

// Looks at a `signature` of what the database holds for the collection every `watch` interval, and drops the collection's entries when it changed, as a save made here does, so every process serving it follows the others' saves and a hand edit. Each process finds a change by itself, so the drop is not broadcast; one a save here or a broadcast from another process already dropped is taken as known, not found again. `force` asks for a reading even where the database says nothing moved. `scope` tells databases apart that hold collections of one name.
export function watcher(name: string, scope: string, watch: LoaderOptions['watch'], fallback: string, signature: (force: boolean) => string | Promise<string>): Watcher {
  const every = watch === false ? undefined : Math.min(MAX_INTERVAL_MS, Math.ceil(durationSeconds(watch ?? fallback, `the loader ${name}'s watch`, 'kayjs-cms') * 1000))
  const id = `${scope}\u0000${name}`
  let known: string | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let looking = false
  // Moves with each `settle`, so a look that began before one does not overwrite what it stored.
  let epoch = 0
  // True while this watcher's own drop runs, which its listener must not take for a save.
  let dropping = false

  const look = async () => {
    if (looking)
      return

    looking = true

    try {
      const before = epoch
      const now = await signature(false)

      if (before === epoch && now !== known) {
        known = now
        dropping = true

        try {
          invalidateLocally(contentKey(name))
        }
        finally {
          dropping = false
        }
      }
    }
    catch {
      // The next interval looks again; a database that is down fails the entries' own reads loudly.
    }
    finally {
      looking = false
    }
  }

  const settle = async () => {
    if (timer === undefined)
      return

    epoch++

    try {
      known = await signature(true)
    }
    catch {
      // The next look finds the difference, if any, and drops the entries once more.
    }
  }

  return {
    start: async () => {
      if (every === undefined || timer !== undefined)
        return

      known = await signature(true)
      running.get(id)?.()
      timer = setInterval(() => void look(), every)
      timer.unref()

      const mine = timer
      // A drop of the collection made elsewhere, a save here or one another process broadcast, already shows in the database: the next look must not report it again.
      const stopHearing = onKeysInvalidated((matches) => {
        if (!dropping && matches(contentKey(name)))
          void settle()

        return []
      })

      running.set(id, () => {
        clearInterval(mine)
        stopHearing()
      })
    },
    settle,
  }
}
