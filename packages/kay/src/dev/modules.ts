// kay dev's module store: each build's server files, copied so an unchanged chunk keeps its loaded instance.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

// Bun never unloads a module, so each build's server files are copied into a generation store.
// Only `_entry.js` is imported, with its hash: the code lives in content-named chunks, so an unchanged chunk keeps its loaded instance across saves.
// A failed import starts a new generation, since Bun keeps a module that failed to evaluate.
export function createModuleStore(storeRoot: string) {
  const hashes = new Map<string, string>()
  let generation = 0
  let stale = false
  const generationDir = (g: number): string => join(storeRoot, `g${g}`)
  return {
    reloadAll(): void {
      stale = true
    },
    sync(serverDir: string): void {
      const nextFiles = new Map<string, { bytes: Buffer, hash: string }>()
      for (const entry of readdirSync(serverDir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile())
          continue
        const from = join(entry.parentPath, entry.name)
        const rel = relative(serverDir, from).replaceAll('\\', '/')
        const bytes = readFileSync(from)
        const hash = Bun.hash(bytes).toString(36)
        nextFiles.set(rel, { bytes, hash })
      }

      if (stale) {
        stale = false
        hashes.clear()
        generation++
        // The previous generation stays for requests the old app is still serving.
        rmSync(generationDir(generation - 2), { recursive: true, force: true })
      }
      const storeDir = generationDir(generation)
      for (const [rel, { bytes, hash }] of nextFiles) {
        if (hashes.get(rel) === hash)
          continue
        const to = join(storeDir, rel)
        mkdirSync(dirname(to), { recursive: true })
        writeFileSync(to, bytes)
        hashes.set(rel, hash)
      }
      // Prune removed chunk files from current generation to avoid unbounded disk/map growth.
      for (const rel of [...hashes.keys()]) {
        if (!nextFiles.has(rel)) {
          hashes.delete(rel)
          rmSync(join(storeDir, rel), { force: true })
        }
      }
    },
    importFrom(serverDir: string) {
      const storeDir = generationDir(generation)
      return async (path: string): Promise<Record<string, unknown>> => {
        const rel = relative(serverDir, path).replaceAll('\\', '/')
        try {
          return await import(`${join(storeDir, rel)}?v=${hashes.get(rel)}`)
        }
        catch (err) {
          stale = true
          throw err
        }
      }
    },
  }
}
