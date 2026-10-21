import type { ContentLoader } from 'kay/content'
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

type Version = Pick<Revision, 'data' | 'body'>

// The key of an entry in its collection: the slug, with the locale before it in a localized collection.
export function placeOf({ slug, locale }: Pick<EntryRef, 'slug' | 'locale'>): string {
  return locale === undefined ? slug : `${locale}/${slug}`
}

// An entry's history is a row of the times its revisions were made, oldest first, and a row per revision, so a save reads and writes one copy of the entry however many are kept.
interface Index {
  ats?: number[]
}

interface Stored {
  verb: string
  author?: string
  data: Record<string, unknown>
}

function revisionPlace(place: string, at: number): string {
  return `${place}\u0001${at}`
}

async function indexOf(hidden: ContentLoader, place: string): Promise<number[]> {
  const { ats } = (await rowOf(hidden, place))?.data as Index | undefined ?? {}

  return Array.isArray(ats) ? ats : []
}

async function readRevision(hidden: ContentLoader, place: string, at: number): Promise<Revision | undefined> {
  const row = await rowOf(hidden, revisionPlace(place, at))

  if (!row)
    return undefined

  const { verb, author, data } = row.data as Stored

  return { at, verb, ...author !== undefined && { author }, data, ...row.body !== undefined && { body: row.body } }
}

// The revisions of an entry, oldest first; none for a collection that keeps no history.
export async function revisionsOf(ref: EntryRef): Promise<Revision[]> {
  const hidden = hiddenOf(ref.collection, 'history')

  if (hidden === undefined)
    return []

  const place = placeOf(ref)

  return (await Promise.all((await indexOf(hidden, place)).map(async at => readRevision(hidden, place, at)))).filter(revision => revision !== undefined)
}

export async function revisionAt(ref: EntryRef, at: number): Promise<Revision | undefined> {
  const hidden = hiddenOf(ref.collection, 'history')

  return hidden && readRevision(hidden, placeOf(ref), at)
}

function sameContent(a: Version, b: Version): boolean {
  return Bun.deepEquals(a.data, b.data) && (a.body ?? '') === (b.body ?? '')
}

// What an entry's history holds before a save, to write the save after it.
export interface Trail {
  record: (saved: Version & { verb: string }, author: Identity | undefined) => Promise<void>
}

interface TrailOptions {
  // Starts the history over, for a new entry whose slug an earlier entry held.
  fresh?: boolean | undefined
}

// Reads the history of an entry about to be saved; undefined for a collection that keeps none, or when the history cannot be read, which is logged and never stops the save. `current` reads the entry as it stands, which an entry with no history yet keeps as its first revision, as the history would otherwise never show it.
export async function openTrail(ref: EntryRef, current: (() => Promise<Version | undefined>) | undefined, { fresh = false }: TrailOptions = {}): Promise<Trail | undefined> {
  const hidden = hiddenOf(ref.collection, 'history')

  if (hidden === undefined)
    return undefined

  const place = placeOf(ref)

  try {
    const earlier = await indexOf(hidden, place)
    const kept = fresh ? [] : earlier
    const newest = kept.at(-1)
    const original = newest === undefined && !fresh && current ? await current() : undefined
    const last = newest === undefined ? original : await readRevision(hidden, place, newest)

    return {
      // Never throws, for the same reason.
      record: async (saved, author) => {
        try {
          if (last && sameContent(last, saved))
            return

          const ats = [...kept]
          const writes: { slug: string, data: unknown, body?: string | undefined }[] = []

          if (original) {
            ats.push(0)
            writes.push({ slug: revisionPlace(place, 0), data: { verb: 'original', data: original.data } satisfies Stored, body: original.body })
          }

          const at = Math.max(Date.now(), (ats.at(-1) ?? 0) + 1)

          ats.push(at)
          writes.push({ slug: revisionPlace(place, at), data: { verb: saved.verb, ...author && { author: author.name }, data: saved.data } satisfies Stored, body: saved.body })

          const pruned = ats.splice(0, Math.max(0, ats.length - settings().history!.revisions))
          // A fresh start may reuse the millisecond of an old revision, whose row the new one has just replaced.
          const gone = [...fresh ? earlier : [], ...pruned].filter(old => !ats.includes(old))

          writes.push({ slug: place, data: { ats } satisfies Index })

          if (hidden.saveMany) {
            await hidden.saveMany(writes)
          }
          else {
            for (const write of writes)
              await hidden.save!(write)
          }

          for (const old of gone)
            await hidden.remove!({ slug: revisionPlace(place, old) })
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
  const hidden = hiddenOf(ref.collection, 'history')
  const place = placeOf(ref)

  try {
    if (hidden === undefined)
      return

    for (const at of await indexOf(hidden, place))
      await hidden.remove!({ slug: revisionPlace(place, at) })

    await hidden.remove!({ slug: place })
  }
  catch (error) {
    log.error(`${ref.collection}/${ref.slug}'s revisions could not be forgotten`, error)
  }
}
