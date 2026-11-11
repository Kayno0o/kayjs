import type { ContentLoader } from 'kay/content'
import type { Identity } from './files'
import type { CollectionInfo, EntryRef } from './kay/contract'
import { mkdir, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { repositoryRoot } from 'kay/content'
import { wording } from 'kay/words'
import { fileVersion } from './files'
import { rowOf } from './hidden'
import { collectionLoader } from './kay/content'
import { log } from './log'
import { placeOf } from './revisions'
import { settings } from './settings'

// What a draft is waiting for: a reviewer (`review`), the writer after a send-back (`sent-back`), or nothing once approved or published (`approved`, kept for the log).
export type ReviewStatus = 'review' | 'sent-back' | 'approved'

// One step of an entry's review. `publish` is a publisher publishing the entry while it was in review.
export interface ReviewEvent {
  at: number
  verb: 'submit' | 'approve' | 'send-back' | 'publish'
  by?: string | undefined
  note?: string | undefined
}

export interface Review {
  status: ReviewStatus
  // Who submitted the entry, by name and, for a kayjs-auth user, id: the id is where the answer is notified and never leaves the server.
  by?: string | undefined
  byId?: string | undefined
  // The version of the entry the reviewer is asked to look at, which an approval must still find.
  version?: string | undefined
  events: ReviewEvent[]
}

// What a screen is given of a review: the id of the person is left out. `own` is set when the signed-in person sent the draft and `cms({ fourEyes })` keeps them from approving it, `unnamed` when it keeps them because the guard names no one.
export type ReviewView = Omit<Review, 'byId' | 'events'> & { events: ReviewEventView[], own?: true, unnamed?: true }

// A step of a review as a screen reads it, `at` in milliseconds becoming a `Date`.
export type ReviewEventView = Omit<ReviewEvent, 'at'> & { doneAt: Date }

// Who is looking at a review or acting on it, as far as the guard knows them.
export interface Viewer {
  id?: string | undefined
  name: string
}

// Whether a person is the one who sent a draft for review: by kayjs-auth id when both have one, else by name, which a person with none is never matched on.
export function sentBy(review: Review, viewer: Viewer | undefined): boolean {
  if (viewer === undefined)
    return false

  if (review.byId !== undefined || viewer.id !== undefined)
    return review.byId === viewer.id

  return identified(viewer) && review.by === viewer.name
}

// Whether a person can be told from another: they have a kayjs-auth id, or a name that is not the placeholder.
function identified(viewer: Viewer | undefined): boolean {
  return viewer !== undefined && (viewer.id !== undefined || (viewer.name !== '' && viewer.name !== wording('cms.review.someone', 'Someone')))
}

// Why `cms({ fourEyes })` keeps this person from approving the entry in review: they sent it, or the guard names no one, so nothing says they did not.
export function approvalBarred(review: Review, viewer: Viewer | undefined): 'own' | 'unnamed' | undefined {
  if (!settings().fourEyes || review.status !== 'review')
    return undefined

  if (!identified(viewer))
    return 'unnamed'

  return sentBy(review, viewer) ? 'own' : undefined
}

// The events kept per entry, the oldest going first.
const KEPT_EVENTS = 50

const STATUSES: ReadonlySet<string> = new Set(['review', 'sent-back', 'approved'])
const VERBS: ReadonlySet<string> = new Set(['submit', 'approve', 'send-back', 'publish'])

// The place a review file is for, undefined for a name that is not an encoded one.
function placeNamed(name: string): string | undefined {
  try {
    return decodeURIComponent(name.slice(0, -'.json'.length))
  }
  catch {
    return undefined
  }
}

async function namesIn(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  }
  catch {
    return []
  }
}

async function jsonOf(file: string): Promise<unknown> {
  try {
    return await Bun.file(file).json()
  }
  catch {
    return undefined
  }
}

export function viewOf(review: Review, viewer?: Viewer): ReviewView {
  return { status: review.status, ...review.by !== undefined && { by: review.by }, events: review.events.map(({ at, ...event }) => ({ ...event, doneAt: new Date(at) })), ...approvalBarred(review, viewer) === 'own' && { own: true as const }, ...approvalBarred(review, viewer) === 'unnamed' && { unnamed: true as const } }
}

