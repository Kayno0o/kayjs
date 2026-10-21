import type { Commit, FileChange, Identity } from './files'
import type { CollectionInfo, DraftEntry, EntryRef, Issue, JsonSchema, ScreenCollection, StoredEntry } from './kay/contract'
import { wording } from 'kay/words'
import { fileVersion, ForgeError, SaveConflict } from './files'
import { collectionInfo, entries, entryFile, entrySource, removeEntry, saveEntry as saveLoaded, saveEntries as saveLoadedMany } from './kay/content'
import { collectionTitle, rowsOf, SINGLE_SLUG } from './listing'
import { log } from './log'
import { movable, moveChanges, orderValue, sortOrdered } from './order'
import { missingReferences } from './references'
import { settings } from './settings'
import { scriptInBody } from './unsafe'
import { contentVersion } from './version'

// `version` is the saved file's, for the next save of a folder entry to name.
// A refusal over another save carries `conflict`, the version the file is at now, null once deleted, which a save writing over it names.
export type SaveOutcome = { issues: Issue[], conflict?: { version: string | null } | undefined } | { saved: true, commit?: Commit | undefined, version?: string | undefined }

// What saving or deleting a folder entry the server holds asks of the editor: an editor sending no version is older than the server, which would write over any save made since it opened the entry.
export interface VersionRule {
  required?: boolean | undefined
}

export class UnknownCollection extends Error {}

