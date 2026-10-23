import type { EntryRef } from './kay/contract'
import { isEvent, pruneActivity } from './activity'
import { hiddenOf, rowOf } from './hidden'
import { collections, entries } from './kay/content'
import { log } from './log'
import { placeOf, pruneRevisions } from './revisions'
import { settings } from './settings'
import { isRow, purge } from './trash'

// How often a server drops what its trash, revisions and activity may no longer keep, and how long after it starts the first sweep waits, so it is not on the boot path.
const SWEEP_EVERY = 60 * 60 * 1000
const FIRST_SWEEP = 5 * 60 * 1000
// Every this many sweeps reads every history row, to find a revision left out of an index; the others read only the indexes of the entries.
const FULL_EVERY = 24
// What a forgotten editor's name is replaced by.
const FORGOTTEN = 'Former editor'

const KINDS = ['history', 'trash', 'activity'] as const

// A row another kind wrote into the same store, a blog entry with an `author` field for one, is not touched.
function isOfKind(kind: (typeof KINDS)[number], slug: string, data: unknown): boolean {
  if (kind === 'trash')
    return isRow(data)

  return kind === 'activity' ? isEvent(data) : slug.includes('\u0001')
}

async function loadedNames(): Promise<string[]> {
  return (await collections({ counts: false })).filter(collection => collection.kind === 'loaded').map(collection => collection.name)
}

// The places of the entries that can hold revisions: those the collection holds and those in its trash.
async function revisionPlaces(name: string): Promise<string[]> {
  const trash = hiddenOf(name, 'trash')
  const trashed = trash === undefined ? [] : (await trash.load({ preview: true })).filter(row => isRow(row.data)).map(row => placeOf(row.data as EntryRef))

  return [...new Set([...(await entries(name)).map(placeOf), ...trashed])]
}

// Drops what the trash and the history may no longer keep: the trash past `history.trash`, the revisions and activity past `history.maxAge`. Never throws.
// `full` reads every history row, which finds a revision left out of its index; without it only the indexes of the entries the collection and its trash hold are read.
export async function sweepHistory({ full = true }: { full?: boolean } = {}): Promise<void> {
  const history = settings().history

  if (history === undefined)
    return

  try {
    const cutoff = history.maxAge === undefined ? undefined : Date.now() - history.maxAge

    for (const name of await loadedNames()) {
      await purge(name)

      if (cutoff !== undefined) {
        await pruneRevisions(name, cutoff, full ? undefined : await revisionPlaces(name))
        await pruneActivity(name, cutoff)
      }
    }
  }
  catch (error) {
    log.error('the trash and the history could not be swept of what expired', error)
  }
}

let sweeping: ReturnType<typeof setTimeout> | undefined

// Sweeps a few minutes after the server starts and every hour from then on, on timers that do not keep the process alive, so what expired goes whether or not anyone opens the trash.
export function startSweeping(): void {
  if (sweeping !== undefined)
    return

  let sweeps = 0
  const sweep = () => void sweepHistory({ full: sweeps++ % FULL_EVERY === 0 })

  sweeping = setTimeout(() => {
    sweep()
    setInterval(sweep, SWEEP_EVERY).unref()
  }, FIRST_SWEEP)
  sweeping.unref()
}

// Removes an entry from the trash, its revisions and the activity log, for good: what an erasure request needs once the entry itself is deleted. The entry in the collection is not touched, and when a new entry took the slug its revisions and activity stay, as they are its own. Returns how many rows went.
export async function eraseHistory(ref: EntryRef): Promise<number> {
  let erased = 0
  const live = (await entries(ref.collection, { slug: ref.slug, locale: ref.locale })).length > 0
  const trash = hiddenOf(ref.collection, 'trash', { anyway: true })
  const activity = hiddenOf(ref.collection, 'activity', { anyway: true })

  if (trash !== undefined) {
    for (const row of await trash.load({ preview: true })) {
      const kept = row.data as { slug?: unknown, locale?: unknown } | undefined

      if (isRow(row.data) && kept?.slug === ref.slug && kept.locale === ref.locale) {
        await trash.remove!({ slug: row.slug })
        erased++
      }
    }
  }

  const history = hiddenOf(ref.collection, 'history', { anyway: true })

  if (history !== undefined && !live) {
    const place = placeOf(ref)

    for (const row of await history.load({ preview: true })) {
      if (row.slug === place || row.slug.startsWith(`${place}\u0001`)) {
        await history.remove!({ slug: row.slug })
        erased++
      }
    }
  }

  if (activity !== undefined && !live) {
    for (const row of await activity.load({ preview: true })) {
      const event = row.data as { slug?: unknown, from?: unknown, locale?: unknown } | undefined

      if (isEvent(row.data) && (event?.slug === ref.slug || event?.from === ref.slug) && event?.locale === ref.locale) {
        await activity.remove!({ slug: row.slug })
        erased++
      }
    }
  }

  return erased
}

// Rewrites an editor's name to `Former editor` in the trash, the revisions and the activity log of every loaded collection, for an editor who asked to be forgotten. Returns how many rows changed.
export async function forgetEditor(name: string): Promise<number> {
  let changed = 0

  for (const collection of await loadedNames()) {
    for (const kind of KINDS) {
      const hidden = hiddenOf(collection, kind, { anyway: true })

      if (hidden === undefined)
        continue

      for (const row of await hidden.load({ preview: true })) {
        const data = row.data as { author?: unknown } | undefined

        if (data?.author !== name || !isOfKind(kind, row.slug, row.data))
          continue

        // Read the row again, as a save may have changed it since the listing.
        const current = await rowOf(hidden, row.slug)

        if ((current?.data as { author?: unknown } | undefined)?.author !== name || !isOfKind(kind, row.slug, current!.data))
          continue

        await hidden.save!({ slug: row.slug, data: { ...current!.data as object, author: FORGOTTEN }, ...current!.body !== undefined && { body: current!.body } })
        changed++
      }
    }
  }

  return changed
}
