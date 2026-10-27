import type { StoredEncoding, StrongestCopies } from '../server/compress'
import type { DictionaryCopies } from '../server/dictionary'
import { join } from 'node:path'
import { strongestCopies } from '../server/compress'
import { BUILD_COPY_KEY, buildDictionaryCopy, DCZ_SUFFIX } from '../server/dictionary'
import { countCache, pruneCache, touchCacheFile } from './cache'
import { writeAtomically } from './files'

// Bumped when the levels or the rule keeping a copy change, so older entries are never read as the new ones.
const COPIES_VERSION = 1
const SUFFIXES: Record<StoredEncoding, string> = { br: 'br', gzip: 'gz' }
const ENTRY_FILE = /^[\da-f]{64}\.(?:br|gz|done)(?:\..+\.tmp)?$/
const DICTIONARY_ENTRY_FILE = /^[\da-f]{64}\.dcz(?:\..+\.tmp)?$/

// The copies `kay build` writes, kept under the cache by the SHA-256 of the file's content, so a file unchanged since an earlier build is not compressed again.
// An entry holds the copies worth writing and a marker naming them, written last, so an entry cut short or missing a copy is made again; a file whose copies do not shrink it keeps the marker alone and is not compressed again either.
export function cachedCopies(dir: string): StrongestCopies {
  return async (bytes) => {
    const name = new Bun.CryptoHasher('sha256').update(`${COPIES_VERSION}:`).update(bytes).digest('hex')
    const marker = join(dir, `${name}.done`)

    touchCacheFile(marker)

    for (const suffix of Object.values(SUFFIXES))
      touchCacheFile(join(dir, `${name}.${suffix}`))

    try {
      const listed = await Bun.file(marker).json() as StoredEncoding[]

      if (Array.isArray(listed)) {
        const copies: Partial<Record<StoredEncoding, Uint8Array<ArrayBuffer>>> = {}

        for (const encoding of listed)
          copies[encoding] = await Bun.file(join(dir, `${name}.${SUFFIXES[encoding]}`)).bytes()

        countCache('compressed copies', true)

        return copies
      }
    }
    catch {}

    countCache('compressed copies', false)

    const made = await strongestCopies(bytes)

    try {
      await Promise.all(Object.entries(made).map(async ([encoding, copy]) => writeAtomically(join(dir, `${name}.${SUFFIXES[encoding as StoredEncoding]}`), copy)))
      await writeAtomically(marker, JSON.stringify(Object.keys(made)))
    }
    catch {}

    return made
  }
}

// Drops the entries this build compressed no file to, for a build that compressed them all.
export async function pruneCopies(dir: string): Promise<number> {
  return pruneCache(dir, ENTRY_FILE)
}

// The dcz copies `kay build` writes, kept under the cache by the SHA-256 of the page and of the dictionary (which the 40 bytes starting the copy hold), so a page and a 404 page both unchanged since an earlier build are not compressed again at zstd's strongest level.
export function cachedDictionaryCopies(dir: string): DictionaryCopies {
  return async (dictionary, bytes) => {
    const name = new Bun.CryptoHasher('sha256').update(`${BUILD_COPY_KEY}:`).update(dictionary.header).update(bytes).digest('hex')
    const file = join(dir, `${name}${DCZ_SUFFIX}`)

    touchCacheFile(file)

    try {
      const copy = await Bun.file(file).bytes()

      countCache('dictionary copies', true)

      return copy
    }
    catch {}

    countCache('dictionary copies', false)

    const made = await buildDictionaryCopy(dictionary, bytes)

    try {
      await writeAtomically(file, made)
    }
    catch {}

    return made
  }
}

// Drops the dcz entries this build wrote no page from, for a server build that wrote them all.
export async function pruneDictionaryCopies(dir: string): Promise<number> {
  return pruneCache(dir, DICTIONARY_ENTRY_FILE)
}
