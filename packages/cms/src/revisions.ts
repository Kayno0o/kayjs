import type { Identity } from './files'
import type { EntryRef } from './kay/contract'
import { hiddenOf, rowOf } from './hidden'
import { log } from './log'
import { settings } from './settings'

// One save of an entry: what it held after, and who saved it and how. `at` is 0 for the entry as it stood before its first recorded save.
export interface Revision {
  at: number
  author?: string | undefined
  verb: string
  data: Record<string, unknown>
  body?: string | undefined
}

// The key of an entry in its collection: the slug, with the locale before it in a localized collection.
export function placeOf({ slug, locale }: Pick<EntryRef, 'slug' | 'locale'>): string {
  return locale === undefined ? slug : `${locale}/${slug}`
}

interface Row {
  revisions?: Revision[]
}

// The revisions of an entry, oldest first; none for a collection that keeps no history.
export async function revisionsOf(ref: EntryRef): Promise<Revision[]> {
  const hidden = hiddenOf(ref.collection, 'history')
  const row = hidden && await rowOf(hidden, placeOf(ref))

  return Array.isArray((row?.data as Row | undefined)?.revisions) ? (row!.data as Row).revisions! : []
}

function sameContent(a: Pick<Revision, 'data' | 'body'>, b: Pick<Revision, 'data' | 'body'>): boolean {
  return Bun.deepEquals(a.data, b.data) && (a.body ?? '') === (b.body ?? '')
}

// What an entry's history holds before a save, to write the save after it.
export interface Trail {
  record: (saved: Pick<Revision, 'data' | 'body' | 'verb'>, author: Identity | undefined) => Promise<void>
}

// Reads the history of an entry about to be saved; undefined for a collection that keeps none, or when the history cannot be read, which is logged and never stops the save. `current` reads the entry as it stands, which an entry with no history yet keeps as its first revision, as the history would otherwise never show it.
export async function openTrail(ref: EntryRef, current: (() => Promise<Pick<Revision, 'data' | 'body'> | undefined>) | undefined): Promise<Trail | undefined> {
  const hidden = hiddenOf(ref.collection, 'history')

  if (hidden === undefined)
    return undefined

  try {
    const revisions = [...await revisionsOf(ref)]

    if (revisions.length === 0 && current) {
      const original = await current()

      if (original)
        revisions.push({ at: 0, verb: 'original', data: original.data, ...original.body !== undefined && { body: original.body } })
    }

    return {
      // Never throws, for the same reason.
      record: async (saved, author) => {
        try {
          const last = revisions.at(-1)

          if (last && sameContent(last, saved))
            return

          revisions.push({ at: Math.max(Date.now(), (last?.at ?? 0) + 1), ...author && { author: author.name }, verb: saved.verb, data: saved.data, ...saved.body !== undefined && { body: saved.body } })
          await hidden.save!({ slug: placeOf(ref), data: { revisions: revisions.slice(-settings().history!.revisions) } })
        }
        catch (error) {
          log.error(`${ref.collection}/${ref.slug}'s revision could not be kept`, error)
        }
      },
    }
  }
  catch (error) {
    log.error(`${ref.collection}/${ref.slug}'s history could not be read`, error)

    return undefined
  }
}

// Forgets an entry's revisions, once nothing holds the entry any more.
export async function forgetRevisions(ref: EntryRef): Promise<void> {
  try {
    await hiddenOf(ref.collection, 'history')?.remove!({ slug: placeOf(ref) })
  }
  catch (error) {
    log.error(`${ref.collection}/${ref.slug}'s revisions could not be forgotten`, error)
  }
}
