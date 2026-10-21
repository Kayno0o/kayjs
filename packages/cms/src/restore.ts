import type { Identity } from './files'
import type { EntryRef } from './kay/contract'
import type { SaveOutcome } from './store'
import { wording } from 'kay/words'
import { keepingOrder, keepingPublication } from './publishing'
import { revisionAt } from './revisions'
import { collectionNamed, entryOf, refused, saveEntry } from './store'
import { discardTrashed, trashed } from './trash'

// Saves an older version of an entry again, as a new save: the editor's version check, the schema and the hooks all apply. `restrained` is for a role that may not publish, whose restore leaves the draft flag and the dates as the entry has them.
export async function restoreRevision(ref: EntryRef, at: number, author?: Identity, { version, restrained = false }: { version?: string | undefined, restrained?: boolean | undefined } = {}): Promise<SaveOutcome> {
  const revision = await revisionAt(ref, at)

  if (!revision)
    return refused(ref, wording('cms.history.gone', 'That version is not kept any more'))

  const collection = await collectionNamed(ref.collection)
  const existing = await entryOf(ref, collection)

  if (!existing)
    return refused(ref, wording('cms.store.missing', '{slug} does not exist', { slug: ref.slug }), 'slug')

  const data = restrained ? keepingPublication(collection, revision.data, existing.data) : revision.data
  // A move is no save, so a version carries the place the entry had when it was saved, which a restore must not send it back to.
  const placed = collection.orderField === undefined ? data : keepingOrder(collection.orderField, data, existing.data)

  return saveEntry({ ...ref, data: placed, body: revision.body }, { version, required: true, verb: 'restore', author })
}

// Writes a deleted entry back under its slug, refused as a new entry is if the slug was taken since. `restrained` is for a role that may not publish, whose restored entry is a draft, or held back by a far publish date, as a new entry of that role is.
export async function restoreTrashed(collection: string, id: string, author?: Identity, { restrained = false }: { restrained?: boolean | undefined } = {}): Promise<SaveOutcome> {
  // Asked first, so a collection the site lacks is the 404 of the API and not an entry that is gone.
  const info = await collectionNamed(collection)
  const item = await trashed(collection, id)

  if (!item)
    return refused({ collection, slug: id }, wording('cms.trash.gone', 'That entry is not in the trash any more'))

  const kept = restrained ? keepingPublication(info, item.data, undefined) : item.data
  // Its old place may be taken by now, so it comes back without one.
  const data = info.orderField === undefined ? kept : keepingOrder(info.orderField, kept, undefined)
  const outcome = await saveEntry({ collection, slug: item.slug, locale: item.locale, data, body: item.body }, { create: true, verb: 'restore', author, revived: true })

  if ('saved' in outcome)
    await discardTrashed(collection, id)

  return outcome
}
