import type { CollectionInfo, SourceEntry } from './kay/contract'
import { rowsOf, statusOf } from './listing'

// How long a count is kept, which bounds how stale one is after a change made outside the CMS (a pull, a file edit); a save or delete through the CMS drops them at once.
const KEPT_MS = 30_000

interface Counted {
  drafts: number
  // When each published entry with a date ahead goes live, so the scheduled count follows the clock without a new read.
  goesLive: number[]
}

const kept = new Map<string, { at: number, read: Promise<Counted | undefined> }>()

// Drops every count, as an entry was saved or deleted.
export function forgetCounts(): void {
  kept.clear()
}

// The entries of a collection in draft and those scheduled ahead, read once per `KEPT_MS` and per change, so the content list does not read every entry of every collection on each load. Undefined when the read `read` does fails, which is not kept.
export async function countEntries(collection: CollectionInfo, read: () => Promise<SourceEntry[] | undefined>, now = Date.now()): Promise<{ drafts: number, scheduled: number } | undefined> {
  const known = kept.get(collection.name)
  const entry = known !== undefined && now - known.at < KEPT_MS ? known : { at: now, read: counted(collection, read, now) }

  if (entry !== known)
    kept.set(collection.name, entry)

  const found = await entry.read

  if (found === undefined && kept.get(collection.name) === entry)
    kept.delete(collection.name)

  return found && { drafts: found.drafts, scheduled: found.goesLive.filter(time => time > now).length }
}

async function counted(collection: CollectionInfo, read: () => Promise<SourceEntry[] | undefined>, now: number): Promise<Counted | undefined> {
  const found = await read()

  if (found === undefined)
    return undefined

  const rows = rowsOf({ ...collection }, found, now)

  return { drafts: rows.filter(row => statusOf(row) === 'draft').length, goesLive: rows.flatMap(row => row.scheduledAt === undefined ? [] : [row.scheduledAt]) }
}
