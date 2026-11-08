// What the types of a project depend on, read from its files: a run of the checker that would answer the same is skipped when the stamp is the one of the last.
import type { Dirent, Stats } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { version } from '../../package.json'
import { nativeExe } from '../compiler/native-typescript'
import { projectPaths } from '../project'

const TYPED = /\.(?:[cm]?tsx?|kay|json)$|^bun\.lockb?$/

// The project's own sources, configs and lockfile with their sizes and times, its shadow tree (a write in flight changes it, so a stamp taken after the emit tells one that read half of it), the sources of the packages linked into its `node_modules` (a workspace's, whose types are not in a lockfile), the tsconfig, the checker's own version and `extra`.
// A project that did not change costs a walk of its folders.
export async function typingStamp(root: string, tsconfig: string, extra: string[]): Promise<string> {
  const entries = [version, nativeExe(), tsconfig, ...extra]

  await walk(root, entries)
  await walk(projectPaths(root).types, entries)

  const modules = join(root, 'node_modules')

  for (const folder of [modules, ...await scopesOf(modules)]) {
    for (const entry of await listed(folder)) {
      if (entry.isSymbolicLink()) {
        const target = await resolved(join(folder, entry.name))

        if (target !== undefined)
          await walk(target, entries)
      }
    }
  }

  return String(Bun.hash.wyhash(entries.join('\n')))
}

async function scopesOf(modules: string): Promise<string[]> {
  return (await listed(modules)).filter(entry => entry.name.startsWith('@') && entry.isDirectory()).map(entry => join(modules, entry.name))
}

// Adds each file that may type the project under `dir`, but the folders of tools and builds (`node_modules`, `.git`, `.kay`, any dot folder).
async function walk(dir: string, into: string[]): Promise<void> {
  const names = (await listed(dir)).sort((a, b) => a.name.localeCompare(b.name))
  const folders: string[] = []

  for (const entry of names) {
    const path = join(dir, entry.name)

    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && !entry.name.startsWith('.'))
        folders.push(path)
    }
    else if (entry.isFile() && TYPED.test(entry.name)) {
      const info = await statted(path)

      if (info)
        into.push(`${path}:${info.size}:${info.mtimeMs}`)
    }
  }

  // One folder after the other, as a project of many opens as many as the process allows.
  for (const folder of folders)
    await walk(folder, into)
}

// What is in a folder, none when it is not there or cannot be read.
async function listed(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  }
  catch {
    return []
  }
}

async function resolved(path: string): Promise<string | undefined> {
  try {
    return await realpath(path)
  }
  catch {
    return undefined
  }
}

async function statted(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path)
  }
  catch {
    return undefined
  }
}
