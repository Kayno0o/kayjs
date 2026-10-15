import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'

// A file under `.kay/cache` holding one value, valid while its key matches.
export interface CacheSlot {
  file: string
  key: string
}

interface CacheEntry<Value> {
  key: string
  value: Value
}

// The entries this process read or wrote, which a full build leaves in place when it prunes.
const touched = new Set<string>()

export async function readCacheEntry<Value>(slot: CacheSlot): Promise<Value | undefined> {
  touched.add(slot.file)

  try {
    const entry = await Bun.file(slot.file).json() as CacheEntry<Value>

    return entry.key === slot.key ? entry.value : undefined
  }
  catch {
    return undefined
  }
}

// Written aside, then renamed over the entry, so another process never reads half of it; a read-only disk only loses the cache.
export async function writeCacheEntry(slot: CacheSlot, value: unknown): Promise<void> {
  const written = `${slot.file}.${process.pid}.tmp`

  touched.add(slot.file)

  try {
    await mkdir(dirname(slot.file), { recursive: true })
    await Bun.write(written, JSON.stringify({ key: slot.key, value }))
    await rename(written, slot.file)
  }
  catch {}
}

// Drops the files of `dir` whose names `owned` matches that this process neither read nor wrote and `keep` does not name, which a full run's sources no longer produce: a component deleted or renamed leaves its entries behind otherwise, one more with every one.
// Only a run that reached everything may call it, never a dev rebuild or a partial one.
export async function pruneCache(dir: string, owned: RegExp, keep: (name: string) => boolean = () => false): Promise<number> {
  let names: string[]

  try {
    names = await readdir(dir)
  }
  catch {
    return 0
  }

  const stale = names.filter(name => owned.test(name) && !touched.has(join(dir, name)) && !keep(name))

  await Promise.all(stale.map(async name => rm(join(dir, name), { force: true })))

  return stale.length
}

// Marks a file another module keeps in a cache directory as used, for `pruneCache`.
export function touchCacheFile(file: string): void {
  touched.add(file)
}
