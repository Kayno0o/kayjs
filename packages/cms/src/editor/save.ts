import type { Drafts } from '../drafts'
import type { EntryRef, Issue } from '../kay/contract'
import { attempt, toast } from '@kaynooo/kayjs-ui'
import { call } from 'kay'
import entriesApi from '../api/entries'
import filesApi from '../api/files'
import { entryKey } from '../markers'

type Outcome = { issues: Issue[], conflict?: { version: string | null } | undefined } | { saved: true, commit?: unknown, version?: string | undefined }
interface SaveOptions { slug?: string, locale?: string | undefined, create?: boolean }

// The save of each entry on its way, and whether another was asked for meanwhile.
const saving = new WeakMap<Drafts, Map<string, { done: Promise<boolean>, again: boolean }>>()

// Saves an entry's draft, under the slug and locale a new entry was given, and says how it went; true once saved.
// A save asked for while one is on its way waits for it, then saves the edits typed meanwhile once, so the same version is never sent twice.
export async function saveDraft(drafts: Drafts, ref: EntryRef, options: SaveOptions = {}): Promise<boolean> {
  const inFlight = saving.get(drafts) ?? new Map<string, { done: Promise<boolean>, again: boolean }>()
  const key = entryKey(ref)
  const running = inFlight.get(key)

  saving.set(drafts, inFlight)

  if (running) {
    // A new entry saved again would be created twice; its page saves the rest.
    running.again ||= options.create !== true

    return running.done
  }

  const flight = { done: Promise.resolve(false), again: false }

  flight.done = (async () => {
    try {
      let saved = await saveOnce(drafts, ref, options)

      while (saved && flight.again && drafts.changed(ref)) {
        flight.again = false
        saved = await saveOnce(drafts, ref, options)
      }

      return saved
    }
    finally {
      inFlight.delete(key)
    }
  })()
  inFlight.set(key, flight)

  return flight.done
}

async function saveOnce(drafts: Drafts, ref: EntryRef, { slug = ref.slug, locale = ref.locale, create = false }: SaveOptions): Promise<boolean> {
  const entry = drafts.entry(ref)

  if (!entry)
    return false

  const outcome = await attempt(() => call(entriesApi, '/:collection/:slug', {
    method: 'post',
    params: { collection: ref.collection, slug },
    body: { data: entry.data, create, ...localeOf({ ...ref, locale }), ...(entry.body === undefined ? {} : { body: entry.body }), ...versionOf(drafts.version(ref)) },
  }), 'Could not save')

  if (outcome && 'issues' in outcome) {
    // A new entry's issues name the slug it was saved under, not the one its draft is kept by.
    const issues = outcome.issues.map(issue => ({ ...issue, collection: ref.collection, slug: ref.slug, locale: ref.locale }))
    const whole = issues.find(issue => issue.path === '' && issue.key === undefined && issue.body !== true)

    // A refusal of the entry as a whole, a conflict or a forge that failed, stays shown while the editor types, as no render clears it.
    if (whole) {
      drafts.refuse(ref, { message: whole.message, conflict: outcome.conflict })
      toast.error(`Not saved: ${whole.message}`)

      return false
    }

    drafts.report(issues)
    toast.error('Not saved: some fields need fixing')

    return false
  }

  if (!outcome || !settled(outcome, 'Saved', 'Not saved'))
    return false

  drafts.markSaved(ref, entry, 'version' in outcome ? outcome.version : undefined)
  drafts.report([])

  return true
}

// Deletes a saved entry, naming the version it was opened at, and says how it went; true once deleted.
// A list of entries shows no version, so a delete from it names the one the entry is at as it is asked.
export async function deleteSaved(ref: EntryRef, version?: string | undefined): Promise<boolean> {
  const outcome = await attempt(async () => call(entriesApi, '/:collection/:slug', {
    method: 'delete',
    params: { collection: ref.collection, slug: ref.slug },
    query: { ...localeOf(ref), ...versionOf(version ?? await currentVersion(ref)) },
  }), 'Could not delete')

  return settled(outcome, 'Deleted', 'Not deleted')
}

// Deletes an unused upload and its variants, and says how it went; true once deleted.
export async function deleteUnusedUpload(key: string): Promise<boolean> {
  const result = await attempt(() => call(filesApi, '/unused/delete', { method: 'post', body: { keys: [key] } }), 'Could not delete')

  if (!result)
    return false

  if (result.deleted.length === 0) {
    toast.error('Not deleted: an entry references this file now')

    return false
  }

  toast.success('Deleted')

  return true
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

async function currentVersion(ref: EntryRef): Promise<string | undefined> {
  const { entry } = await call(entriesApi, '/:collection/:slug', { params: { collection: ref.collection, slug: ref.slug }, query: localeOf(ref) })

  return entry.version
}

function localeOf({ locale }: EntryRef): { locale?: string } {
  return locale === undefined ? {} : { locale }
}

function versionOf(version: string | undefined): { version?: string } {
  return version === undefined ? {} : { version }
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
