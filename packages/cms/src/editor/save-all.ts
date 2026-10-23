import type { EntryRef } from '../kay/contract'
import { entryKey } from '../markers'

// What one entry's form offers Save all: whether it holds edits, and its own save, which refuses or fails as a click on its Save would.
export interface Saver {
  pending: () => boolean
  save: () => Promise<boolean>
}

const savers = new Map<string, Saver>()

// Lets Save all reach the form of an entry, until the returned function is called.
export function registerSaver(entry: EntryRef, saver: Saver): () => void {
  const key = entryKey(entry)

  savers.set(key, saver)

  return () => {
    if (savers.get(key) === saver)
      savers.delete(key)
  }
}

// Saves each entry holding edits, in the order the page lists them and one after another, as each save is a commit of its own and two at once would race for the same branch. An entry refused stays as it is with its own message, and the others still go through; the count is how many were refused.
export async function saveAll(entries: readonly EntryRef[]): Promise<number> {
  let refused = 0

  for (const entry of entries) {
    const saver = savers.get(entryKey(entry))

    if (saver?.pending() && !await saver.save())
      refused++
  }

  return refused
}
