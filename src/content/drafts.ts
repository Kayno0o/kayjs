import type { Entry } from './index'

// Whether the collection's `draft` holds an entry back: its function, or its boolean field set.
export function isDraft<Data>(draft: ((entry: Entry<Data>) => boolean) | string, entry: Entry<Data>): boolean {
  return typeof draft === 'string' ? (entry.data as Record<string, unknown> | undefined)?.[draft] === true : draft(entry)
}
