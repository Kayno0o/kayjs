import type { Actor } from './authors'
import type { Identity } from './files'
import type { EntryRef, Issue } from './kay/contract'
import type { Review, ReviewView } from './review'
import { notify } from 'kay/server'
import { wording } from 'kay/words'
import { entryPath, entryTitle } from './listing'
import { log } from './log'
import { readReview, reviewable, viewOf, writeReview } from './review'
import { settings } from './settings'
import { collectionNamed, entryOf, publishEntry, refused } from './store'

export type ReviewOutcome = { issues: Issue[] } | { saved: true, review: ReviewView, entry?: { data: Record<string, unknown> | undefined, body: string | undefined, version: string | undefined } | undefined }

// The longest note a send-back carries.
const NOTE_LIMIT = 1000
// A notification's title is at most 200 characters.
const TITLE_LIMIT = 200

function clip(text: string): string {
  return text.length <= TITLE_LIMIT ? text : `${text.slice(0, TITLE_LIMIT - 1)}…`
}

// Tells people something happened, never failing the step it follows: a person with no inbox is skipped and a store that fails is logged.
async function tell(userIds: readonly string[], title: string, ref: EntryRef): Promise<void> {
  const url = entryPath(settings().prefix, ref)

  for (const id of new Set(userIds)) {
    try {
      await notify(id, { title: clip(title), url })
    }
    catch (error) {
      log.error(`${ref.collection}/${ref.slug}'s review could not be notified to ${id}`, error)
    }
  }
}

// An entry that can be reviewed, with its review so far: the collection's and the entry's refusals otherwise.
async function target(ref: EntryRef): Promise<{ issues: Issue[] } | { collection: Awaited<ReturnType<typeof collectionNamed>>, entry: NonNullable<Awaited<ReturnType<typeof entryOf>>>, review: Review | undefined }> {
  const collection = await collectionNamed(ref.collection)

  if (!reviewable(collection))
    return refused(ref, wording('cms.review.unavailable', '{collection} cannot send entries for review: it needs a draft flag, and a loader that keeps a hidden collection', { collection: collection.name }))

  const entry = await entryOf(ref, collection)

  if (!entry)
    return refused(ref, wording('cms.store.missing', '{slug} does not exist', { slug: ref.slug }), 'slug')

  if (!entry.data)
    return refused(ref, wording('cms.store.parseFailure', '{slug}\'s file does not parse: {problem}', { slug: ref.slug, problem: entry.problem ?? '' }))

  return { collection, entry, review: await readReview(ref) }
}

async function keep(ref: EntryRef, review: Review, author: Identity | undefined, verb: string): Promise<{ issues: Issue[] } | undefined> {
  try {
    await writeReview(ref, review, { author, verb })

    return undefined
  }
  catch (error) {
    log.error(`${ref.collection}/${ref.slug}'s review could not be kept`, error)

    return refused(ref, wording('cms.review.failure', 'The review could not be kept: the server\'s log says why'))
  }
}

// Sends a draft for review: its writer waits for a reviewer, who is told. A draft sent back may be sent again.
export async function submitEntry(ref: EntryRef, actor: Actor, author?: Identity): Promise<ReviewOutcome> {
  const found = await target(ref)

  if ('issues' in found)
    return found

  const { collection, entry, review } = found

  if (!entry.draft)
    return refused(ref, wording('cms.review.notDraft', 'Only a draft can be sent for review'))

  if (review?.status === 'review')
    return refused(ref, wording('cms.review.already', '{slug} is in review already', { slug: ref.slug }))

  const next: Review = { status: 'review', by: actor.name, byId: actor.id, events: [...review?.events ?? [], { at: Date.now(), verb: 'submit', by: actor.name }] }
  const failed = await keep(ref, next, author, 'submit')

  if (failed)
    return failed

  await tell(actor.reviewers, wording('cms.review.submitted', '{name} sent {title} for review', { name: actor.name, title: entryTitle(collection, entry) }), ref)

  return { saved: true, review: viewOf(next) }
}

// Publishes an entry in review, or leaves it scheduled at the publish date it holds, and tells its writer.
export async function approveEntry(ref: EntryRef, actor: Actor, author?: Identity): Promise<ReviewOutcome> {
  const found = await target(ref)

  if ('issues' in found)
    return found

  const { collection, entry, review } = found

  if (review?.status !== 'review' || !entry.draft)
    return refused(ref, wording('cms.review.notInReview', '{slug} is not in review', { slug: ref.slug }))

  const published = await publishEntry(ref, author, { reviewed: true })

  if ('issues' in published)
    return published

  const next: Review = { ...review, status: 'approved', events: [...review.events, { at: Date.now(), verb: 'approve', by: actor.name }] }
  const failed = await keep(ref, next, author, 'approve')

  if (failed)
    return failed

  await tell(review.byId === undefined ? [] : [review.byId], wording('cms.review.approved', '{name} approved {title}', { name: actor.name, title: entryTitle(collection, entry) }), ref)

  const after = await entryOf(ref, collection)

  return { saved: true, review: viewOf(next), entry: after && { data: after.data, body: after.body, version: after.version } }
}

// Hands an entry in review back to its writer with a note saying what to change, and tells them.
export async function sendBackEntry(ref: EntryRef, note: string, actor: Actor, author?: Identity): Promise<ReviewOutcome> {
  const said = note.trim()

  if (said === '')
    return refused(ref, wording('cms.review.noteNeeded', 'Say what to change in a note'))

  if (said.length > NOTE_LIMIT)
    return refused(ref, wording('cms.review.noteLong', 'The note is longer than {count} characters', { count: NOTE_LIMIT }))

  const found = await target(ref)

  if ('issues' in found)
    return found

  const { collection, entry, review } = found

  if (review?.status !== 'review')
    return refused(ref, wording('cms.review.notInReview', '{slug} is not in review', { slug: ref.slug }))

  const next: Review = { ...review, status: 'sent-back', events: [...review.events, { at: Date.now(), verb: 'send-back', by: actor.name, note: said }] }
  const failed = await keep(ref, next, author, 'send back')

  if (failed)
    return failed

  await tell(review.byId === undefined ? [] : [review.byId], wording('cms.review.sentBack', '{name} sent {title} back: {note}', { name: actor.name, title: entryTitle(collection, entry), note: said }), ref)

  return { saved: true, review: viewOf(next) }
}