// The collection as the screens read it, with the layout `cms({ collections })` gave it.
export async function findCollection(name: string): Promise<ScreenCollection | undefined> {
  const found = await collectionInfo(name)
  const layout = settings().layouts.get(name)

  return found && layout ? { ...found, layout } : found
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
export async function entryScreen(ref: EntryRef): Promise<{ collection: ScreenCollection, entry: StoredEntry | undefined } | undefined> {
  const bare = await bareCollection(ref.collection)

  if (!bare)
    return undefined

  const [collection, entry] = await Promise.allSettled([findCollection(ref.collection), entryOf(ref, bare)])

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

// `kind` is the collection's when the caller has it, else it is read.
export async function entryOf(ref: EntryRef, bare?: CollectionInfo): Promise<StoredEntry | undefined> {
  const entry = (await entries(ref.collection, { slug: ref.slug, locale: ref.locale }))[0]

  if (!entry)
    return entry

  // A loaded entry has no file: its version is a hash of what its loader gave. A folder entry outside the repository has no path either, and no version.
  if (entry.path === undefined) {
    const collection = bare ?? await bareCollection(ref.collection)

    return collection?.kind === 'loaded' ? { ...entry, version: contentVersion(entry, collection.schema) } : entry
  }

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

// What a new entry of a single collection is refused for: the collection holds its entry already, or the slug is not the one the first is written under.
async function singleRefusal(entry: DraftEntry, collection: CollectionInfo): Promise<{ issues: Issue[] } | undefined> {
  if (!collection.single)
    return undefined

  if ((await entries(collection.name, { limit: 1 })).length > 0)
    return refused(entry, wording('cms.store.singleExists', '{collection} holds one entry, which is written already', { collection: collectionTitle(collection) }))

  return entry.slug === SINGLE_SLUG ? undefined : refused(entry, wording('cms.store.singleSlug', '{collection} holds one entry, written as {slug}', { collection: collectionTitle(collection), slug: SINGLE_SLUG }))
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

  const dangling = await missingReferences(collection, entry, async () => (await entries(collection.name, { slug: entry.slug, locale: entry.locale }))[0]?.data)

  if (dangling.length > 0)
    return { issues: dangling }

  if (collection.kind === 'loaded') {
    const versioned = required || version !== undefined

    return inTurn(collection.name, async () => {
      const single = create ? await singleRefusal(entry, collection) : undefined

      if (single)
        return single

      const stale = versioned && !create ? await staleLoaded(entry, collection.schema, version, required) : undefined

      if (stale)
        return stale

      const { issues } = await saveLoaded(collection.name, { slug: entry.slug, locale: entry.locale, data: entry.data, body: entry.body }, { create })

      if (issues !== undefined && issues.length > 0)
        return { issues }

      return versioned ? { saved: true, version: await loadedVersion(entry, collection.schema) } : { saved: true }
    })
  }

  const single = create ? await singleRefusal(entry, collection) : undefined

  if (single)
    return single

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

  if (collection.single)
    return refused(ref, wording('cms.store.singleDelete', '{collection} holds one entry, which cannot be deleted', { collection: collectionTitle(collection) }))

  if (collection.kind === 'loaded') {
    return inTurn(collection.name, async () => {
      const stale = required || version !== undefined ? await staleLoaded(ref, collection.schema, version, required, true) : undefined

      if (stale)
        return stale

      const { issues } = await removeEntry(collection.name, ref.slug, ref.locale)

      return issues !== undefined && issues.length > 0 ? { issues } : { saved: true }
    })
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

  const existing = await entryOf(ref, collection)

  if (!existing)
    return refused(ref, wording('cms.store.missing', '{slug} does not exist', { slug: ref.slug }), 'slug')

  if (!existing.data)
    return refused(ref, wording('cms.store.parseFailure', '{slug}\'s file does not parse: {problem}', { slug: ref.slug, problem: existing.problem ?? '' }))

  return saveEntry({ ...ref, data: { ...existing.data, [collection.draftField]: false }, body: existing.body }, { version: existing.version, verb: 'publish', author, bodyKept: true })
}

// Turns a published entry back into a draft, the way Publish turns a draft public.
export async function unpublishEntry(ref: EntryRef, author?: Identity): Promise<SaveOutcome> {
  const collection = await collectionNamed(ref.collection)

  if (collection.draftField === undefined)
    return refused(ref, wording('cms.store.noDraftField', '{collection} names no draft field to publish by', { collection: collection.name }))

  const existing = await entryOf(ref, collection)

  if (!existing)
    return refused(ref, wording('cms.store.missing', '{slug} does not exist', { slug: ref.slug }), 'slug')

  if (!existing.data)
    return refused(ref, wording('cms.store.parseFailure', '{slug}\'s file does not parse: {problem}', { slug: ref.slug, problem: existing.problem ?? '' }))

  return saveEntry({ ...ref, data: { ...existing.data, [collection.draftField]: true }, body: existing.body }, { version: existing.version, verb: 'unpublish', author, bodyKept: true })
}

// The most entries a reference picker lists; a collection past it keeps the typed slug, which a save still checks.
export const REFERENCE_CHOICES = 1000

export interface ReferenceChoice {
  slug: string
  title: string
}

// The entries of a collection a reference can name, by title, one per slug whatever its locales; the entries that do not parse are left out.
export async function referenceChoices(name: string): Promise<ReferenceChoice[]> {
  const collection = await collectionNamed(name)
  const found = (await entries(name, {})).filter(entry => entry.data !== undefined)
  const seen = new Set<string>()
  const choices: ReferenceChoice[] = []

  for (const row of rowsOf(collection, found)) {
    if (seen.has(row.slug))
      continue

    seen.add(row.slug)
    choices.push({ slug: row.slug, title: row.title })
  }

  return choices.slice(0, REFERENCE_CHOICES)
}

// The slug a copy of `slug` is written under: `<slug>-copy`, then `-copy-2`, `-copy-3`, the first that is free.
export function copySlug(slug: string, taken: ReadonlySet<string>): string {
  let copy = `${slug}-copy`

  for (let n = 2; taken.has(copy); n++)
    copy = `${slug}-copy-${n}`

  return copy
}

// Saves a copy of an entry as a draft, when the collection has a draft field, under a free slug; the outcome names the slug.
export async function duplicateEntry(ref: EntryRef, author?: Identity): Promise<SaveOutcome & { slug?: string }> {
  const collection = await collectionNamed(ref.collection)

  if (collection.single)
    return refused(ref, wording('cms.store.singleDuplicate', '{collection} holds one entry, which cannot be duplicated', { collection: collectionTitle(collection) }))

  const existing = await entryOf(ref, collection)

  if (!existing)
    return refused(ref, wording('cms.store.missing', '{slug} does not exist', { slug: ref.slug }), 'slug')

  if (!existing.data)
    return refused(ref, wording('cms.store.parseFailure', '{slug}\'s file does not parse: {problem}', { slug: ref.slug, problem: existing.problem ?? '' }))

  const taken = new Set((await entries(collection.name, { locale: ref.locale })).map(entry => entry.slug))
  const slug = copySlug(ref.slug, taken)
  const data = collection.draftField === undefined ? existing.data : { ...existing.data, [collection.draftField]: true }
  const outcome = await saveEntry({ collection: collection.name, slug, locale: ref.locale, data, body: existing.body }, { create: true, verb: 'duplicate', author, bodyKept: true })

  return 'issues' in outcome ? outcome : { ...outcome, slug }
}

// Moves an entry one place up or down in its collection's order, among the entries of its locale, by saving the `order` field of the one or the few entries that change: a loaded collection's as one write, a folder's file by file, stopping at the first that is refused.
export async function moveEntry(ref: EntryRef, direction: 'up' | 'down', author?: Identity): Promise<SaveOutcome> {
  const collection = await collectionNamed(ref.collection)
  const field = collection.orderField

  if (field === undefined)
    return refused(ref, wording('cms.store.noOrderField', '{collection} names no order field to move entries by', { collection: collection.name }))

  const group = sortOrdered(movable(await entries(collection.name, { locale: ref.locale }), ref.locale), field)
  const changes = moveChanges(group.map(entry => ({ slug: entry.slug, value: orderValue(entry, field) })), ref.slug, direction)

  if (changes === undefined)
    return group.some(entry => entry.slug === ref.slug) ? { saved: true } : refused(ref, wording('cms.store.missing', '{slug} does not exist', { slug: ref.slug }), 'slug')

  if (collection.kind === 'loaded') {
    const written = changes.map((change) => {
      const entry = group.find(each => each.slug === change.slug)!

      return { slug: entry.slug, locale: entry.locale, data: { ...entry.data, [field]: change.value }, body: entry.body }
    })

    return inTurn(collection.name, async () => {
      const { issues } = await saveLoadedMany(collection.name, written)

      return issues !== undefined && issues.length > 0 ? { issues } : { saved: true }
    })
  }

  let outcome: SaveOutcome = { saved: true }

  for (const change of changes) {
    const entry = group.find(each => each.slug === change.slug)!
    const target = { collection: collection.name, slug: entry.slug, locale: entry.locale }
    const version = await versionOf(target)

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

const turns = new Map<string, Promise<unknown>>()

// Runs the check, the write and the re-read of a loaded entry's save or delete one after another per collection, so a second editor's check never lands between another's write and its re-read.
async function inTurn<T>(collection: string, run: () => Promise<T>): Promise<T> {
  const previous = turns.get(collection) ?? Promise.resolve()
  const turn = (async () => {
    await previous

    return run()
  })()
  const tail = (async () => {
    try {
      await turn
    }
    catch {}
  })()

  turns.set(collection, tail)

  try {
    return await turn
  }
  finally {
    if (turns.get(collection) === tail)
      turns.delete(collection)
  }
}

// What a loaded entry is at now, as its loader gives it: undefined once it holds none.
async function currentLoaded(ref: EntryRef, schema: JsonSchema): Promise<string | undefined> {
  const found = (await entries(ref.collection, { slug: ref.slug, locale: ref.locale }))[0]

  return found === undefined ? undefined : contentVersion(found, schema)
}

// The version a save leaves a loaded entry at, for the editor's next save to name; none when the loader cannot be read again, which the save does not fail for.
async function loadedVersion(ref: EntryRef, schema: JsonSchema): Promise<string | undefined> {
  try {
    return await currentLoaded(ref, schema)
  }
  catch (error) {
    log.error(`${ref.collection}/${ref.slug} failed to read after its save`, error)

    return undefined
  }
}

// Refuses a save or a delete of a loaded entry made over a change of it since the editor opened it, by another editor or by the app: the loader keeps no version, so the editor names the hash of the entry it showed.
async function staleLoaded(ref: EntryRef, schema: JsonSchema, version: string | undefined, required: boolean, deleting = false): Promise<{ issues: Issue[], conflict?: { version: string | null } | undefined } | undefined> {
  const current = await currentLoaded(ref, schema)

  if (version === undefined)
    return required && current !== undefined ? unversioned(ref, deleting) : undefined

  if (version === (current ?? null))
    return undefined

  return { ...refused(ref, wording('cms.store.changed', 'This entry was changed since you opened it, by another editor or by the app')), conflict: { version: current ?? null } }
}

// A delete naming none comes from an editor older than the server, or from one keeping its edits over a file deleted and made again since, which it never showed.
function unversioned(ref: EntryRef, deleting = false): { issues: Issue[] } {
  log.warn(`refused a change to ${ref.collection}/${ref.slug} naming no version, from an editor older than the server`)

  return refused(ref, deleting ? wording('cms.store.staleDelete', 'This editor has not shown the file as it is now, so it will not delete it: reload the page to see it, then delete again') : wording('cms.store.staleSave', 'This editor is older than the server: copy your changes, reload the page, then make them again'))
}