// A stored value as a review, undefined for anything else.
function parse(data: unknown): Review | undefined {
  if (typeof data !== 'object' || data === null)
    return undefined

  const { status, by, byId, version, events } = data as Record<string, unknown>

  if (typeof status !== 'string' || !STATUSES.has(status) || !Array.isArray(events))
    return undefined

  const kept = events.filter((event): event is ReviewEvent => typeof event === 'object' && event !== null && typeof (event as ReviewEvent).at === 'number' && VERBS.has((event as ReviewEvent).verb))

  return { status: status as ReviewStatus, ...typeof by === 'string' && { by }, ...typeof byId === 'string' && { byId }, ...typeof version === 'string' && { version }, events: kept }
}

// The hidden `review` collection beside a loaded collection's entries, written through its own loader; undefined for a loader that gives no `sibling`. It is kept whether or not `cms({ history })` is on.
const siblings = new WeakMap<ContentLoader, ContentLoader>()

function storeOf(collection: string): ContentLoader | undefined {
  const loader = collectionLoader(collection)

  if (loader?.sibling === undefined)
    return undefined

  let sibling = siblings.get(loader)

  if (sibling === undefined) {
    sibling = loader.sibling('review')
    siblings.set(loader, sibling)
  }

  return sibling
}

// Whether the collection's entries can be sent for review: it has a draft flag to hold them back by, and somewhere to keep the state, a hidden collection of its loader or the repository for a folder.
export function reviewable(collection: Pick<CollectionInfo, 'kind' | 'name' | 'draftField'>): boolean {
  if (collection.draftField === undefined)
    return false

  if (collection.kind === 'folder')
    return true

  const store = storeOf(collection.name)

  return store?.save !== undefined && store.remove !== undefined
}

// A name with no separator and no dot, so no collection or slug reaches outside `.cms/review`.
const encoded = (name: string) => encodeURIComponent(name).replaceAll('.', '%2E')
const directory = (collection: string) => join(repositoryRoot(), '.cms', 'review', encoded(collection))
const fileName = (place: string) => `${encoded(place)}.json`

// The version of a review file as its saver takes it, null when there is none.
async function versionOf(absolute: string): Promise<string | null> {
  try {
    return fileVersion(await Bun.file(absolute).bytes())
  }
  catch {
    return null
  }
}

// A collection with no loader is a folder's.
function isFolder(collection: string): boolean {
  return collectionLoader(collection) === undefined
}

export async function readReview(ref: EntryRef): Promise<Review | undefined> {
  try {
    const place = placeOf(ref)

    if (isFolder(ref.collection)) {
      const file = Bun.file(join(directory(ref.collection), fileName(place)))

      return await file.exists() ? parse(await file.json()) : undefined
    }

    const store = storeOf(ref.collection)

    return store === undefined ? undefined : parse((await rowOf(store, place))?.data)
  }
  catch (error) {
    log.error(`${ref.collection}/${ref.slug}'s review could not be read`, error)

    return undefined
  }
}

// Every review of a collection by the place of its entry (the slug, the locale before it in a localized collection); empty when it cannot be read.
export async function reviewsOf(collection: string): Promise<Map<string, Review>> {
  const found = new Map<string, Review>()

  try {
    if (isFolder(collection)) {
      const dir = directory(collection)
      const names = await namesIn(dir)

      for (const name of names.filter(file => file.endsWith('.json'))) {
        const review = parse(await jsonOf(join(dir, name)))
        const place = placeNamed(name)

        if (review && place !== undefined)
          found.set(place, review)
      }

      return found
    }

    for (const row of await storeOf(collection)?.load({ preview: true }) ?? []) {
      const review = parse(row.data)

      if (review)
        found.set(row.slug, review)
    }
  }
  catch (error) {
    log.error(`${collection}'s reviews could not be read`, error)
  }

  return found
}

// Rewrites each review of a loaded collection's store that `change` alters, reading its row again first as a save may have changed it since the listing; a review it turns into `undefined` is removed. Returns how many rows changed. A folder's reviews are files of the repository, which this does not rewrite.
async function amendReviews(collection: string, change: (review: Review) => Review | undefined): Promise<number> {
  const store = storeOf(collection)

  if (store?.save === undefined || store.remove === undefined)
    return 0

  let changed = 0

  for (const row of await store.load({ preview: true })) {
    const listed = parse(row.data)

    if (listed === undefined || JSON.stringify(change(listed)) === JSON.stringify(listed))
      continue

    const current = parse((await rowOf(store, row.slug))?.data)
    const amended = current && change(current)

    if (current === undefined || JSON.stringify(amended) === JSON.stringify(current))
      continue

    if (amended === undefined)
      await store.remove({ slug: row.slug })
    else
      await store.save({ slug: row.slug, data: amended })

    changed++
  }

  return changed
}

