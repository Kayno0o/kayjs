import type { Commit } from './files'
import type { CollectionInfo, DraftEntry, EntryRef, Issue, SourceEntry } from './kay/contract'
import { collections, entries, entrySource, removeEntry, saveEntry as saveLoaded } from './kay/content'
import { settings } from './settings'

export type SaveOutcome = { issues: Issue[] } | { saved: true, commit?: Commit | undefined }

// Folder slugs become file paths, so they hold words, dashes and `/` between them, never `..` or a leading `/`.
const SLUG = /^[\w-]+(?:\/[\w-]+)*$/

export class UnknownCollection extends Error {}

export async function findCollection(name: string): Promise<CollectionInfo | undefined> {
  return (await collections()).find(collection => collection.name === name)
}

export async function collectionNamed(name: string): Promise<CollectionInfo> {
  const found = await findCollection(name)

  if (!found)
    throw new UnknownCollection(`No collection ${name}`)

  return found
}

export async function entryOf({ collection, slug, locale }: EntryRef): Promise<SourceEntry | undefined> {
  return (await entries(collection, locale === undefined ? {} : { locale })).find(entry => entry.slug === slug)
}

function refused(ref: EntryRef, message: string): SaveOutcome {
  return { issues: [{ collection: ref.collection, slug: ref.slug, locale: ref.locale, path: '', message }] }
}

// Saves an entry where its collection keeps it: a loaded one through its loader, a folder one as a file through the configured saver.
export async function saveEntry(entry: DraftEntry, { create = false, verb }: { create?: boolean | undefined, verb?: string | undefined } = {}): Promise<SaveOutcome> {
  const collection = await collectionNamed(entry.collection)

  if (!SLUG.test(entry.slug))
    return refused(entry, 'A slug holds letters, digits, dashes and underscores, with `/` between folders')

  if (create && await entryOf(entry))
    return refused(entry, `${entry.slug} already exists`)

  if (collection.kind === 'loaded') {
    const { issues } = await saveLoaded(collection.name, { slug: entry.slug, locale: entry.locale, data: entry.data, body: entry.body })

    return issues?.length ? { issues } : { saved: true }
  }

  const source = await entrySource(collection.name, entry.slug, entry.data, { locale: entry.locale, body: entry.body })

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
    await removeEntry(collection.name, ref.slug, ref.locale)

    return { saved: true }
  }

  const existing = await entryOf(ref)

  if (!existing)
    return refused(ref, `${ref.slug} does not exist`)

  // The file's path comes with its text, which kay only gives for data its schema takes.
  const source = await entrySource(collection.name, ref.slug, existing.data, { locale: ref.locale, body: existing.body })

  if ('issues' in source)
    return refused(ref, `${ref.slug} no longer fits its schema, so its file cannot be found to delete; fix it first`)

  const commit = await settings().files.save({ repoPath: source.file.repoPath, absolute: source.file.absolute, text: undefined, message: `content(${collection.name}): delete ${ref.slug}` })

  return { saved: true, commit }
}

// Sets the collection's draft field to false, keeping the rest of the entry as saved.
export async function publishEntry(ref: EntryRef): Promise<SaveOutcome> {
  const collection = await collectionNamed(ref.collection)

  if (collection.draftField === undefined)
    return refused(ref, `${collection.name} names no draft field to publish by`)

  const existing = await entryOf(ref)

  if (!existing)
    return refused(ref, `${ref.slug} does not exist`)

  return saveEntry({ ...ref, data: { ...existing.data, [collection.draftField]: false }, body: existing.body }, { verb: 'publish' })
}
