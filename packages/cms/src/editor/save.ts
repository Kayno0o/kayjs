import type { Drafts } from '../drafts'
import type { EntryRef, Issue } from '../kay/contract'
import { attempt, toast } from '@kaynooo/kayjs-ui'
import { call } from 'kay'
import entriesApi from '../api/entries'

type Outcome = { issues: Issue[] } | { saved: true, commit?: unknown }

// Saves an entry's draft, under the slug and locale a new entry was given, and says how it went; true once saved.
export async function saveDraft(drafts: Drafts, ref: EntryRef, { slug = ref.slug, locale = ref.locale, create = false }: { slug?: string, locale?: string | undefined, create?: boolean } = {}): Promise<boolean> {
  const entry = drafts.entry(ref)

  if (!entry)
    return false

  const outcome = await attempt(() => call(entriesApi, '/:collection/:slug', {
    method: 'post',
    params: { collection: ref.collection, slug },
    body: { data: entry.data, create, ...localeOf({ ...ref, locale }), ...(entry.body === undefined ? {} : { body: entry.body }) },
  }), 'Could not save')

  if (outcome && 'issues' in outcome) {
    // A new entry's issues name the slug it was saved under, not the one its draft is kept by.
    drafts.report(outcome.issues.map(issue => ({ ...issue, collection: ref.collection, slug: ref.slug, locale: ref.locale })))
    toast.error('Not saved: some fields need fixing')

    return false
  }

  if (!settled(outcome, 'Saved', 'Not saved'))
    return false

  drafts.markSaved(ref)
  drafts.report([])

  return true
}

// Deletes a saved entry and says how it went; true once deleted.
export async function deleteSaved(ref: EntryRef): Promise<boolean> {
  const outcome = await attempt(() => call(entriesApi, '/:collection/:slug', {
    method: 'delete',
    params: { collection: ref.collection, slug: ref.slug },
    query: localeOf(ref),
  }), 'Could not delete')

  return settled(outcome, 'Deleted', 'Not deleted')
}

// Turns a draft entry public and says how it went; true once published.
export async function publishSaved(ref: EntryRef): Promise<boolean> {
  const outcome = await attempt(() => call(entriesApi, '/:collection/:slug/publish', {
    method: 'post',
    params: { collection: ref.collection, slug: ref.slug },
    query: localeOf(ref),
  }), 'Could not publish')

  return settled(outcome, 'Published', 'Not published')
}

function localeOf({ locale }: EntryRef): { locale?: string } {
  return locale === undefined ? {} : { locale }
}

// Toasts how a change the server answered went; `attempt` already toasted a failed call.
function settled(outcome: Outcome | undefined, done: string, refused: string): boolean {
  if (!outcome)
    return false

  if ('issues' in outcome) {
    toast.error(`${refused}: ${outcome.issues.map(issue => issue.message).join('; ')}`)

    return false
  }

  // A commit shows on the site once it has rebuilt from it.
  toast.success(outcome.commit ? `${done}. The site shows it once it has rebuilt.` : done)

  return true
}
