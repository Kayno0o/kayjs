import type { EntryRef } from '../kay/contract'
import { messageOf, toast } from '@kaynooo/kayjs-ui'
import { call } from 'kay'
import { wording } from 'kay/words'
import entriesApi from '../api/entries'

export type BulkAction = 'publish' | 'unpublish' | 'delete'

export interface BulkTarget {
  ref: EntryRef
  // The version of the file the list showed, which a delete names so it never removes an entry saved since.
  version?: string | undefined
}

export interface BulkResult {
  done: number
  // The entries the server refused or that failed, which the caller names in one toast.
  failed: number
  // Why the first of them failed, as the server worded it; absent when no answer said.
  reason?: string | undefined
}

// Undefined once the entry went through, else why it did not, empty when nothing said.
async function run(action: BulkAction, { ref, version }: BulkTarget): Promise<string | undefined> {
  const query = { ...ref.locale === undefined ? {} : { locale: ref.locale } }
  const params = { collection: ref.collection, slug: ref.slug }

  try {
    const outcome = action === 'delete'
      ? await call(entriesApi, '/:collection/:slug', { method: 'delete', params, query: { ...query, ...version === undefined ? {} : { version } } })
      : await call(entriesApi, action === 'publish' ? '/:collection/:slug/publish' : '/:collection/:slug/unpublish', { method: 'post', params, query })

    return 'issues' in outcome ? outcome.issues.map(issue => issue.message).join('; ') : undefined
  }
  catch (error) {
    return messageOf(error, '')
  }
}

// Runs the action on each entry one after another, as each is a commit of its own and two at once would race for the same branch, and counts how many went through and why the first refused.
export async function bulk(action: BulkAction, targets: BulkTarget[]): Promise<BulkResult> {
  const result: BulkResult = { done: 0, failed: 0 }

  for (const target of targets) {
    const why = await run(action, target)

    if (why === undefined) {
      result.done++

      continue
    }

    result.failed++
    result.reason ??= why === '' ? undefined : why
  }

  return result
}

// Saves a copy of an entry as a draft and says how it went; its slug, or undefined once refused or failed.
export async function duplicateSaved(ref: EntryRef): Promise<string | undefined> {
  try {
    const outcome = await call(entriesApi, '/:collection/:slug/duplicate', {
      method: 'post',
      params: { collection: ref.collection, slug: ref.slug },
      query: ref.locale === undefined ? {} : { locale: ref.locale },
    })

    if ('issues' in outcome) {
      toast.error(wording('cms.save.notDuplicated', 'Not duplicated: {message}', { message: outcome.issues.map(issue => issue.message).join('; ') }))

      return undefined
    }

    toast.success(wording('cms.save.duplicated', 'Duplicated'))

    return outcome.slug
  }
  catch (error) {
    toast.error(messageOf(error, wording('cms.save.duplicateFailure', 'Could not duplicate')))

    return undefined
  }
}
