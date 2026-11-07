import type { ErrorShape } from 'kay/library'
import type { EntryRef, Issue } from './kay/contract'
import type { BeforeSaveChange, BeforeSaveEvent, EntryState, SaveEvent } from './settings'
import { decide, dispatch } from 'kay/library'
import { entries } from './kay/content'
import { log } from './log'
import { settings } from './settings'

// A refusal of `cms({ beforeSave })`, as the issues of a schema refusal, so the entry form shows it the same way; `status` is the hook's.
export interface HookRefusal {
  issues: Issue[]
  status: number
}

// The entry as stored now, for the hooks to compare with; undefined for one that is not there or does not parse.
export async function previousOf(ref: EntryRef): Promise<EntryState | undefined> {
  const [stored] = await entries(ref.collection, { slug: ref.slug, locale: ref.locale })

  return stored?.data === undefined ? undefined : { data: stored.data, ...stored.body !== undefined && { body: stored.body } }
}

// Whether a hook wants the stored entry, which costs a read.
export function hooked(): boolean {
  const { beforeSave, onSave } = settings()

  return beforeSave !== undefined || onSave !== undefined
}

// A hook's refusal as the issues of an entry: its field errors by path, else its message for the entry as a whole.
export function refusalOf(ref: EntryRef, { status, message, errors }: ErrorShape): HookRefusal {
  const fields = Object.entries(errors).map(([path, text]) => ({ collection: ref.collection, slug: ref.slug, locale: ref.locale, path, message: text }))
  const whole = message !== '' && (fields.length === 0 || !fields.some(({ message: text }) => text === message))

  return { status, issues: [...whole ? [{ collection: ref.collection, slug: ref.slug, locale: ref.locale, path: '', message }] : [], ...fields] }
}

// Asks `cms({ beforeSave })` and answers what it changed or why it refused. A change that is not an object, or a body that is not text, is a hook's mistake: reported, and the write refused as a throw would.
export async function askBeforeSave(event: BeforeSaveEvent): Promise<{ change: Partial<BeforeSaveChange> } | HookRefusal> {
  const answer = await decide('cms.beforeSave', [settings().beforeSave], event)

  if ('refused' in answer)
    return refusalOf(event, answer.refused)

  const { data, body } = answer.change

  if ((data !== undefined && (typeof data !== 'object' || data === null || Array.isArray(data))) || (body !== undefined && typeof body !== 'string')) {
    log.error(`cms.beforeSave for ${event.collection}/${event.slug} returned a data that is not an object or a body that is not text`)

    return refusalOf(event, { status: 500, message: 'Internal server error', errors: {}, data: undefined })
  }

  return answer
}

// Tells `cms({ onSave })`: a throw or a hook still running past ten seconds is reported with source `cms.onSave` and never undoes the save.
export async function tellOnSave(event: SaveEvent): Promise<void> {
  await dispatch('cms.onSave', [settings().onSave], event)
}
