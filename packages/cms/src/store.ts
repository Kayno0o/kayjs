import type { Commit, FileChange, Identity } from './files'
import type { CollectionInfo, DraftEntry, EntryRef, Issue, StoredEntry } from './kay/contract'
import { wording } from 'kay/words'
import { fileVersion, ForgeError, SaveConflict } from './files'
import { collectionInfo, entries, entryFile, entrySource, removeEntry, saveEntry as saveLoaded } from './kay/content'
import { log } from './log'
import { movable, moveChanges, orderValue, sortOrdered } from './order'
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
    throw new UnknownCollection(wording('cms.store.noCollection', 'No collection {name}', { name }))

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
    // A loader's error may name its database or its credentials, which every editor would see: the log has it, the screen the generic reason.
    if (collection.value.kind === 'loaded') {
      log.error(`${collection.value.name}'s entry failed to read`, entry.reason)

      return { collection: { ...collection.value, problem: wording('cms.store.readFailure', 'kay: {collection}\'s entries failed to read; the server\'s log says why', { collection: collection.value.name }) }, entry: undefined }
    }

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

// The version of a folder entry's file as it lies on disk; undefined for a missing one.
export async function versionOf(ref: EntryRef): Promise<string | undefined> {
  const found = await entryFile(ref.collection, ref.slug, { locale: ref.locale })

  if ('issues' in found)
    return undefined

  const file = Bun.file(found.file.absolute)

  return await file.exists() ? fileVersion(await file.bytes()) : undefined
}

function refused(ref: EntryRef, message: string, key?: Issue['key'] | 'body'): { issues: Issue[] } {
  const at: { key?: Issue['key'], body?: true } = {}

  if (key === 'body')
    at.body = true
  else if (key !== undefined)
    at.key = key

  return { issues: [{ collection: ref.collection, slug: ref.slug, locale: ref.locale, path: '', ...at, message }] }
}

// Saves an entry where its collection keeps it: a loaded one through its loader, a folder one as a file through the configured saver.
// `version` is the one the editor opened, so a save made over someone else's is refused; a new entry's file must not exist yet.
export async function saveEntry(entry: DraftEntry, { create = false, version, required = false, verb, author, bodyKept = false }: { create?: boolean | undefined, version?: string | undefined, verb?: string | undefined, author?: Identity | undefined, bodyKept?: boolean | undefined } & VersionRule = {}): Promise<SaveOutcome> {
  const collection = await collectionNamed(entry.collection)

  if (entry.body !== undefined && !bodyKept && !settings().rawHtml.has(collection.name)) {
    const script = await scriptInBody(entry.body)

    if (script !== undefined)
      return refused(entry, wording('cms.store.script', 'The text holds {script}, which would run as the site: write it as Markdown, or list {collection} in cms({ rawHtml })', { script, collection: collection.name }), 'body')
  }

  if (collection.kind === 'loaded') {
    const { issues } = await saveLoaded(collection.name, { slug: entry.slug, locale: entry.locale, data: entry.data, body: entry.body }, { create })

    return issues !== undefined && issues.length > 0 ? { issues } : { saved: true }
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

    return issues !== undefined && issues.length > 0 ? { issues } : { saved: true }
  }

  if (collection.dir === undefined)
    return refused(ref, wording('cms.store.outside', '{collection}\'s folder lies outside the repository, so its files cannot be committed', { collection: collection.name }))

  // kay finds the file whether or not it still parses, so a broken one can be deleted too.
  const found = await entryFile(collection.name, ref.slug, { locale: ref.locale })

  if ('issues' in found)
    return found

  if (required && version === undefined && await versionOf(ref) !== undefined)
    return unversioned(ref, true)

  const committed = await commitChange(ref, { repoPath: found.file.repoPath, absolute: found.file.absolute, text: undefined, message: `content(${collection.name}): delete ${ref.slug}`, author, base: version })

  return 'issues' in committed ? committed : { saved: true, commit: committed.commit }
}

// Sets the collection's draft field to false, keeping the rest of the entry as saved.
export async function publishEntry(ref: EntryRef, author?: Identity): Promise<SaveOutcome> {
  const collection = await collectionNamed(ref.collection)

  if (collection.draftField === undefined)
    return refused(ref, wording('cms.store.noDraftField', '{collection} names no draft field to publish by', { collection: collection.name }))

  const existing = await entryOf(ref)

  if (!existing)
    return refused(ref, wording('cms.store.missing', '{slug} does not exist', { slug: ref.slug }), 'slug')

  if (!existing.data)
    return refused(ref, wording('cms.store.parseFailure', '{slug}\'s file does not parse: {problem}', { slug: ref.slug, problem: existing.problem ?? '' }))

  return saveEntry({ ...ref, data: { ...existing.data, [collection.draftField]: false }, body: existing.body }, { version: existing.version, verb: 'publish', author, bodyKept: true })
}

// Moves an entry one place up or down in its collection's order, among the entries of its locale, by saving the `order` field of the one or the few entries that change; saving stops at the first that is refused.
export async function moveEntry(ref: EntryRef, direction: 'up' | 'down', author?: Identity): Promise<SaveOutcome> {
  const collection = await collectionNamed(ref.collection)
  const field = collection.orderField

  if (field === undefined)
    return refused(ref, wording('cms.store.noOrderField', '{collection} names no order field to move entries by', { collection: collection.name }))

  const group = sortOrdered(movable(await entries(collection.name, { locale: ref.locale }), ref.locale), field)
  const changes = moveChanges(group.map(entry => ({ slug: entry.slug, value: orderValue(entry, field) })), ref.slug, direction)

  if (changes === undefined)
    return group.some(entry => entry.slug === ref.slug) ? { saved: true } : refused(ref, wording('cms.store.missing', '{slug} does not exist', { slug: ref.slug }), 'slug')

  let outcome: SaveOutcome = { saved: true }

  for (const change of changes) {
    const entry = group.find(each => each.slug === change.slug)!
    const target = { collection: collection.name, slug: entry.slug, locale: entry.locale }
    const version = collection.kind === 'loaded' ? undefined : await versionOf(target)

    outcome = await saveEntry({ ...target, data: { ...entry.data, [field]: change.value }, body: entry.body }, { version, verb: 'move', author, bodyKept: true })

    if ('issues' in outcome)
      return outcome
  }

  return outcome
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

// A delete naming none comes from an editor older than the server, or from one keeping its edits over a file deleted and made again since, which it never showed.
function unversioned(ref: EntryRef, deleting = false): { issues: Issue[] } {
  log.warn(`refused a change to ${ref.collection}/${ref.slug} naming no version, from an editor older than the server`)

  return refused(ref, deleting ? wording('cms.store.staleDelete', 'This editor has not shown the file as it is now, so it will not delete it: reload the page to see it, then delete again') : wording('cms.store.staleSave', 'This editor is older than the server: copy your changes, reload the page, then make them again'))
}
