import type { ContentLoader } from 'kay/content'
import type { SaveEvent } from './settings'
import { hiddenOf } from './hidden'
import { log } from './log'

// One thing an editor did: the verb is a `SaveEvent`'s.
export interface Activity {
  at: number
  verb: SaveEvent['verb']
  collection: string
  slug: string
  locale?: string | undefined
  // The slug an entry had before a rename.
  from?: string | undefined
  author?: string | undefined
}

type Row = Omit<Activity, 'collection'>

// The most events kept per collection, the oldest going first.
const KEPT = 500
// A collection's log is trimmed once in this many events written by a process, so one nobody reads does not grow for ever.
const TRIM_EVERY = 100

const written = new Map<string, number>()
// The collections being trimmed, so two reads over the cap do not trim the same rows twice.
const trimming = new Set<string>()
// Two events of a process never share a millisecond, so they keep the order they happened in.
let latest = 0

async function trim(hidden: ContentLoader, rows: Awaited<ReturnType<ContentLoader['load']>>): Promise<void> {
  const newest = rows.filter(row => isEvent(row.data)).sort((a, b) => (b.data as Row).at - (a.data as Row).at)

  await Promise.all(newest.slice(KEPT).map(async row => hidden.remove!({ slug: row.slug })))
}

// Trims without making a save or a read wait for it; a failure is logged.
function trimLater(collection: string, hidden: ContentLoader, rows: () => ReturnType<ContentLoader['load']>): void {
  if (trimming.has(collection))
    return

  trimming.add(collection)
  void (async () => {
    try {
      await trim(hidden, await rows())
    }
    catch (error) {
      log.error(`${collection}'s activity could not be trimmed`, error)
    }
    finally {
      trimming.delete(collection)
    }
  })()
}

// A row a loader of another kind wrote here by mistake has no verb.
function isEvent(data: unknown): data is Row {
  return typeof data === 'object' && data !== null && typeof (data as Row).verb === 'string' && typeof (data as Row).at === 'number'
}

// Keeps what an editor's change went through, in a hidden collection beside the entries: one small row per event, so two saves at once never write over each other. Never throws, as the change is written.
export async function recordActivity(event: SaveEvent): Promise<void> {
  // A reorder is a position, not something an editor did to an entry.
  if (event.verb === 'move')
    return

  const hidden = hiddenOf(event.collection, 'activity')

  if (hidden === undefined)
    return

  try {
    latest = Math.max(Date.now(), latest + 1)

    const row: Row = { at: latest, verb: event.verb, slug: event.slug, ...event.locale !== undefined && { locale: event.locale }, ...event.from !== undefined && { from: event.from }, ...event.author?.name !== undefined && { author: event.author.name } }

    await hidden.save!({ slug: `${row.at}.${Bun.randomUUIDv7().slice(-8)}`, data: row })

    const count = (written.get(event.collection) ?? 0) + 1

    written.set(event.collection, count)

    if (count % TRIM_EVERY === 0)
      trimLater(event.collection, hidden, async () => hidden.load({ preview: true }))
  }
  catch (error) {
    log.error(`${event.collection}/${event.slug}'s activity could not be kept`, error)
  }
}

// A collection's events, newest first; none for a collection that keeps no history. What is past the most kept is dropped as it is read.
export async function activityOf(collection: string): Promise<Activity[]> {
  const hidden = hiddenOf(collection, 'activity')

  if (hidden === undefined)
    return []

  try {
    const rows = (await hidden.load({ preview: true })).filter(row => isEvent(row.data))

    if (rows.length > KEPT)
      trimLater(collection, hidden, async () => Promise.resolve(rows))

    return rows.map(row => ({ collection, ...row.data as Row })).sort((a, b) => b.at - a.at).slice(0, KEPT)
  }
  catch (error) {
    log.error(`${collection}'s activity could not be read`, error)

    return []
  }
}
