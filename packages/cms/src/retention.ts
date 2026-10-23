import type { ContentLoader } from 'kay/content'
import type { EntryRef } from './kay/contract'
import { isEvent, pruneActivity } from './activity'
import { hiddenOf, rowOf, SWEEP_MARKER } from './hidden'
import { collections, entries } from './kay/content'
import { log } from './log'
import { placeOf, pruneRevisions } from './revisions'
import { settings } from './settings'
import { isRow, purge, trashRevision } from './trash'

// How often a server drops what its trash, revisions and activity may no longer keep, and how long after it starts the first sweep waits, so it is not on the boot path.
const SWEEP_EVERY = 60 * 60 * 1000
const FIRST_SWEEP = 5 * 60 * 1000
// A sweep reads every history row, to find a revision left out of an index, once this long after the last one that did, whichever process made it; the others read only what the last sweep left marked.
const FULL_AFTER = 24 * 60 * 60 * 1000
// What a clock of another replica may be off by, in the times a sweep leans on.
const SKEW = 60 * 1000
// What a forgotten editor's name is replaced by.
const FORGOTTEN = 'Former editor'

const KINDS = ['history', 'trash', 'activity'] as const

// What the last sweeps left of a collection's history: when a full one ran, and what the trash (a revision that changes when an entry is put there) and the activity hold, so a light sweep reads neither before a row can expire. `oldest` is a time before which no row of theirs was written.
interface Marks {
  full: number
  trash?: { oldest: number, rev: string, places: string[] } | undefined
  activity?: { oldest: number } | undefined
}

// A row another kind wrote into the same store, a blog entry with an `author` field for one, is not touched.
function isOfKind(kind: (typeof KINDS)[number], slug: string, data: unknown): boolean {
  if (kind === 'trash')
    return isRow(data)

  return kind === 'activity' ? isEvent(data) : slug.includes('\u0001')
}

async function loadedNames(): Promise<string[]> {
  return (await collections({ counts: false })).filter(collection => collection.kind === 'loaded').map(collection => collection.name)
}

async function readMarks(history: ContentLoader): Promise<Marks | undefined> {
  const marks = (await rowOf(history, SWEEP_MARKER))?.data as Partial<Marks> | undefined

  return typeof marks?.full === 'number' ? marks as Marks : undefined
}

// Drops what the trash and the history may no longer keep: the trash past `history.trash`, the revisions and activity past `history.maxAge`. Never throws.
// A full sweep reads every history row, which finds a revision left out of its index. A light one reads the indexes of the entries the collection and its trash hold, and the activity only once a row of theirs can have expired, and the trash only once a row of its can have expired or an entry was put there, as the last sweep marked in the history store. Left out, `full` is true once a day, and for a collection no sweep has marked.
export async function sweepHistory({ full }: { full?: boolean } = {}): Promise<void> {
  const history = settings().history

  if (history === undefined)
    return

  try {
    const cutoff = history.maxAge === undefined ? undefined : Date.now() - history.maxAge

    for (const name of await loadedNames()) {
      // A collection whose loader fails must not stop the others from being swept.
      try {
        await sweepCollection(name, cutoff, full)
      }
      catch (error) {
        log.error(`the history of ${name} could not be swept`, error)
      }
    }
  }
  catch (error) {
    log.error('the trash and the history could not be swept of what expired', error)
  }
}

async function sweepCollection(name: string, cutoff: number | undefined, requested: boolean | undefined): Promise<void> {
  const now = Date.now()
  const kept = settings().history?.trash
  const store = hiddenOf(name, 'history')
  const marks = store === undefined || requested === true ? undefined : await readMarks(store)
  const everything = requested === true || (requested === undefined && (marks === undefined || now - marks.full >= FULL_AFTER))
  const next: Marks = { full: everything ? now : marks?.full ?? 0 }
  const trash = hiddenOf(name, 'trash')
  let places: string[] = []

  if (trash !== undefined && kept !== undefined) {
    const known = marks?.trash
    const seen = everything || known === undefined ? undefined : await trashRevision(name)

    if (known !== undefined && seen !== undefined && seen === known.rev && known.oldest - SKEW >= now - kept) {
      next.trash = known
      places = known.places
    }
    else {
      const left = await purge(name)

      if (left !== undefined) {
        places = left.places
        next.trash = { oldest: left.oldest, rev: left.rev, places }
      }
      // A trash that could not be read keeps the places the last sweep read, and its mark, so the next sweep reads it again.
      else if (known !== undefined) {
        places = known.places
        next.trash = known
      }
    }
  }

  if (cutoff !== undefined) {
    const known = marks?.activity

    if (!everything && known !== undefined && known.oldest - SKEW >= cutoff) {
      next.activity = known
    }
    else {
      const oldest = await pruneActivity(name, cutoff)

      if (oldest !== undefined)
        next.activity = { oldest }
    }

    const pruned = await pruneRevisions(name, cutoff, everything ? undefined : [...new Set([...(await entries(name)).map(placeOf), ...places])])

    // A full sweep that failed to prune leaves the day for the next one to try again.
    if (everything && !pruned)
      next.full = marks?.full ?? 0
  }

  if (store !== undefined && JSON.stringify(next) !== JSON.stringify(marks))
    await store.save!({ slug: SWEEP_MARKER, data: next })
}

let sweeping: ReturnType<typeof setTimeout> | undefined

// Sweeps a few minutes after the server starts and every hour from then on, on timers that do not keep the process alive, so what expired goes whether or not anyone opens the trash.
export function startSweeping(): void {
  if (sweeping !== undefined)
    return

  const sweep = () => void sweepHistory()

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
