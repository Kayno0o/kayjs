import type { Commit } from './files'
import type { CollectionInfo, DraftEntry, EntryRef, Issue, SourceEntry } from './kay/contract'
import { collectionInfo, entries, entryFile, entrySource, removeEntry, saveEntry as saveLoaded } from './kay/content'
import { settings } from './settings'

export type SaveOutcome = { issues: Issue[] } | { saved: true, commit?: Commit | undefined }

export class UnknownCollection extends Error {}

export async function findCollection(name: string): Promise<CollectionInfo | undefined> {
  return collectionInfo(name)
}

export async function collectionNamed(name: string): Promise<CollectionInfo> {
  const found = await findCollection(name)

  if (!found)
    throw new UnknownCollection(`No collection ${name}`)

  return found
}

export async function entryOf({ collection, slug, locale }: EntryRef): Promise<SourceEntry | undefined> {
  return (await entries(collection, { slug, locale }))[0]
}

function refused(ref: EntryRef, message: string, key?: Issue['key']): SaveOutcome {
  return { issues: [{ collection: ref.collection, slug: ref.slug, locale: ref.locale, path: '', ...(key === undefined ? {} : { key }), message }] }
}

// Saves an entry where its collection keeps it: a loaded one through its loader, a folder one as a file through the configured saver.
export async function saveEntry(entry: DraftEntry, { create = false, verb }: { create?: boolean | undefined, verb?: string | undefined } = {}): Promise<SaveOutcome> {
  const collection = await collectionNamed(entry.collection)

  if (collection.kind === 'loaded') {
    const { issues } = await saveLoaded(collection.name, { slug: entry.slug, locale: entry.locale, data: entry.data, body: entry.body }, { create })

    return issues?.length ? { issues } : { saved: true }
  }

  const source = await entrySource(collection.name, entry.slug, entry.data, { locale: entry.locale, body: entry.body, create })

  if ('issues' in source)
    return source

  const commit = await settings().files.save({
    repoPath: source.file.repoPath,
    absolute: source.file.absolute,
    text: source.file.text,
    message: `content(${collection.name}): ${verb ?? (create ? 'add' : 'update')} ${entry.slug}`,
  })

  return { saved: true, commit }
}

export async function deleteEntry(ref: EntryRef): Promise<SaveOutcome> {
  const collection = await collectionNamed(ref.collection)

  if (collection.kind === 'loaded') {
    const { issues } = await removeEntry(collection.name, ref.slug, ref.locale)

    return issues?.length ? { issues } : { saved: true }
  }

  if (collection.dir === undefined)
    return refused(ref, `${collection.name}'s folder lies outside the repository, so its files cannot be committed`)

  // kay finds the file whether or not it still parses, so a broken one can be deleted too.
  const found = await entryFile(collection.name, ref.slug, { locale: ref.locale })

  if ('issues' in found)
    return found

  const commit = await settings().files.save({ repoPath: found.file.repoPath, absolute: found.file.absolute, text: undefined, message: `content(${collection.name}): delete ${ref.slug}` })

  return { saved: true, commit }
}

// Sets the collection's draft field to false, keeping the rest of the entry as saved.
export async function publishEntry(ref: EntryRef): Promise<SaveOutcome> {
  const collection = await collectionNamed(ref.collection)

  if (collection.draftField === undefined)
    return refused(ref, `${collection.name} names no draft field to publish by`)

  const existing = await entryOf(ref)

  if (!existing)
    return refused(ref, `${ref.slug} does not exist`, 'slug')

  if (!existing.data)
    return refused(ref, `${ref.slug}'s file does not parse: ${existing.problem}`)

  return saveEntry({ ...ref, data: { ...existing.data, [collection.draftField]: false }, body: existing.body }, { verb: 'publish' })
}
