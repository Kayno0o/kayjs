import type { Context } from 'elysia'
import type { ImageLimits } from './config-limits'
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { drawing } from './image-format'
import { clientAddress, overLimit } from './protection'

export interface EncodeRefusal {
  body: string
  status: number
  wait?: number
}

const ENCODE_RATE = 'image-encodes'
const QUEUE_RETRY_SECONDS = 5
// The sources whose cached variants are listed in memory; one forgotten is read from the folder again.
const MOST_SOURCES = 1024

// Sets `Retry-After` on a refusal that says when to come back.
export function waitFor(response: Response, seconds: number | undefined): Response {
  if (seconds !== undefined)
    response.headers.set('retry-after', String(seconds))

  return response
}

// The cached variants of one source, oldest written first: the files of the cache folder that start with its stem.
async function cachedOf(dir: string, stem: string): Promise<string[]> {
  try {
    const names = (await readdir(dir)).filter(name => name.startsWith(`${stem}-`) && !name.endsWith('.pruning'))
    const times = new Map(await Promise.all(names.map(async name => [name, (await stat(join(dir, name))).mtimeMs] as const)))

    return names.sort((first, second) => times.get(first)! - times.get(second)!)
  }
  catch {
    return []
  }
}

// What the image route runs an encode through: it answers why not, or undefined once the variant is written. Not while the draw queue is full, nor for a client that asked for too many new variants this minute; a refused variant counts for neither.
// `images.maxVariants` bounds the cache of one source without refusing anyone: past it the oldest cached variant of that source is removed, `forgotten` told to drop the files it holds open, and the one asked for is encoded.
// It runs inside the one write a variant gets, so requests for the same new variant at once count once. A variant's name is its source's stem followed by its `suffix`.
export function encodeGate(limits: ImageLimits, dir: string, forgotten: { clear: () => void }[]) {
  // The cached variants of each source by stem, read from the folder once, so what a restart or an earlier run left counts.
  const sources = new Map<string, Promise<string[]>>()
  const variantsOf = async (name: string, suffix: string) => {
    const stem = name.slice(0, name.length - suffix.length)
    let names = sources.get(stem)

    if (!names) {
      if (sources.size >= MOST_SOURCES)
        sources.delete(sources.keys().next().value!)

      sources.set(stem, names = cachedOf(dir, stem))
    }

    return names
  }

  return {
    async run(request: Request, server: Context['server'], { name, suffix }: { name: string, suffix: string }, encode: () => Promise<unknown>): Promise<EncodeRefusal | undefined> {
      if (limits.queue !== undefined && drawing.waiting >= limits.queue)
        return { body: 'Too many images are being drawn; try again shortly', status: 503, wait: QUEUE_RETRY_SECONDS }

      const wait = limits.rate === undefined ? undefined : await overLimit(ENCODE_RATE, clientAddress(request, server), limits.rate.max, limits.rate.windowMs)

      if (wait !== undefined)
        return { body: 'Too many new image variants; try again later', status: 429, wait }

      const names = limits.maxVariants === undefined ? [] : await variantsOf(name, suffix)

      while (limits.maxVariants !== undefined && !names.includes(name) && names.length >= limits.maxVariants) {
        await rm(join(dir, names.shift()!), { force: true })

        for (const held of forgotten)
          held.clear()
      }

      await encode()

      // Counted once it is on disk, so a variant that failed to decode takes no place.
      if (!names.includes(name))
        names.push(name)

      return undefined
    },
  }
}
