import type { EntryRef } from './kay/contract'
import { pruneActivity } from './activity'
import { hiddenOf, rowOf } from './hidden'
import { collections } from './kay/content'
import { log } from './log'
import { placeOf, pruneRevisions } from './revisions'
import { settings } from './settings'
import { purge } from './trash'

// How often a server drops what its trash, revisions and activity may no longer keep.
const SWEEP_EVERY = 60 * 60 * 1000
// What a forgotten editor's name is replaced by.
const FORGOTTEN = 'Former editor'

const KINDS = ['history', 'trash', 'activity'] as const

async function loadedNames(): Promise<string[]> {
  return (await collections({ counts: false })).filter(collection => collection.kind === 'loaded').map(collection => collection.name)
}

// Drops what the trash and the history may no longer keep: the trash past `history.trash`, the revisions and activity past `history.maxAge`. Never throws.
export async function sweepHistory(): Promise<void> {
  const history = settings().history

  if (history === undefined)
    return

  try {
    const cutoff = history.maxAge === undefined ? undefined : Date.now() - history.maxAge

    for (const name of await loadedNames()) {
      await purge(name)

      if (cutoff !== undefined) {
        await pruneRevisions(name, cutoff)
        await pruneActivity(name, cutoff)
      }
    }
  }
  catch (error) {
    log.error('the trash and the history could not be swept of what expired', error)
  }
}

let sweeping: ReturnType<typeof setInterval> | undefined

// Sweeps now and every hour from then on, on a timer that does not keep the process alive, so what expired goes whether or not anyone opens the trash.
export function startSweeping(): void {
  if (sweeping !== undefined)
    return

  void sweepHistory()
  sweeping = setInterval(() => void sweepHistory(), SWEEP_EVERY)
  sweeping.unref()
}

export function stopSweeping(): void {
  clearInterval(sweeping)
  sweeping = undefined
}

// Removes an entry from the trash, its revisions and the activity log, for good: what an erasure request needs once the entry itself is deleted. The entry in the collection is not touched. Returns how many rows went.
export async function eraseHistory(ref: EntryRef): Promise<number> {
  let erased = 0
  const trash = hiddenOf(ref.collection, 'trash', { anyway: true })
  const activity = hiddenOf(ref.collection, 'activity', { anyway: true })

  if (trash !== undefined) {
    for (const row of await trash.load({ preview: true })) {
      const kept = row.data as { slug?: unknown, locale?: unknown } | undefined

      if (kept?.slug === ref.slug && kept.locale === ref.locale) {
        await trash.remove!({ slug: row.slug })
        erased++
      }
    }
  }

  const history = hiddenOf(ref.collection, 'history', { anyway: true })

  if (history !== undefined) {
    const place = placeOf(ref)

    for (const row of await history.load({ preview: true })) {
      if (row.slug === place || row.slug.startsWith(`${place}\u0001`)) {
        await history.remove!({ slug: row.slug })
        erased++
      }
    }
  }

  if (activity !== undefined) {
    for (const row of await activity.load({ preview: true })) {
      const event = row.data as { slug?: unknown, from?: unknown, locale?: unknown } | undefined

      if ((event?.slug === ref.slug || event?.from === ref.slug) && event?.locale === ref.locale) {
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

        if (data?.author !== name)
          continue

        // Read the row again, as a save may have changed it since the listing.
        const current = await rowOf(hidden, row.slug)

        if ((current?.data as { author?: unknown } | undefined)?.author !== name)
          continue

        await hidden.save!({ slug: row.slug, data: { ...current!.data as object, author: FORGOTTEN }, ...current!.body !== undefined && { body: current!.body } })
        changed++
      }
    }
  }

  return changed
}
