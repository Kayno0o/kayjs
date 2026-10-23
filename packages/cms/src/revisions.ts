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

// Drops the revisions of every entry of a collection that are older than `cutoff`, always keeping the newest of an entry; the entry as it stood before its first recorded save counts as old as the revision after it. Never throws; false when it failed.
// Given the `places` that can hold revisions, it reads only their indexes, not every row the history holds, and finds no revision left out of an index; without them it reads every row, which finds those too.
export async function pruneRevisions(collection: string, cutoff: number, places?: readonly string[]): Promise<boolean> {
  const hidden = hiddenOf(collection, 'history')

  if (hidden === undefined)
    return true

  try {
    const rows = places === undefined ? await hidden.load({ preview: true }) : undefined
    // Revision rows are keyed below their entry's, and carry no index.
    const indexed = rows === undefined ? places! : rows.filter(row => !row.slug.includes('\u0001') && Array.isArray((row.data as Index | undefined)?.ats)).map(row => row.slug)
    const listed = new Map<string, number[]>()

    for (const slug of indexed) {
      // Read again, as a save may have added a revision since the rows were listed.
      const ats = await indexOf(hidden, slug)

      listed.set(slug, ats)

      const newest = ats.at(-1)
      const old = ats.filter((at, position) => at !== newest && (at === 0 ? ats[position + 1]! : at) < cutoff)

      if (old.length === 0)
        continue

      await hidden.save!({ slug, data: { ats: ats.filter(at => !old.includes(at)) } satisfies Index })

      for (const at of old)
        await hidden.remove!({ slug: revisionPlace(slug, at) })

      listed.set(slug, ats.filter(at => !old.includes(at)))
    }

    // A revision a concurrent save left out of its index, or a crash before the removal, would never be listed nor swept.
    for (const row of rows ?? []) {
      const [place, at] = row.slug.split('\u0001')
      const index = place === undefined ? undefined : listed.get(place)

      if (at !== undefined && index !== undefined && !index.includes(Number(at)) && Number(at) < cutoff)
        await hidden.remove!({ slug: row.slug })
    }

    return true
  }
  catch (error) {
    log.error(`${collection}'s old revisions could not be dropped`, error)

    return false
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

// Moves an entry's revisions to the slug it was renamed to, replacing any the new slug held; never throws, as the rename is written.
export async function moveRevisions(from: EntryRef, to: EntryRef): Promise<void> {
  const hidden = hiddenOf(from.collection, 'history')

  if (hidden === undefined)
    return

  const place = placeOf(from)
  const target = placeOf(to)

  try {
    const ats = await indexOf(hidden, place)
    const writes: { slug: string, data: unknown, body?: string | undefined }[] = []
    const kept: number[] = []

    for (const at of ats) {
      const row = await rowOf(hidden, revisionPlace(place, at))

      if (row) {
        kept.push(at)
        writes.push({ slug: revisionPlace(target, at), data: withSlug(row.data as Stored, to.slug), body: row.body })
      }
    }

    // What an earlier entry of that slug left is replaced, as a new entry starts its history over.
    await forgetRevisions(to)

    if (kept.length === 0)
      return

    writes.push({ slug: target, data: { ats: kept } satisfies Index })

    if (hidden.saveMany) {
      await hidden.saveMany(writes)
    }
    else {
      for (const write of writes)
        await hidden.save!(write)
    }

    await forgetRevisions(from)
  }
  catch (error) {
    log.error(`${from.collection}/${from.slug}'s revisions could not be moved to ${to.slug}`, error)
  }
}

// A revision as it was saved, its `slug` field, if the entry has one, naming the new slug so restoring it does not bring the old one back.
function withSlug(stored: Stored, slug: string): Stored {
  return typeof stored.data.slug === 'string' ? { ...stored, data: { ...stored.data, slug } } : stored
}
