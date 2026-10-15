import type { FaviconSource } from '../server/favicon'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { version } from '../../package.json'
import { kayLog } from '../runtime/log'
import { faviconFiles } from '../server/favicon'
import { countCache } from './cache'

const WARNINGS_FILE = 'warnings.json'
const DONE_FILE = '.done'

interface Warning {
  message: string
  // Shown whether or not the build's `warn` hushes them: the check reports an SVG's, not a raster source's.
  always: boolean
}

// The icons drawn from the source files, kept under the cache by a hash of every source's path and bytes, the Bun and kay versions drawing them and the warnings they raised; a build with the same sources copies them rather than drawing every size again.
// One entry is kept: a build with other sources replaces it.
export async function writeCachedFavicons(source: FaviconSource, dir: string, cache: string, warn?: (message: string) => void): Promise<void> {
  const key = await entryKey(source)
  const entry = key === undefined ? undefined : join(cache, key)

  if (entry !== undefined && await Bun.file(join(entry, DONE_FILE)).exists()) {
    try {
      await restore(entry, dir, warn)
      countCache('favicons', true)

      return
    }
    catch {}
  }

  countCache('favicons', false)

  const warnings: Warning[] = []
  const files = await faviconFiles(source, (message) => {
    warnings.push({ message, always: false })
    ;(warn ?? (text => kayLog('warn', text)))(message)
  }, (message) => {
    warnings.push({ message, always: true })
    kayLog('warn', message)
  })

  await mkdir(dir, { recursive: true })

  for (const [path, bytes] of files)
    await Bun.write(join(dir, path.slice(1)), bytes)

  if (entry !== undefined)
    await keep(cache, key!, files, warnings)
}

// Written aside and moved into place, so a build never reads half an entry; a read-only disk only loses the cache.
async function keep(cache: string, key: string, files: Map<string, Uint8Array<ArrayBuffer>>, warnings: Warning[]): Promise<void> {
  const draft = join(cache, `${key}.${crypto.randomUUID()}.tmp`)

  try {
    await mkdir(draft, { recursive: true })

    for (const [path, bytes] of files)
      await Bun.write(join(draft, path.slice(1)), bytes)

    await Bun.write(join(draft, WARNINGS_FILE), JSON.stringify(warnings))
    await Bun.write(join(draft, DONE_FILE), '')
    await rm(join(cache, key), { recursive: true, force: true })
    await rename(draft, join(cache, key))

    await Promise.all((await readdir(cache)).filter(name => name !== key).map(async name => rm(join(cache, name), { recursive: true, force: true })))
  }
  catch {
    await rm(draft, { recursive: true, force: true })
  }
}

async function restore(entry: string, dir: string, warn?: (message: string) => void): Promise<void> {
  const warnings = await Bun.file(join(entry, WARNINGS_FILE)).json() as Warning[]

  await mkdir(dir, { recursive: true })

  for (const name of await readdir(entry)) {
    if (name !== WARNINGS_FILE && name !== DONE_FILE)
      await Bun.write(join(dir, name), Bun.file(join(entry, name)))
  }

  for (const { message, always } of warnings)
    (always ? (text: string) => kayLog('warn', text) : warn ?? (text => kayLog('warn', text)))(message)
}

// Undefined when a source cannot be read, which drawing then reports as it always did.
async function entryKey(source: FaviconSource): Promise<string | undefined> {
  const hasher = new Bun.CryptoHasher('sha256').update(`${version}\n${Bun.version}\n`)

  try {
    for (const [role, file] of Object.entries({ image: source.image, svg: source.svg, maskable: source.maskable })) {
      if (file === undefined) {
        hasher.update(`${role}:none\n`)

        continue
      }

      const bytes = await Bun.file(file).bytes()

      hasher.update(`${role}:${file}:${bytes.length}\n`).update(bytes)
    }
  }
  catch {
    return undefined
  }

  return hasher.digest('hex')
}
