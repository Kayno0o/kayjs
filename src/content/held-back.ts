import type { Collection, Entry } from './index'
import type { RawEntry } from './load'
import { isDraft, publishTime } from './drafts'

// Whether a production server leaves an entry out of its pages: a draft, one not yet published, or one already taken down.
export function heldBack(options: Collection<unknown>['options'], raw: RawEntry, data: unknown): boolean {
  const { draft, publishAt, unpublishAt } = options
  const entry = { ...raw, data } as unknown as Entry<unknown>

  if (draft !== undefined && isDraft(draft, entry))
    return true

  const live = publishAt === undefined ? undefined : publishTime(publishAt, entry)
  const down = unpublishAt === undefined ? undefined : publishTime(unpublishAt, entry)

  return (live !== undefined && live > Date.now()) || (down !== undefined && down <= Date.now())
}
