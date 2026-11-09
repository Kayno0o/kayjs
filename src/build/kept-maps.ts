import { mkdir, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pruneCache, touchCacheFile } from './cache'
import { writeAtomically } from './files'
import { compilerFingerprint } from './fingerprint'
import { COMPRESSED_MAP, keepBundleMap } from './sourcemap'

const KEPT_DIR = 'kept-maps'
const KEPT_FILE = /^[\da-z]+\.zst$/

// `keepBundleMap` through the cache: a map whose bundle map and `.kay` sources are those of a map kept before is copied from it, so a warm build neither compiles those files again nor points the map at them.
export async function keepBundleMapCached(mapFile: string, root: string, mapsDir: string, cacheDir: string): Promise<void> {
  const text = await Bun.file(mapFile).text()
  const kept = join(cacheDir, KEPT_DIR, `${await keptKey(mapFile, root, text)}.zst`)
  const target = join(mapsDir, `${basename(mapFile)}${COMPRESSED_MAP}`)

  touchCacheFile(kept)

  if (await Bun.file(kept).exists()) {
    await mkdir(mapsDir, { recursive: true })
    await Bun.write(target, Bun.file(kept))
    await rm(mapFile, { force: true })

    return
  }

  await keepBundleMap(mapFile, root, mapsDir)
  await mkdir(dirname(kept), { recursive: true })
  await writeAtomically(kept, Bun.file(target))
}

// Drops the kept maps no chunk of this build named; only a full client build calls it.
export async function pruneKeptMaps(cacheDir: string): Promise<number> {
  return pruneCache(join(cacheDir, KEPT_DIR), KEPT_FILE)
}

// What a kept map depends on: the compiler, the bundle's own map (its code and positions) and the text of each `.kay` file it holds, which the map points into.
async function keptKey(mapFile: string, root: string, text: string): Promise<string> {
  const { sources } = JSON.parse(text) as { sources: string[] }
  const kayTexts = await Promise.all(sources.map(async (source) => {
    const file = resolve(dirname(mapFile), source)
    const kay = Bun.file(file)

    return file.endsWith('.kay') && await kay.exists() ? `${file}\0${await kay.text()}` : ''
  }))

  return Bun.hash([compilerFingerprint(), root, text, ...kayTexts].join('\0')).toString(36)
}
