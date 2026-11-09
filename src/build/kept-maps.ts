import { mkdir, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pruneCache, touchCacheFile } from './cache'
import { KAY_MODULE, readSource, writeAtomically } from './files'
import { compilerFingerprint } from './fingerprint'
import { COMPRESSED_MAP, keepBundleMap } from './sourcemap'

const KEPT_DIR = 'kept-maps'
const KEPT_FILE = /^[\da-z]+\.zst$/

// `keepBundleMap` through the cache: a map whose bundle map and `.kay` sources are those of a map kept before is copied from it, so a warm build neither compiles those files again nor points the map at them.
export async function keepBundleMapCached(mapFile: string, root: string, mapsDir: string, cacheDir: string): Promise<void> {
  const text = await Bun.file(mapFile).text()
  const kept = join(cacheDir, KEPT_DIR, `${keptKey(mapFile, root, text)}.zst`)
  const target = join(mapsDir, `${basename(mapFile)}${COMPRESSED_MAP}`)

  touchCacheFile(kept)

  if (await Bun.file(kept).exists()) {
    try {
      await mkdir(mapsDir, { recursive: true })
      await Bun.write(target, Bun.file(kept))
      await rm(mapFile, { force: true })

      return
    }
    catch {
      // Pruned by another build of the same root since: the map is pointed again below.
    }
  }

  await keepBundleMap(mapFile, root, mapsDir)
  await mkdir(dirname(kept), { recursive: true })
  await writeAtomically(kept, Bun.file(target))
}

// Drops the kept maps no chunk of this build named; only a full client build calls it.
export async function pruneKeptMaps(cacheDir: string): Promise<number> {
  return pruneCache(join(cacheDir, KEPT_DIR), KEPT_FILE)
}

// What a kept map depends on: the compiler, the bundle's own map (its code and positions) and the text of each `.kay` file it holds, an island twin's included, which the map points into.
function keptKey(mapFile: string, root: string, text: string): string {
  const { sources } = JSON.parse(text) as { sources: string[] }
  let hash = Bun.hash(`${compilerFingerprint()}\0${root}\0${text}`)

  for (const source of sources) {
    const file = resolve(dirname(mapFile), source)

    if (KAY_MODULE.test(file))
      hash = Bun.hash(`${file}\0${sourceText(file.replace(KAY_MODULE, '.kay'))}`, hash)
  }

  return hash.toString(36)
}

function sourceText(file: string): string {
  try {
    return readSource(file).text
  }
  catch {
    return ''
  }
}
