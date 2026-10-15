import type { StoredEncoding, StrongestCopies } from '../server/compress'
import { join } from 'node:path'
import { strongestCopies } from '../server/compress'
import { countCache, pruneCache, touchCacheFile } from './cache'
import { writeAtomically } from './files'

// Bumped when the levels or the rule keeping a copy change, so older entries are never read as the new ones.
const COPIES_VERSION = 1
const SUFFIXES: Record<StoredEncoding, string> = { br: 'br', gzip: 'gz' }
const ENTRY_FILE = /^[\da-f]{64}\.(?:br|gz|done)$/

// The copies `kay build` writes, kept under the cache by the SHA-256 of the file's content, so a file unchanged since an earlier build is not compressed again.
// An entry holds the copies worth writing and a marker, written last, so one cut short is made again; a file whose copies do not shrink it keeps the marker alone and is not compressed again either.
export function cachedCopies(dir: string): StrongestCopies {
  return async (bytes) => {
    const name = new Bun.CryptoHasher('sha256').update(`${COPIES_VERSION}:`).update(bytes).digest('hex')
    const marker = join(dir, `${name}.done`)

    touchCacheFile(marker)

    for (const suffix of Object.values(SUFFIXES))
      touchCacheFile(join(dir, `${name}.${suffix}`))

    if (await Bun.file(marker).exists()) {
      const copies: Partial<Record<StoredEncoding, Uint8Array<ArrayBuffer>>> = {}

      try {
        for (const [encoding, suffix] of Object.entries(SUFFIXES)) {
          const file = Bun.file(join(dir, `${name}.${suffix}`))

          if (await file.exists())
            copies[encoding as StoredEncoding] = await file.bytes()
        }

        countCache('compressed copies', true)

        return copies
      }
      catch {}
    }

    countCache('compressed copies', false)

    const made = await strongestCopies(bytes)

    try {
      await Promise.all(Object.entries(made).map(async ([encoding, copy]) => writeAtomically(join(dir, `${name}.${SUFFIXES[encoding as StoredEncoding]}`), copy)))
      await writeAtomically(marker, '')
    }
    catch {}

    return made
  }
}

// Drops the entries this build compressed no file to, for a build that compressed them all.
export async function pruneCopies(dir: string): Promise<number> {
  return pruneCache(dir, ENTRY_FILE)
}
