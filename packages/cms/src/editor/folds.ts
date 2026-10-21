import type { EntryRef } from '../kay/contract'
import { entryKey } from '../markers'

// A list in the form keeps which of its items are folded away, by place: a change made on the page moves them through here, as the form's own buttons do.
type Mirror = (change: (states: boolean[]) => boolean[]) => void

const followers = new Map<string, Mirror>()
const keyOf = (entry: EntryRef, path: string) => `${entryKey(entry)}:${path}`

// Lets the list shown in the form follow the changes of the page, until the returned function is called.
export function followFolds(entry: EntryRef, path: string, mirror: Mirror): () => void {
  const key = keyOf(entry, path)

  followers.set(key, mirror)

  return () => {
    if (followers.get(key) === mirror)
      followers.delete(key)
  }
}

// Says how a change of the list moves its items' folds, before the list changes.
export function moveFolds(entry: EntryRef, path: string, change: (states: boolean[]) => boolean[]): void {
  followers.get(keyOf(entry, path))?.(change)
}
