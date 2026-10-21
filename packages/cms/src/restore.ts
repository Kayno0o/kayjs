import type { Identity } from './files'
import type { EntryRef } from './kay/contract'
import type { SaveOutcome } from './store'
import { wording } from 'kay/words'
import { keepingPublication } from './publishing'
import { revisionsOf } from './revisions'
import { collectionNamed, entryOf, refused, saveEntry } from './store'

// Saves an older version of an entry again, as a new save: the editor's version check, the schema and the hooks all apply. `restrained` is for a role that may not publish, whose restore leaves the draft flag and the dates as the entry has them.
export async function restoreRevision(ref: EntryRef, at: number, author?: Identity, { version, restrained = false }: { version?: string | undefined, restrained?: boolean | undefined } = {}): Promise<SaveOutcome> {
  const revision = (await revisionsOf(ref)).find(each => each.at === at)

  if (!revision)
    return refused(ref, wording('cms.history.gone', 'That version is not kept any more'))

  const collection = await collectionNamed(ref.collection)
  const existing = await entryOf(ref, collection)

  if (!existing)
    return refused(ref, wording('cms.store.missing', '{slug} does not exist', { slug: ref.slug }), 'slug')

  const data = restrained ? keepingPublication(collection, revision.data, existing.data) : revision.data

  return saveEntry({ ...ref, data, body: revision.body }, { version, required: true, verb: 'restore', author })
}
