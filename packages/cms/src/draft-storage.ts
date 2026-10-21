import type { DraftEntry } from './kay/contract'

// What the browser keeps of an entry's unsaved edits: the entry as typed, the version of the file it was edited from, and when.
export interface KeptDraft {
  entry: DraftEntry
  version: string | undefined
  at: number
  // A hash of the saved copy the edits were made from, kept for an entry with no version, which cannot tell by it that the entry was saved since.
  base?: string | undefined
}

// Where unsaved edits survive a reload or a crash. Every method gives up quietly when the browser has no storage to give.
export interface DraftKeeper {
  read: (key: string) => KeptDraft | undefined
  write: (key: string, kept: KeptDraft) => void
  remove: (key: string) => void
  // Forgets every draft this keeper wrote, of any entry, and nothing else the storage holds.
  clear: () => void
  now: () => number
}

// A week: a draft left longer is more likely forgotten than wanted, and the entry has moved on.
export const KEEP_FOR = 7 * 24 * 60 * 60 * 1000

const PREFIX = 'kcms:draft:'

function storageOf(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  }
  catch {
    return undefined
  }
}

function isKept(value: unknown): value is KeptDraft {
  if (typeof value !== 'object' || value === null)
    return false

  const { entry, version, at, base } = value as Record<string, unknown>

  return typeof at === 'number' && (base === undefined || typeof base === 'string') && (version === undefined || typeof version === 'string') && typeof entry === 'object' && entry !== null && typeof (entry as DraftEntry).collection === 'string' && typeof (entry as DraftEntry).slug === 'string' && typeof (entry as DraftEntry).data === 'object' && (entry as DraftEntry).data !== null
}

// Keeps drafts in the browser's `localStorage`, one item per entry. `get` and `now` are for a test to give.
export function browserKeeper(get: () => Storage | undefined = storageOf, now: () => number = Date.now): DraftKeeper {
  // Every access can throw: storage blocked, full, or gone in a private window.
  function attempt<T>(run: (storage: Storage) => T): T | undefined {
    try {
      const storage = get()

      return storage ? run(storage) : undefined
    }
    catch {
      return undefined
    }
  }

  function remove(key: string): void {
    attempt(storage => storage.removeItem(PREFIX + key))
  }

  return {
    now,
    read(key) {
      const text = attempt(storage => storage.getItem(PREFIX + key))

      if (text === null || text === undefined)
        return undefined

      let kept: unknown

      try {
        kept = JSON.parse(text)
      }
      catch {
        kept = undefined
      }

      if (isKept(kept) && now() - kept.at <= KEEP_FOR)
        return kept

      remove(key)

      return undefined
    },
    write(key, kept) {
      attempt(storage => storage.setItem(PREFIX + key, JSON.stringify(kept)))
    },
    remove,
    clear() {
      attempt((storage) => {
        for (const name of Array.from({ length: storage.length }, (_, at) => storage.key(at))) {
          if (name?.startsWith(PREFIX))
            storage.removeItem(name)
        }
      })
    },
  }
}
