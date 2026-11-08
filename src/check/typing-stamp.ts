// What the types of a project depend on, read from its files: a run of the checker that would answer the same is skipped when the stamp is the one of the last.
import type { Dirent, Stats } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { version } from '../../package.json'
import { nativeExe } from '../compiler/native-typescript'
import { projectPaths } from '../project'

const TYPED = /\.(?:[cm]?[jt]sx?|kay|jsonc?)$|^(?:bun\.lockb?|yarn\.lock|pnpm-lock\.yaml)$/

// The project's own sources, configs and lockfile with their sizes and times, its shadow tree (a write in flight changes it, so a stamp taken after the emit tells one that read half of it), the sources of the packages linked into a `node_modules` of it or of a folder above (a workspace's, whose types are not in a lockfile), the lockfile of each folder above, the tsconfigs it extends, the checker's own version and `extra`.
// A project that did not change costs a walk of its folders. What it cannot see is a file outside those, a relative import out of the root or a `paths` entry there: `kay build --no-cache` reads the types again.
export async function typingStamp(root: string, tsconfig: string, extra: string[]): Promise<string> {
  const entries = [version, nativeExe(), ...extra]

  await walk(root, entries)
  await walk(projectPaths(root).types, entries)

  const walked = new Set<string>([resolve(root)])

  for (let dir = resolve(root); ; dir = dirname(dir)) {
    await linkedIn(join(dir, 'node_modules'), root, walked, entries)
    await lockfilesIn(dir, entries)

    if (dirname(dir) === dir)
      break
  }

  for (const config of await extended(tsconfig))
    entries.push(await fileStamp(config))

  return String(Bun.hash.wyhash(entries.join('\n')))
}

// The sources of each package a `node_modules` links from outside of one (a workspace's, not a dependency the installer linked into its own store), but the project's own folders and those holding it.
async function linkedIn(modules: string, root: string, walked: Set<string>, into: string[]): Promise<void> {
  for (const folder of [modules, ...(await listed(modules)).filter(entry => entry.name.startsWith('@') && entry.isDirectory()).map(entry => join(modules, entry.name))]) {
    for (const entry of await listed(folder)) {
      if (!entry.isSymbolicLink())
        continue

      const target = await resolved(join(folder, entry.name))

      if (target === undefined || walked.has(target) || target.split(sep).includes('node_modules') || contains(target, root) || contains(root, target) || !(await statted(target))?.isDirectory() || await isKay(target))
        continue

      walked.add(target)
      await walk(target, into)
    }
  }
}

// A link to kay itself, whose version the stamp holds: its sources, tests and libraries are not the project's types.
async function isKay(folder: string): Promise<boolean> {
  try {
    return (await Bun.file(join(folder, 'package.json')).json() as { name?: unknown }).name === 'kay'
  }
  catch {
    return false
  }
}

function contains(outer: string, inner: string): boolean {
  return inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep)
}

async function lockfilesIn(dir: string, into: string[]): Promise<void> {
  for (const name of ['bun.lock', 'bun.lockb', 'yarn.lock', 'pnpm-lock.yaml', 'package-lock.json'])
    into.push(await fileStamp(join(dir, name)))
}

const EXTENDS = /"extends"\s*:\s*(\[[^\]]*\]|"[^"]*")/

// The tsconfig and the files it extends by a path, which a project may keep above its own folder.
async function extended(tsconfig: string, seen = new Set<string>()): Promise<string[]> {
  if (seen.has(tsconfig) || seen.size > 8)
    return []

  seen.add(tsconfig)

  const text = await textOf(tsconfig)
  const named = [...(EXTENDS.exec(text ?? '')?.[1]?.matchAll(/"([^"]*)"/g) ?? [])].map(([, name]) => name!).filter(name => name.startsWith('.') || name.startsWith('/'))
  const found = [tsconfig]

  for (const name of named)
    found.push(...await extended(resolve(dirname(tsconfig), name.endsWith('.json') ? name : `${name}.json`), seen))

  return found
}

async function textOf(path: string): Promise<string | undefined> {
  try {
    return await Bun.file(path).text()
  }
  catch {
    return undefined
  }
}

async function fileStamp(path: string): Promise<string> {
  const info = await statted(path)

  return `${path}:${info?.size}:${info?.mtimeMs}`
}

// Adds each file that may type the project under `dir`, but the folders of tools and builds (`node_modules`, `.git`, `.kay`, any dot folder).
async function walk(dir: string, into: string[]): Promise<void> {
  const names = (await listed(dir)).sort((a, b) => a.name < b.name ? -1 : Number(a.name > b.name))
  const files = names.filter(entry => entry.isFile() && TYPED.test(entry.name)).map(entry => join(dir, entry.name))

  // A folder's files in parallel, its folders one after the other, as a project of many opens as many as the process allows.
  into.push(...await Promise.all(files.map(async path => fileStamp(path))))

  for (const entry of names) {
    if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.'))
      await walk(join(dir, entry.name), into)
  }
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
