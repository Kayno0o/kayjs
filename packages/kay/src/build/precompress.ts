// The `.br` and `.gz` sidecars of a build, and the brotli they hold, cached by content under `.kay-cache/` so a build pays only for the files that changed.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { promisify } from 'node:util'
import { brotliCompress, brotliCompressSync, constants as zlibConstants } from 'node:zlib'
import { getAppContext } from '../plugins/context'

/** Brotli quality of the sidecars: written once per build, downloaded by every visitor, so the smallest the encoder makes. */
export const BROTLI_QUALITY = 11

const COMPRESSIBLE_EXTS = new Set(['.html', '.js', '.mjs', '.css', '.svg', '.xml', '.json', '.txt', '.webmanifest', '.wasm'])
const STALE_MS = 7 * 86_400_000

const compress = promisify(brotliCompress)
const optionsFor = (data: Uint8Array) => ({ params: { [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: data.byteLength } })
let tmpCount = 0

/** Where the app under `root` keeps the brotli of each content a build compressed. */
export function brotliCacheDir(root: string): string {
  return join(root, '.kay-cache', `brotli-${BROTLI_QUALITY}`)
}

/** The cache of the app being built, if any. */
export function appBrotliCacheDir(): string | undefined {
  const root = getAppContext()?.root
  return root === undefined ? undefined : brotliCacheDir(root)
}

function entryFile(data: Uint8Array, cacheDir: string | undefined): string | undefined {
  return cacheDir === undefined ? undefined : join(cacheDir, new Bun.CryptoHasher('sha256').update(data).digest('hex'))
}

function readEntry(file: string): Buffer | undefined {
  try {
    const packed = readFileSync(file)
    const now = new Date()
    utimesSync(file, now, now)
    return packed
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return undefined
    throw error
  }
}

// Renamed into place, so a build running beside this one never reads half an entry.
function writeEntry(file: string, packed: Uint8Array): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}-${tmpCount++}.tmp`
  writeFileSync(tmp, packed)
  renameSync(tmp, file)
}

/** Brotli of `data` at `BROTLI_QUALITY`, off the main thread; with `cacheDir`, read from there when this content was compressed before. */
export async function brotli(data: Uint8Array, cacheDir?: string): Promise<Uint8Array> {
  const file = entryFile(data, cacheDir)
  const cached = file === undefined ? undefined : readEntry(file)
  if (cached !== undefined)
    return cached
  const packed = await compress(data, optionsFor(data))
  if (file !== undefined)
    writeEntry(file, packed)
  return packed
}

/** `brotli` on the main thread, for a caller that cannot wait. */
export function brotliSync(data: Uint8Array, cacheDir?: string): Uint8Array {
  const file = entryFile(data, cacheDir)
  const cached = file === undefined ? undefined : readEntry(file)
  if (cached !== undefined)
    return cached
  const packed = brotliCompressSync(data, optionsFor(data))
  if (file !== undefined)
    writeEntry(file, packed)
  return packed
}

/** Bytes of `content` in brotli at the quality the sidecars are written at, from the app's cache when a build compressed it before. */
export async function brotliSize(content: string | Uint8Array): Promise<number> {
  return (await brotli(typeof content === 'string' ? Buffer.from(content) : content, appBrotliCacheDir())).byteLength
}

/** Removes the entries no build read for 7 days, and the temporary files of a build that died; returns how many went. */
export function pruneBrotliCache(cacheDir: string, now = Date.now()): number {
  if (!existsSync(cacheDir))
    return 0
  let removed = 0
  for (const name of readdirSync(cacheDir)) {
    const file = join(cacheDir, name)
    const stat = statSync(file, { throwIfNoEntry: false })
    if (stat !== undefined && now - stat.mtimeMs > STALE_MS) {
      rmSync(file, { force: true })
      removed++
    }
  }
  return removed
}

async function precompressFile(abs: string, minBytes: number, cacheDir: string): Promise<void> {
  if (!COMPRESSIBLE_EXTS.has(extname(abs).toLowerCase()))
    return
  const raw = readFileSync(abs)
  if (raw.byteLength < minBytes)
    return
  const br = await brotli(raw, cacheDir)
  if (br.byteLength < raw.byteLength)
    writeFileSync(`${abs}.br`, br)
  const gz = Bun.gzipSync(raw, { level: 9 })
  if (gz.byteLength < raw.byteLength)
    writeFileSync(`${abs}.gz`, gz)
}

/** Writes `.br` and `.gz` sidecars next to each compressible file of at least `minBytes`, when they come out smaller, one file per core at a time off the main thread, the brotli cached for the app under `root`. */
export async function precompressFiles(files: Iterable<string>, minBytes: number, root: string): Promise<void> {
  const cacheDir = brotliCacheDir(root)
  pruneBrotliCache(cacheDir)
  const queue = [...files]
  const next = async (): Promise<void> => {
    for (let abs = queue.pop(); abs !== undefined; abs = queue.pop())
      await precompressFile(abs, minBytes, cacheDir)
  }
  await Promise.all(Array.from({ length: Math.min(availableParallelism(), queue.length) }, next))
}
