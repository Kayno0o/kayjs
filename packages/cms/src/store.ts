import type { Commit, FileChange, FileMove, Identity } from './files'
import type { CollectionInfo, DraftEntry, EntryRef, Issue, JsonSchema, ScreenCollection, SourceEntry, StoredEntry } from './kay/contract'
import type { SaveEvent } from './settings'
import { redirectMovedPage } from 'kay/library'
import { wording } from 'kay/words'
import { forgetCounts } from './counts'
import { publishTime } from './datetime'
import { fieldsOf } from './fields'
import { fileVersion, ForgeError, SaveConflict } from './files'
import { hiddenOf } from './hidden'
import { collectionInfo, entries, entryFile, entryPage, entrySource, removeEntry, saveEntry as saveLoaded, saveEntries as saveLoadedMany } from './kay/content'
import { collectionTitle, rowsOf, SINGLE_SLUG } from './listing'
import { log } from './log'
import { movable, moveChanges, orderValue, sortOrdered } from './order'
import { missingReferences, pointReferences, referrersWith, UnreadReferrers } from './references'
import { moveRevisions, openTrail } from './revisions'
import { settings } from './settings'
import { pairKey } from './translations'
import { discardTrashed, keepDeleted } from './trash'
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
  const given = settings().layouts.get(name)

  const kept = found?.kind === 'loaded'
  const history = kept && hiddenOf(name, 'history') !== undefined ? { history: true as const } : {}
  const trash = kept && hiddenOf(name, 'trash') !== undefined ? { trash: true as const } : {}

  // Without the icon, which the content list draws on the server and the editor's islands would otherwise carry with each page.
  return found && { ...found, ...given && { layout: { group: given.group, order: given.order, form: given.form, list: given.list } }, ...history, ...trash }
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

export function refused(ref: EntryRef, message: string, key?: Issue['key'] | 'body'): { issues: Issue[] } {
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

// The longest the editor waits for `cms({ onSave })`, which runs before the save answers.
const SAVE_HOOK_LIMIT_MS = 10_000
let hookLimit = SAVE_HOOK_LIMIT_MS

// For tests, which cannot wait ten seconds; not for apps. No argument restores the limit.
export function setSaveHookLimit(ms = SAVE_HOOK_LIMIT_MS): void {
  hookLimit = ms
}

// Tells `cms({ onSave })` of a change that went through; its failure or a hook still running past the limit is logged, as the change is written.
async function saved(event: SaveEvent): Promise<void> {
  const hook = settings().onSave

  if (hook === undefined)
    return

  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    // A hook given up on may still fail later, which is logged as well.
    const running = (async () => {
      try {
        await hook(event)
      }
      catch (error) {
        log.error(`onSave failed for ${event.collection}/${event.slug}`, error)
      }

      return 'done' as const
    })()
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(resolve, hookLimit, 'late')
    })

    if (await Promise.race([running, late]) === 'late')
      log.error(`onSave for ${event.collection}/${event.slug} did not finish in ${hookLimit / 1000} s; the save does not wait for it`)
  }
  finally {
    clearTimeout(timer)
  }
}

// Saves an entry where its collection keeps it: a loaded one through its loader, a folder one as a file through the configured saver.
// `version` is the one the editor opened, so a save made over someone else's is refused; a new entry's file must not exist yet.
export async function saveEntry(entry: DraftEntry, options: SaveOptions = {}): Promise<SaveOutcome> {
  let outcome: SaveOutcome

  try {
    outcome = await writeEntry(entry, options)
  }
  finally {
    forgetCounts()
  }

  if ('saved' in outcome)
    await saved({ collection: entry.collection, slug: entry.slug, ...entry.locale !== undefined && { locale: entry.locale }, verb: options.verb ?? (options.create === true ? 'add' : 'update'), ...options.author !== undefined && { author: options.author }, ...outcome.commit !== undefined && { commit: outcome.commit } })

  return outcome
}

interface SaveOptions extends VersionRule {
  create?: boolean | undefined
  version?: string | undefined
  verb?: SaveEvent['verb'] | undefined
  author?: Identity | undefined
  bodyKept?: boolean | undefined
  heldData?: Record<string, unknown> | undefined
  // A new entry that is an old one coming back, whose history goes on rather than starting over.
  revived?: boolean | undefined
}