// Drops the steps of a collection's reviews older than `cutoff`, as the activity log is pruned, and the review of an entry left with none once it is approved. A review still waiting keeps its status.
export async function pruneReviews(collection: string, cutoff: number): Promise<number> {
  return amendReviews(collection, (review) => {
    const events = review.events.filter(event => event.at >= cutoff)

    return events.length === 0 && review.status === 'approved' ? undefined : { ...review, events }
  })
}

// Replaces an editor's name in a collection's reviews, who sent a draft and who took each step, and drops the id of the sender it was matched to.
export async function forgetReviewer(collection: string, name: string, replacement: string): Promise<number> {
  return amendReviews(collection, (review) => {
    if (review.by !== name && !review.events.some(event => event.by === name))
      return review

    const { byId, ...rest } = review

    return {
      ...rest,
      ...review.by === name ? { by: replacement } : { ...byId !== undefined && { byId } },
      events: review.events.map(event => event.by === name ? { ...event, by: replacement } : event),
    }
  })
}

// Writes the review of an entry, or removes it for `undefined`. Throws when the state cannot be written, which the caller answers with.
export async function writeReview(ref: EntryRef, review: Review | undefined, { author, verb = 'review' }: { author?: Identity | undefined, verb?: string } = {}): Promise<void> {
  const place = placeOf(ref)
  const kept = review && { ...review, events: review.events.slice(-KEPT_EVENTS) }

  if (isFolder(ref.collection)) {
    const dir = directory(ref.collection)
    const absolute = join(dir, fileName(place))

    if (kept === undefined && !await Bun.file(absolute).exists())
      return

    const base = await versionOf(absolute)

    await mkdir(dir, { recursive: true })
    await settings().files.save({
      base,
      repoPath: relative(repositoryRoot(), absolute).split('\\').join('/'),
      absolute,
      text: kept === undefined ? undefined : `${JSON.stringify(kept, null, 2)}\n`,
      message: `content(${ref.collection}): ${verb} ${ref.slug}`,
      author,
    })

    return
  }

  const store = storeOf(ref.collection)

  if (store === undefined)
    throw new Error(`${ref.collection} keeps no review: its loader gives no sibling`)

  if (kept === undefined)
    await store.remove!({ slug: place })
  else
    await store.save!({ slug: place, data: kept })
}

// Forgets the review of an entry that is gone; never throws, as the delete is written.
export async function forgetReview(ref: EntryRef, author?: Identity): Promise<void> {
  try {
    if (await readReview(ref) !== undefined)
      await writeReview(ref, undefined, { author, verb: 'delete' })
  }
  catch (error) {
    log.error(`${ref.collection}/${ref.slug}'s review could not be forgotten`, error)
  }
}

// Moves the review of a renamed entry to its new slug; never throws, as the rename is written.
export async function moveReview(from: EntryRef, to: EntryRef, author?: Identity): Promise<void> {
  try {
    const review = await readReview(from)

    if (review === undefined)
      return

    await writeReview(to, review, { author, verb: 'rename' })
    await writeReview(from, undefined, { author, verb: 'rename' })
  }
  catch (error) {
    log.error(`${from.collection}/${from.slug}'s review could not be moved to ${to.slug}`, error)
  }
}

// An entry published while it waited for review is no longer waiting: the review ends, with the publication in its log. Never throws, as the save is written.
export async function settleReview(ref: EntryRef, author?: Identity): Promise<void> {
  try {
    const review = await readReview(ref)

    if (review === undefined || review.status === 'approved')
      return

    await writeReview(ref, { ...review, status: 'approved', events: [...review.events, { at: Date.now(), verb: 'publish', by: author?.name }] }, { author, verb: 'publish' })
  }
  catch (error) {
    log.error(`${ref.collection}/${ref.slug}'s review could not be settled`, error)
  }
}
