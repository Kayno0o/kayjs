import { mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
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

export async function readCacheEntry<Value>(slot: CacheSlot): Promise<Value | undefined> {
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

  try {
    await mkdir(dirname(slot.file), { recursive: true })
    await Bun.write(written, JSON.stringify({ key: slot.key, value }))
    await rename(written, slot.file)
  }
  catch {}
}