async function writeEntry(entry: DraftEntry, { create = false, version, required = false, verb, author, bodyKept = false, heldData, revived = false }: SaveOptions): Promise<SaveOutcome> {
  const collection = await collectionNamed(entry.collection)

  if (entry.body !== undefined && !bodyKept && !settings().rawHtml.has(collection.name)) {
    const script = await scriptInBody(entry.body)

    if (script !== undefined)
      return refused(entry, wording('cms.store.script', 'The text holds {script}, which would run as the site: write it as Markdown, or list {collection} in cms({ rawHtml })', { script, collection: collection.name }), 'body')
  }

  const dangling = await missingReferences(collection, entry, async () => heldData ?? (await entries(collection.name, { slug: entry.slug, locale: entry.locale }))[0]?.data)

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

      const trail = await openTrail(entry, create ? undefined : async () => storedState((await entries(collection.name, { slug: entry.slug, locale: entry.locale }))[0]), { fresh: create && !revived })
      const { issues } = await saveLoaded(collection.name, { slug: entry.slug, locale: entry.locale, data: entry.data, body: entry.body }, { create })

      if (issues !== undefined && issues.length > 0)
        return { issues }

      // The entry as the loader holds it now, defaults filled in, which is what the history compares the entry with and the next save names.
      const after = trail || versioned ? await readAfter(entry, collection.name) : undefined

      await trail?.record({ ...storedState(after) ?? { data: entry.data, body: entry.body }, verb: verb ?? (create ? 'add' : 'update') }, author)

      return versioned ? { saved: true, version: after && contentVersion(after, collection.schema) } : { saved: true }
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

export async function deleteEntry(ref: EntryRef, author?: Identity, options: { version?: string | undefined } & VersionRule = {}): Promise<SaveOutcome> {
  let outcome: SaveOutcome

  try {
    outcome = await removeOne(ref, author, options)
  }
  finally {
    forgetCounts()
  }

  if ('saved' in outcome)
    await saved({ collection: ref.collection, slug: ref.slug, ...ref.locale !== undefined && { locale: ref.locale }, verb: 'delete', ...author !== undefined && { author }, ...outcome.commit !== undefined && { commit: outcome.commit } })

  return outcome
}

async function removeOne(ref: EntryRef, author: Identity | undefined, { version, required = false }: { version?: string | undefined } & VersionRule): Promise<SaveOutcome> {
  const collection = await collectionNamed(ref.collection)

  if (collection.single)
    return refused(ref, wording('cms.store.singleDelete', '{collection} holds one entry, which cannot be deleted', { collection: collectionTitle(collection) }))

  if (collection.kind === 'loaded') {
    return inTurn(collection.name, async () => {
      const stale = required || version !== undefined ? await staleLoaded(ref, collection.schema, version, required, true) : undefined

      if (stale)
        return stale

      const kept = hiddenOf(collection.name, 'trash') && storedState((await entries(collection.name, { slug: ref.slug, locale: ref.locale }))[0])
      const id = kept ? await keepDeleted(ref, kept, author) : undefined
      let removal: Awaited<ReturnType<typeof removeEntry>>

      try {
        removal = await removeEntry(collection.name, ref.slug, ref.locale)
      }
      catch (error) {
        if (id !== undefined)
          await discardTrashed(collection.name, id)

        throw error
      }

      const { issues } = removal

      if (issues !== undefined && issues.length > 0) {
        if (id !== undefined)
          await discardTrashed(collection.name, id)

        return { issues }
      }

      return { saved: true }
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

function storedState(entry: SourceEntry | undefined): { data: Record<string, unknown>, body?: string | undefined } | undefined {
  return entry?.data === undefined ? undefined : { data: entry.data, body: entry.body }
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

// The most entries a reference picker lists; a collection past it is typed as a slug, which a save still checks.
export const REFERENCE_CHOICES = 1000

export interface ReferenceChoice {
  slug: string
  title: string
}

// The entries of a collection a reference can name, by title, one per slug whatever its locales; the entries that do not parse are left out.
export async function referenceChoices(name: string): Promise<{ choices: ReferenceChoice[], complete: boolean }> {
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

  return choices.length > REFERENCE_CHOICES ? { choices: [], complete: false } : { choices, complete: true }
}

// The slug a copy of `slug` is written under: `<slug>-copy`, then `-copy-2`, `-copy-3`, the first that is free.
export function copySlug(slug: string, taken: ReadonlySet<string>): string {
  let copy = `${slug}-copy`

  for (let n = 2; taken.has(copy); n++)
    copy = `${slug}-copy-${n}`

  return copy
}

// The date a copy of a scheduled-only entry waits for until an editor picks one: it has no draft field to hide behind, and a copy dated in the past or undated would show on the site at once.
const HELD_UNTIL = '9999-12-31T00:00:00.000Z'

// The publish date that holds a new entry back in a collection with no draft flag, in the format its publish field takes.
export function heldDate(collection: Pick<CollectionInfo, 'schema' | 'publishField'>): string {
  const field = fieldsOf(collection.schema).find(each => each.key === collection.publishField)

  return field?.kind === 'date' ? HELD_UNTIL.slice(0, 10) : HELD_UNTIL
}

// The data a copy starts with: a draft when the collection has a draft field, else held back by its publish date; last in the order, not alongside the original.
function copyData(collection: CollectionInfo, data: Record<string, unknown>, siblings: SourceEntry[]): Record<string, unknown> {
  const copy = { ...data }
  const { draftField, publishField, orderField } = collection

  if (draftField !== undefined) {
    copy[draftField] = true
  }
  else if (publishField !== undefined && !((publishTime(collection, data) ?? 0) > Date.now())) {
    copy[publishField] = heldDate(collection)
  }

  if (orderField !== undefined) {
    const values = siblings.map(entry => orderValue(entry, orderField)).filter(value => value !== undefined)

    if (values.length > 0)
      copy[orderField] = Math.max(...values) + 1
    else
      delete copy[orderField]
  }

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

  const siblings = await entries(collection.name, { locale: ref.locale })
  const slug = copySlug(ref.slug, new Set(siblings.map(entry => entry.slug)))
  const data = copyData(collection, existing.data, siblings)
  const outcome = await saveEntry({ collection: collection.name, slug, locale: ref.locale, data, body: existing.body }, { create: true, verb: 'duplicate', author, bodyKept: true, heldData: existing.data })

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

    const moved = await inTurn<SaveOutcome>(collection.name, async () => {
      const { issues } = await saveLoadedMany(collection.name, written)

      return issues !== undefined && issues.length > 0 ? { issues } : { saved: true }
    })

    if ('saved' in moved) {
      // Together, so a hook that hangs holds the editor for one limit and not one per entry.
      await Promise.all(written.map(async entry => saved({ collection: collection.name, slug: entry.slug, ...entry.locale !== undefined && { locale: entry.locale }, verb: 'move', ...author !== undefined && { author } })))
    }

    return moved
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

// The most entries named in the refusal of a rename.
const REFERRERS_NAMED = 3

// An entry naming the renamed one, with the data it takes once it names the new slug.
interface Pointing {
  collection: CollectionInfo
  ref: EntryRef
  label: string
  data: Record<string, unknown>
  body: string | undefined
  // The version it was read at, for the save to name.
  version: string | undefined
  // Whether it can be saved from here: a folder outside the repository cannot be committed to, nor one whose version cannot be read be saved without a base.
  savable: boolean
}

// Whether an entry naming the old slug follows the rename. A localized collection's entry names the entry of its own locale, so only that locale's follow; one with no locale names the entry by its slug whichever the locale, so it follows unless another locale still holds the old slug.
function follows(collection: CollectionInfo, renamed: EntryRef, locale: string | undefined, otherLocaleHolds: boolean): boolean {
  if (!collection.localized)
    return true

  return locale === undefined ? !otherLocaleHolds : locale === renamed.locale
}

// The entries to point at the new slug, each read again with the version it is at, so a save made since is never written over.
async function pointings(collection: CollectionInfo, ref: EntryRef, slug: string): Promise<Pointing[]> {
  const found = (await referrersWith(collection.name, [ref.slug], { strict: true })).get(ref.slug) ?? []

  if (found.length === 0)
    return []

  const otherLocaleHolds = collection.localized === true && (await entries(collection.name, { slug: ref.slug })).some(each => each.locale !== ref.locale)
  const result: Pointing[] = []

  for (const { collection: holder, entry, label } of found) {
    if (!follows(collection, ref, entry.locale, otherLocaleHolds))
      continue

    const at = { collection: holder.name, slug: entry.slug, locale: entry.locale }

    if (holder.kind === 'folder' && holder.dir === undefined) {
      const outside = entry.data && pointReferences(holder, entry.data, collection.name, ref.slug, slug)

      if (outside)
        result.push({ collection: holder, ref: at, label, data: outside, body: undefined, version: undefined, savable: false })

      continue
    }

    const version = holder.kind === 'loaded' ? undefined : await versionOf(at)
    const now = await entryOf(at, holder)
    const data = now?.data && pointReferences(holder, now.data, collection.name, ref.slug, slug)

    if (data) {
      const read = version ?? now.version

      result.push({ collection: holder, ref: at, label, data, body: now.body, version: read, savable: holder.kind === 'loaded' || read !== undefined })
    }
  }

  return result
}

// Renames an entry's slug: a folder entry's file is moved, a loaded entry is saved under the new slug and removed from the old with its history kept, the entries naming it point at the new slug, and the page it had redirects to the page it has, without the app writing anything.
// Refused when the new slug is taken, the collection holds one entry, the saver cannot move files, or an entry naming this one cannot be saved. `version` is the one the editor opened. `unpointed` names the entries naming this one that could not be saved after it.
export async function renameEntry(ref: EntryRef, slug: string, options: { author?: Identity | undefined, version?: string | undefined } & VersionRule = {}): Promise<SaveOutcome & { slug?: string, unpointed?: string[] }> {
  let outcome: Awaited<ReturnType<typeof renameOne>>

  try {
    outcome = await renameOne(ref, slug, options)
  }
  finally {
    forgetCounts()
  }

  if (!('saved' in outcome))
    return outcome

  await saved({ collection: ref.collection, slug, ...ref.locale !== undefined && { locale: ref.locale }, verb: 'rename', from: ref.slug, ...options.author !== undefined && { author: options.author }, ...outcome.commit !== undefined && { commit: outcome.commit } })

  return { ...outcome, slug }
}

async function renameOne(ref: EntryRef, slug: string, { author, version, required = false }: { author?: Identity | undefined, version?: string | undefined } & VersionRule): Promise<SaveOutcome & { unpointed?: string[] }> {
  const collection = await collectionNamed(ref.collection)

  if (collection.single)
    return refused(ref, wording('cms.store.singleRename', '{collection} holds one entry, which cannot be renamed', { collection: collectionTitle(collection) }))

  const existing = await entryOf(ref, collection)

  if (!existing)
    return refused(ref, wording('cms.store.missing', '{slug} does not exist', { slug: ref.slug }), 'slug')

  if (!existing.data)
    return refused(ref, wording('cms.store.parseFailure', '{slug}\'s file does not parse: {problem}', { slug: ref.slug, problem: existing.problem ?? '' }))

  if (slug === ref.slug)
    return refused(ref, wording('cms.store.sameSlug', '{slug} is the slug already', { slug }), 'slug')

  const target = { ...ref, slug }
  const keepPairing = await pairingKey(collection, existing)
  const data = renamedData(collection, existing.data, ref.slug, slug, keepPairing)
  let plan: Pointing[]

  try {
    plan = await pointings(collection, ref, slug)
  }
  catch (error) {
    if (!(error instanceof UnreadReferrers))
      throw error

    const unread = error.names.length === 0 ? wording('cms.store.renameUnlisted', 'The collections could not be read to find the entries naming {slug}, so it was not renamed: try again', { slug: ref.slug }) : wording('cms.store.renameUnread', '{names} could not be read to find the entries naming {slug}, so it was not renamed: try again', { slug: ref.slug, names: error.names.join(', ') })

    return refused(target, unread, 'slug')
  }

  // An entry that cannot be saved from here cannot be pointed at the new slug.
  const unsavable = plan.filter(each => !each.savable).map(each => each.label)

  if (unsavable.length > 0)
    return refused(target, wording('cms.store.renameReferred', '{slug} is referred to by {names}, which cannot be saved here: change them to name the new slug first', { slug: ref.slug, names: unsavable.slice(0, REFERRERS_NAMED).join(', ') + (unsavable.length > REFERRERS_NAMED ? ', ...' : '') }), 'slug')

  const together = collection.kind === 'folder' && settings().files.together === true
  const joined = together ? await joinedFiles(plan) : []
  const moved = collection.kind === 'loaded' ? await renameLoaded(collection, existing, target, { version, required, keepPairing }) : await renameFile(collection, existing, target, data, { author, version, required, also: joined.map(each => each.change) })

  if (!('saved' in moved))
    return moved

  await pointRedirect(existing, target, data)

  const apart = plan.filter(each => !joined.some(done => done.pointing === each))
  const unpointed: string[] = []

  for (const each of apart) {
    const outcome = await saveEntry({ ...each.ref, data: each.data, body: each.body }, { version: each.version, verb: 'update', author, bodyKept: true })

    if (!('saved' in outcome))
      unpointed.push(each.label)
  }

  for (const { pointing } of joined)
    await saved({ collection: pointing.ref.collection, slug: pointing.ref.slug, ...pointing.ref.locale !== undefined && { locale: pointing.ref.locale }, verb: 'update', ...author !== undefined && { author }, ...moved.commit !== undefined && { commit: moved.commit } })

  if (unpointed.length > 0)
    log.warn(`${ref.collection}/${ref.slug} was renamed to ${slug}, but ${unpointed.join(', ')} could not be pointed at it`)

  return unpointed.length > 0 ? { ...moved, unpointed } : moved
}

// The files of the entries to point, to commit with the move; one whose new data the collection refuses is left to be saved on its own, which says why.
async function joinedFiles(plan: Pointing[]): Promise<{ pointing: Pointing, change: FileChange & { text: string } }[]> {
  const files: { pointing: Pointing, change: FileChange & { text: string } }[] = []

  for (const pointing of plan) {
    if (pointing.collection.kind !== 'folder' || pointing.version === undefined)
      continue

    const source = await entrySource(pointing.ref.collection, pointing.ref.slug, pointing.data, { locale: pointing.ref.locale, body: pointing.body })

    if ('issues' in source)
      continue

    files.push({ pointing, change: { repoPath: source.file.repoPath, absolute: source.file.absolute, text: source.file.text, message: `content(${pointing.ref.collection}): update ${pointing.ref.slug}`, base: pointing.version } })
  }

  return files
}

// The `translationKey` to write so the entry's translations stay paired once its slug changes: set when they pair with it by its slug and the collection gives entries a `translationKey` field.
async function pairingKey(collection: CollectionInfo, existing: StoredEntry): Promise<string | undefined> {
  if (collection.localized !== true || collection.schema.properties?.translationKey === undefined || pairKey(existing) !== existing.slug)
    return undefined

  const paired = (await entries(collection.name, {})).some(each => each.locale !== existing.locale && pairKey(each) === existing.slug)

  return paired ? existing.slug : undefined
}

// The entry's data under its new slug: the `slug` field of its own, if it has one, following, so do its references to itself, and the `translationKey` its translations pair it by when `pairing` gives one.
function renamedData(collection: CollectionInfo, data: Record<string, unknown>, from: string, slug: string, pairing: string | undefined): Record<string, unknown> {
  const own = typeof data.slug === 'string' ? { ...data, slug } : data
  const pointing = pointReferences(collection, own, collection.name, from, slug) ?? own

  return pairing === undefined ? pointing : { ...pointing, translationKey: pairing }
}

async function renameFile(collection: CollectionInfo, existing: StoredEntry, target: EntryRef, data: Record<string, unknown>, { author, version, required, also }: { author?: Identity | undefined, version?: string | undefined, also: (FileChange & { text: string })[] } & VersionRule): Promise<SaveOutcome> {
  const ref = { collection: collection.name, slug: existing.slug, locale: existing.locale }

  if (collection.dir === undefined)
    return refused(ref, wording('cms.store.outside', '{collection}\'s folder lies outside the repository, so its files cannot be committed', { collection: collection.name }))

  const saver = settings().files
  const { move } = saver

  if (move === undefined)
    return refused(ref, wording('cms.store.noMove', 'The saver of this site cannot rename files'))

  if (required && version === undefined && existing.version !== undefined)
    return unversioned(ref)

  const from = await entryFile(collection.name, ref.slug, { locale: ref.locale })

  if ('issues' in from)
    return from

  const source = await entrySource(collection.name, target.slug, data, { locale: ref.locale, body: existing.body, create: true, replacing: ref.slug })

  if ('issues' in source)
    return source

  const change: FileMove = {
    from: { repoPath: from.file.repoPath, absolute: from.file.absolute },
    to: { repoPath: source.file.repoPath, absolute: source.file.absolute },
    text: source.file.text,
    message: `content(${collection.name}): rename ${ref.slug} to ${target.slug}`,
    author,
    base: version,
    ...also.length > 0 && { also },
  }

  try {
    return { saved: true, commit: await saver.move!(change), version: fileVersion(source.file.text) }
  }
  catch (error) {
    // An entry naming this one was saved since it was read: the rename is tried again.
    if (error instanceof SaveConflict && error.at !== undefined)
      return refused(target, wording('cms.store.renameStale', 'An entry naming {slug} was saved while it was renamed: try again', { slug: existing.slug }), 'slug')

    if (error instanceof SaveConflict)
      return { ...refused(target, error.message), ...error.creating || error.current === undefined ? {} : { conflict: { version: error.current } } }

    if (!(error instanceof ForgeError))
      throw error

    log.error(`renaming ${change.from.repoPath} failed`, error)

    return refused(target, error.message)
  }
}

async function renameLoaded(collection: CollectionInfo, existing: StoredEntry, target: EntryRef, { version, required = false, keepPairing }: { version?: string | undefined, keepPairing: string | undefined } & VersionRule): Promise<SaveOutcome> {
  const ref = { collection: collection.name, slug: existing.slug, locale: existing.locale }

  return inTurn(collection.name, async () => {
    const stale = required || version !== undefined ? await staleLoaded(ref, collection.schema, version, required) : undefined

    if (stale)
      return stale

    // Read again in the turn, so a save made since the entry was first read is not written over.
    const current = storedState((await entries(collection.name, { slug: ref.slug, locale: ref.locale }))[0])

    if (current === undefined)
      return refused(ref, wording('cms.store.missing', '{slug} does not exist', { slug: ref.slug }), 'slug')

    const { issues: refusedNew } = await saveLoaded(collection.name, { slug: target.slug, locale: target.locale, data: renamedData(collection, current.data, ref.slug, target.slug, keepPairing), body: current.body }, { create: true, replacing: ref.slug })

    if (refusedNew !== undefined && refusedNew.length > 0)
      return { issues: refusedNew }

    // The entry is not deleted, so it does not go to the trash: it is the same entry under another slug.
    let removal: Awaited<ReturnType<typeof removeEntry>>

    try {
      removal = await removeEntry(collection.name, ref.slug, ref.locale)
    }
    catch (error) {
      await takeBack(target)

      throw error
    }

    if (removal.issues !== undefined && removal.issues.length > 0) {
      await takeBack(target)

      return { issues: removal.issues }
    }

    await moveRevisions(ref, target)

    const after = await readAfter(target, collection.name)

    return { saved: true, version: after && contentVersion(after, collection.schema) }
  })
}

// Removes the entry a rename wrote under its new slug, once the old could not be removed.
async function takeBack(target: EntryRef): Promise<void> {
  try {
    await removeEntry(target.collection, target.slug, target.locale)
  }
  catch (error) {
    log.error(`${target.collection}/${target.slug} could not be taken back after its rename failed`, error)
  }
}

// Redirects the page the entry had to the page it has, which a site without that page, or a redirect refused for its paths, goes without: the rename stays.
async function pointRedirect(existing: StoredEntry, target: EntryRef, data: Record<string, unknown>): Promise<void> {
  try {
    redirectMovedPage(existing.url, await entryPage(target.collection, { slug: target.slug, locale: target.locale, data }))
  }
  catch (error) {
    log.warn(`${existing.slug}'s page could not be redirected to ${target.slug}'s`, error)
  }
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

// A loaded entry as its loader gives it after a save; undefined when the loader cannot be read again, which the save does not fail for.
async function readAfter(ref: EntryRef, collection: string): Promise<SourceEntry | undefined> {
  try {
    return (await entries(collection, { slug: ref.slug, locale: ref.locale }))[0]
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
