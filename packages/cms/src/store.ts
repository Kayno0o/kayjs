import type { Commit, FileChange, Identity } from './files'
import type { CollectionInfo, DraftEntry, EntryRef, Issue, StoredEntry } from './kay/contract'
import { fileVersion, ForgeError, SaveConflict } from './files'
import { collectionInfo, entries, entryFile, entrySource, removeEntry, saveEntry as saveLoaded } from './kay/content'
import { log } from './log'
import { settings } from './settings'
import { scriptInBody } from './unsafe'

// `version` is the saved file's, for the next save of a folder entry to name.
// A refusal over another save carries `conflict`, the version the file is at now, null once deleted, which a save writing over it names.
export type SaveOutcome = { issues: Issue[], conflict?: { version: string | null } | undefined } | { saved: true, commit?: Commit | undefined, version?: string | undefined }

// What saving or deleting a folder entry the server holds asks of the editor: an editor sending no version is older than the server, which would write over any save made since it opened the entry.
export interface VersionRule {
  required?: boolean | undefined
}

export class UnknownCollection extends Error {}

export async function findCollection(name: string): Promise<CollectionInfo | undefined> {
  return collectionInfo(name)
}

// The collection with no `body`, `count` or `problem`, which a loaded one's loader is run to tell: for a save, a delete or an upload, which need its kind and its folder alone.
async function bareCollection(name: string): Promise<CollectionInfo | undefined> {
  return collectionInfo(name, { counts: false })
}

export async function collectionNamed(name: string): Promise<CollectionInfo> {
  const found = await bareCollection(name)

  if (!found)
    throw new UnknownCollection(`No collection ${name}`)

  return found
}

// What an entry's screen shows: the collection as findCollection gives it and the entry, read together so a loader that cannot count or give one entry runs once for both.
// Undefined for an unknown collection; `entry` is undefined when the collection fails to read, `problem` then saying why, or when it holds no such entry.
export async function entryScreen(ref: EntryRef): Promise<{ collection: CollectionInfo, entry: StoredEntry | undefined } | undefined> {
  if (!await bareCollection(ref.collection))
    return undefined

  const [collection, entry] = await Promise.allSettled([findCollection(ref.collection), entryOf(ref)])

  if (collection.status === 'rejected')
    throw collection.reason

  if (!collection.value)
    return undefined

  if (entry.status === 'rejected') {
    if (collection.value.problem === undefined)
      throw entry.reason

    return { collection: collection.value, entry: undefined }
  }

  return { collection: collection.value, entry: collection.value.problem === undefined ? entry.value : undefined }
}

export async function entryOf(ref: EntryRef): Promise<StoredEntry | undefined> {
  const entry = (await entries(ref.collection, { slug: ref.slug, locale: ref.locale }))[0]

  if (!entry || entry.path === undefined)
    return entry

  const version = await versionOf(ref)

  return version === undefined ? entry : { ...entry, version }
}

// The version of a folder entry's file as it lies on disk.
async function versionOf(ref: EntryRef): Promise<string | undefined> {
  const found = await entryFile(ref.collection, ref.slug, { locale: ref.locale })

  if ('issues' in found)
    return undefined

  const file = Bun.file(found.file.absolute)

  return await file.exists() ? fileVersion(await file.bytes()) : undefined
}

function refused(ref: EntryRef, message: string, key?: Issue['key'] | 'body'): { issues: Issue[] } {
  const at = key === undefined ? {} : key === 'body' ? { body: true as const } : { key }

  return { issues: [{ collection: ref.collection, slug: ref.slug, locale: ref.locale, path: '', ...at, message }] }
}

// Saves an entry where its collection keeps it: a loaded one through its loader, a folder one as a file through the configured saver.
// `version` is the one the editor opened, so a save made over someone else's is refused; a new entry's file must not exist yet.
export async function saveEntry(entry: DraftEntry, { create = false, version, required = false, verb, author, bodyKept = false }: { create?: boolean | undefined, version?: string | undefined, verb?: string | undefined, author?: Identity | undefined, bodyKept?: boolean | undefined } & VersionRule = {}): Promise<SaveOutcome> {
  const collection = await collectionNamed(entry.collection)

  if (entry.body !== undefined && !bodyKept && !settings().rawHtml.has(collection.name)) {
    const script = await scriptInBody(entry.body)

    if (script !== undefined)
      return refused(entry, `The text holds ${script}, which would run as the site: write it as Markdown, or list ${collection.name} in cms({ rawHtml })`, 'body')
  }

  if (collection.kind === 'loaded') {
    const { issues } = await saveLoaded(collection.name, { slug: entry.slug, locale: entry.locale, data: entry.data, body: entry.body }, { create })

    return issues?.length ? { issues } : { saved: true }
  }

  if (required && !create && version === undefined && await versionOf(entry) !== undefined)
    return unversioned(entry)

  const source = await entrySource(collection.name, entry.slug, entry.data, { locale: entry.locale, body: entry.body, create })

  if ('issues' in source)
    return source

  const committed = await commitChange(entry, {
    repoPath: source.file.repoPath,
    absolute: source.file.absolute,
    text: source.file.text,
    message: `content(${collection.name}): ${verb ?? (create ? 'add' : 'update')} ${entry.slug}`,
    author,
    base: create ? null : version,
  })

  return 'issues' in committed ? committed : { saved: true, commit: committed.commit, version: fileVersion(source.file.text) }
}

export async function deleteEntry(ref: EntryRef, author?: Identity, { version, required = false }: { version?: string | undefined } & VersionRule = {}): Promise<SaveOutcome> {
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

  if (required && version === undefined && await versionOf(ref) !== undefined)
    return unversioned(ref)

  const committed = await commitChange(ref, { repoPath: found.file.repoPath, absolute: found.file.absolute, text: undefined, message: `content(${collection.name}): delete ${ref.slug}`, author, base: version })

  return 'issues' in committed ? committed : { saved: true, commit: committed.commit }
}

// Sets the collection's draft field to false, keeping the rest of the entry as saved.
export async function publishEntry(ref: EntryRef, author?: Identity): Promise<SaveOutcome> {
  const collection = await collectionNamed(ref.collection)

  if (collection.draftField === undefined)
    return refused(ref, `${collection.name} names no draft field to publish by`)

  const existing = await entryOf(ref)

  if (!existing)
    return refused(ref, `${ref.slug} does not exist`, 'slug')

  if (!existing.data)
    return refused(ref, `${ref.slug}'s file does not parse: ${existing.problem}`)

  return saveEntry({ ...ref, data: { ...existing.data, [collection.draftField]: false }, body: existing.body }, { version: existing.version, verb: 'publish', author, bodyKept: true })
}

// Hands a change to the configured saver, turning a conflict or a forge that failed into the issue the editor shows.
async function commitChange(ref: EntryRef, change: FileChange): Promise<{ commit: Commit | undefined } | { issues: Issue[], conflict?: { version: string | null } | undefined }> {
  try {
    return { commit: await settings().files.save(change) }
  }
  catch (error) {
    if (error instanceof SaveConflict)
      return { ...refused(ref, error.message), ...error.creating || error.current === undefined ? {} : { conflict: { version: error.current } } }

    if (!(error instanceof ForgeError))
      throw error

    log.error(`saving ${change.repoPath} failed`, error)

    return refused(ref, error.message)
  }
}

function unversioned(ref: EntryRef): { issues: Issue[] } {
  log.warn(`refused a change to ${ref.collection}/${ref.slug} naming no version, from an editor older than the server`)

  return refused(ref, 'This editor is older than the server: copy your changes, reload the page, then make them again')
}
