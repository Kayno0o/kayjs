import type { Drafts } from '../drafts'
import type { EntryRef, Issue } from '../kay/contract'
import { attempt, toast } from '@kaynooo/kayjs-ui'
import { call, focusInvalid } from 'kay'
import { wording } from 'kay/words'
import entriesApi from '../api/entries'
import filesApi from '../api/files'
import redirectsApi from '../api/redirects'
import { entryKey } from '../markers'
import { uploading } from './upload'

type Outcome = { issues: Issue[], conflict?: { version: string | null } | undefined } | { saved: true, commit?: unknown, version?: string | undefined }
// `told` is the toast a save this one waited for ended on, which a refusal worded the same does not repeat.
// `onSaved` hears each save that went through, and whether the site shows it only once it has rebuilt.
interface SaveOptions { slug?: string, locale?: string | undefined, create?: boolean, told?: string | undefined, onSaved?: ((saved: { rebuilding: boolean }) => void) | undefined }

// The save of each entry on its way, and whether another was asked for meanwhile.
const saving = new WeakMap<Drafts, Map<string, Flight>>()

interface Flight { done: Promise<boolean>, again: boolean, target: string, told?: string | undefined }

// Saves an entry's draft, under the slug and locale a new entry was given, and says how it went; true once saved.
// A save asked for while one is on its way waits for it, then saves the edits typed meanwhile once, so the same version is never sent twice.
// One asked for under another slug or locale waits for it too, then saves the edits typed meanwhile under its own.
export async function saveDraft(drafts: Drafts, ref: EntryRef, options: SaveOptions = {}): Promise<boolean> {
  // An upload on its way sets its field when it lands, which a save made now would leave out.
  if (uploading()) {
    toast.error(wording('cms.save.uploading', 'An upload is still running: save once it ends'))

    return false
  }

  const inFlight = saving.get(drafts) ?? new Map<string, Flight>()
  const key = entryKey(ref)
  const target = JSON.stringify([options.slug ?? ref.slug, options.locale ?? ref.locale])
  const running = inFlight.get(key)

  saving.set(drafts, inFlight)

  if (running && running.target !== target) {
    const saved = await running.done

    return saveDraft(drafts, ref, saved ? options : { ...options, told: running.told })
  }

  if (running) {
    // A new entry saved again would be created twice; its page saves the rest.
    running.again ||= options.create !== true

    return running.done
  }

  const flight: Flight = { done: Promise.resolve(false), again: false, target }

  flight.done = (async () => {
    try {
      let saved = await saveOnce(drafts, ref, options, flight)

      while (saved && flight.again && drafts.changed(ref)) {
        flight.again = false
        saved = await saveOnce(drafts, ref, options, flight)
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

async function saveOnce(drafts: Drafts, ref: EntryRef, { slug = ref.slug, locale = ref.locale, create = false, told, onSaved }: SaveOptions, flight: Flight): Promise<boolean> {
  const entry = drafts.entry(ref)

  if (!entry)
    return false

  // Edits kept over a file deleted meanwhile make it again, refused if one was made since rather than written over.
  create ||= drafts.recreating(ref)

  const blocked = drafts.blocked(ref)

  // A text that does not parse never reaches the server, which would save the value before it.
  if (blocked.length > 0) {
    drafts.report([...drafts.issues(ref).filter(issue => issue.body === true || !blocked.some(({ path }) => path === issue.path)), ...blocked.map(({ path, message }) => ({ ...ref, path, message }))])
    tell(flight, told, wording('cms.save.fields', 'Not saved: some fields need fixing'))

    return false
  }

  const outcome = await attempt(async () => call(entriesApi, '/:collection/:slug', {
    method: 'post',
    params: { collection: ref.collection, slug },
    body: { data: entry.data, create, ...localeOf({ ...ref, locale }), ...(entry.body === undefined ? {} : { body: entry.body }), ...versionOf(drafts.version(ref)) },
  }), wording('cms.save.failure', 'Could not save'))

  if (outcome && 'issues' in outcome) {
    // A new entry's issues name the slug it was saved under, not the one its draft is kept by.
    const issues = outcome.issues.map(issue => ({ ...issue, collection: ref.collection, slug: ref.slug, locale: ref.locale }))
    const whole = issues.find(issue => issue.path === '' && issue.key === undefined && issue.body !== true)

    // A refusal of the entry as a whole, a conflict or a forge that failed, stays shown while the editor types, as no render clears it.
    if (whole) {
      drafts.refuse(ref, { message: whole.message, conflict: outcome.conflict })
      tell(flight, told, wording('cms.save.refusal', 'Not saved: {message}', { message: whole.message }))

      return false
    }

    drafts.report(issues)
    tell(flight, told, wording('cms.save.fields', 'Not saved: some fields need fixing'))

    return false
  }

  if (!outcome || !settled(outcome, wording('cms.save.saved', 'Saved'), wording('cms.save.notSaved', 'Not saved')))
    return false

  drafts.markSaved(ref, entry, 'version' in outcome ? outcome.version : undefined)
  drafts.report([])
  onSaved?.({ rebuilding: 'commit' in outcome && outcome.commit !== undefined })

  return true
}

// Takes the focus to what a refused save left to fix: the refusal of the whole entry, else the first field it marked, else the first notice above the form. A caller runs it once its form is unlocked, as a browser focuses nothing inside a disabled fieldset.
export async function showRefusal(drafts: Drafts, ref: EntryRef): Promise<void> {
  if (typeof document === 'undefined')
    return

  if (drafts.refusal(ref)) {
    document.querySelector<HTMLElement>('.kcms-refusal')?.focus()

    return
  }

  if (drafts.issues(ref).length > 0 && !await focusInvalid())
    document.querySelector<HTMLElement>('.kcms-entry-failure')?.focus()
}

// Toasts a refusal, unless the save this one waited for ended on the same toast.
function tell(flight: Flight, told: string | undefined, message: string): void {
  flight.told = message

  if (message !== told)
    toast.error(message)
}

// Deletes a saved entry, naming the version the editor or the list showed, and says how it went; true once deleted.
// With none, as for a loaded entry, none is named: the server refuses a folder entry's delete naming no version rather than removing one the editor never saw.
export async function deleteSaved(ref: EntryRef, version?: string | undefined): Promise<boolean> {
  const outcome = await attempt(async () => call(entriesApi, '/:collection/:slug', {
    method: 'delete',
    params: { collection: ref.collection, slug: ref.slug },
    query: { ...localeOf(ref), ...versionOf(version) },
  }), wording('cms.save.deleteFailure', 'Could not delete'))

  return settled(outcome, wording('cms.save.deleted', 'Deleted'), wording('cms.save.notDeleted', 'Not deleted'))
}

// The most keys one request deletes, which the API caps.
const DELETE_CHUNK = 100

// Deletes unused uploads in requests of at most 100 keys, stopping at the first that fails; true once all went through. The rows are stale either way, the caller refreshing them.
export async function deleteUnusedUploadsInChunks(keys: string[]): Promise<boolean> {
  for (let at = 0; at < keys.length; at += DELETE_CHUNK) {
    if (!await deleteUnusedUploads(keys.slice(at, at + DELETE_CHUNK)))
      return false
  }

  return true
}

// Deletes unused uploads and their variants in one request, so the server reads the content once for all, and says how it went; true once the rows are stale, deleted or not.
export async function deleteUnusedUploads(keys: string[]): Promise<boolean> {
  const result = await attempt(async () => call(filesApi, '/unused/delete', { method: 'post', body: { keys } }), wording('cms.save.deleteFailure', 'Could not delete'))

  if (!result)
    return false

  if (result.deleted.length === 0) {
    toast.info(keys.length === 1 ? wording('cms.uploads.goneOne', 'No longer unused, or already deleted') : wording('cms.uploads.goneAll', 'None are unused any longer, or all are already deleted'))

    return true
  }

  toast.success(wording('cms.uploads.deleted', result.deleted.length === 1 ? 'Deleted' : 'Deleted {count}', { count: result.deleted.length }))

  if (result.kept.length > 0)
    toast.info(wording('cms.uploads.kept', '{count} no longer unused, or already deleted', { count: result.kept.length }))

  return true
}

// Turns a draft entry public and says how it went; true once published.
export async function publishSaved(ref: EntryRef): Promise<boolean> {
  const outcome = await attempt(async () => call(entriesApi, '/:collection/:slug/publish', {
    method: 'post',
    params: { collection: ref.collection, slug: ref.slug },
    query: localeOf(ref),
  }), wording('cms.save.publishFailure', 'Could not publish'))

  return settled(outcome, wording('cms.save.published', 'Published'), wording('cms.save.notPublished', 'Not published'))
}

// Tells the editor a publish, an unpublish or a schedule change waits for the edits typed so far to be saved, which they would otherwise carry along.
export function refuseUnsaved(): void {
  toast.error(wording('cms.save.saveFirst', 'You have unsaved changes. Save or cancel them first, so this does not save them too.'))
}

// Moves an entry one place up or down in its collection's order and says how it went; true once moved.
export async function moveSaved(ref: EntryRef, direction: 'up' | 'down'): Promise<boolean> {
  const outcome = await attempt(async () => call(entriesApi, '/:collection/:slug/move', {
    method: 'post',
    params: { collection: ref.collection, slug: ref.slug },
    query: { ...localeOf(ref), direction },
  }), wording('cms.save.moveFailure', 'Could not move'))

  return settled(outcome, wording('cms.save.moved', 'Moved'), wording('cms.save.notMoved', 'Not moved'))
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
    toast.error(wording('cms.save.issues', '{refused}: {issues}', { refused, issues: outcome.issues.map(issue => issue.message).join('; ') }))

    return false
  }

  // A commit shows on the site once it has rebuilt from it.
  toast.success(outcome.commit === undefined ? done : wording('cms.save.rebuild', '{done}. The site shows it once it has rebuilt.', { done }))

  return true
}

// Adds the redirect from a missing path to its target and says how it went; true once added. The rows are stale either way, the caller refreshing them.
// 308 is permanent and 410 says the path is gone, with no target. A path that has a redirect takes the new target and status, which is how one is edited.
export async function addMissingRedirect(from: string, to: string, status: 307 | 308 | 410): Promise<boolean> {
  const done = await attempt(async () => call(redirectsApi, '/', { method: 'post', body: { from, to, status } }), wording('cms.redirects.addFailure', 'Could not add the redirect'))

  if (done)
    toast.success(wording('cms.redirects.added', 'Redirect added'))

  return done !== undefined
}

// Removes redirects added from the screen, so their paths answer 404 again; true once removed.
export async function removeAddedRedirects(froms: string[]): Promise<boolean> {
  const done = await attempt(async () => call(redirectsApi, '/remove', { method: 'post', body: { froms } }), wording('cms.redirects.removeFailure', 'Could not remove the redirect'))

  if (done)
    toast.success(wording('cms.redirects.removed', 'Redirect removed'))

  return done !== undefined
}

// Forgets missing paths, all of them when none is named; true once done. They are listed again if a visitor asks for them again.
export async function dismissMissingPaths(paths?: string[]): Promise<boolean> {
  const done = await attempt(async () => paths ? call(redirectsApi, '/dismiss', { method: 'post', body: { paths } }) : call(redirectsApi, '/clear', { method: 'post' }), wording('cms.missing.dismissFailure', 'Could not dismiss the paths'))

  if (done)
    toast.success(wording('cms.missing.dismissed', 'Dismissed'))

  return done !== undefined
}
