import type { Identity } from './files'
import type { EntryRef } from './kay/contract'
import { hiddenOf, rowOf } from './hidden'
import { entries } from './kay/content'
import { log } from './log'
import { forgetRevisions } from './revisions'
import { settings } from './settings'

// An entry deleted from a loaded collection, kept until `cms({ history: { trash } })` runs out. `id` names it for a restore.
export interface Trashed {
  id: string
  at: number
  author?: string | undefined
  slug: string
  locale?: string | undefined
  data: Record<string, unknown>
  body?: string | undefined
}

interface Row {
  at: number
  author?: string
  slug: string
  locale?: string
  data: Record<string, unknown>
  body?: string
}

function trashedOf(id: string, row: Row): Trashed {
  return { id, at: row.at, author: row.author, slug: row.slug, locale: row.locale, data: row.data, body: row.body }
}

// Drops what has been in the trash longer than it is kept, with the history of an entry that was never made again. Never throws.
async function purge(collection: string): Promise<void> {
  const trash = hiddenOf(collection, 'trash')
  const kept = settings().history?.trash

  if (trash === undefined || kept === undefined)
    return

  try {
    const rows = await trash.load({ preview: true })
    const expired = rows.filter(row => (row.data as Row).at < Date.now() - kept)
    const staying = rows.filter(row => !expired.includes(row))

    for (const row of expired) {
      const { slug, locale } = row.data as Row

      await trash.remove!({ slug: row.slug })

      // A newer deleted entry under the same slug still needs the history.
      if (staying.some(other => (other.data as Row).slug === slug && (other.data as Row).locale === locale))
        continue

      if ((await entries(collection, { slug, locale })).length === 0)
        await forgetRevisions({ collection, slug, locale })
    }
  }
  catch (error) {
    log.error(`${collection}'s trash could not be emptied of what expired`, error)
  }
}

// Every entry in the collection's trash, newest first, after dropping what expired; none for a collection that keeps no trash.
export async function trashOf(collection: string): Promise<Trashed[]> {
  const trash = hiddenOf(collection, 'trash')

  if (trash === undefined)
    return []

  await purge(collection)

  return (await trash.load({ preview: true })).map(row => trashedOf(row.slug, row.data as Row)).sort((a, b) => b.at - a.at)
}

export async function trashed(collection: string, id: string): Promise<Trashed | undefined> {
  const trash = hiddenOf(collection, 'trash')
  const row = trash && await rowOf(trash, id)

  return row ? trashedOf(id, row.data as Row) : undefined
}

// A deleted entry's place in the trash. Returns the id it was kept under, or undefined when the collection keeps no trash or the trash could not be written, which is logged and never stops the delete.
export async function keepDeleted(ref: EntryRef, entry: { data: Record<string, unknown>, body?: string | undefined }, author: Identity | undefined): Promise<string | undefined> {
  const trash = hiddenOf(ref.collection, 'trash')

  if (trash === undefined)
    return undefined

  try {
    let at = Date.now()

    while (await rowOf(trash, String(at)))
      at++

    const row: Row = { at, ...author && { author: author.name }, slug: ref.slug, ...ref.locale !== undefined && { locale: ref.locale }, data: entry.data, ...entry.body !== undefined && { body: entry.body } }

    await trash.save!({ slug: String(at), data: row })

    return String(at)
  }
  catch (error) {
    log.error(`${ref.collection}/${ref.slug} could not be kept in the trash`, error)

    return undefined
  }
}

// Takes an entry out of the trash.
export async function discardTrashed(collection: string, id: string): Promise<void> {
  try {
    await hiddenOf(collection, 'trash')?.remove!({ slug: id })
  }
  catch (error) {
    log.error(`${collection}'s trash entry ${id} could not be removed`, error)
  }
}
