import type { KayExtension } from '../config'
import type { ImportGraph, KayLibrary } from './libraries'
import { existsSync, realpathSync } from 'node:fs'
import { sep } from 'node:path'
import { extensionEditor, routeMounts } from '../server/routes'
import { findKayFiles } from './files'
import { findKayLibraries, reachableLibraryFiles, reachesAny } from './libraries'

export type BrowserRole = 'island' | 'promotable' | undefined

export interface BuildFiles {
  // The project's own components, the pages of the libraries it mounts and the components of the libraries it reaches, in that order.
  files: string[]
  own: string[]
  mounted: string[]
  editor: string | undefined
  libraries: KayLibrary[]
  fromLibraries: { components: string[], scripts: string[] }
}

// The `.kay` files the build compiles, which the check reads the same way.
// A library's components compile with its own; a kay project nested inside, such as an example, builds on its own.
export async function buildFiles(root: string, extensions: KayExtension[] | undefined, graph: ImportGraph = new Map()): Promise<BuildFiles> {
  const own = await findKayFiles(root, { project: true, ownKayOnly: true })
  const ownFiles = new Set(own)
  const editor = extensionEditor(root, extensions)
  // The pages of the libraries the app mounts, which it reaches through its config rather than an import.
  const mountedFiles = (await Promise.all(routeMounts(root, extensions).map(async mount => existsSync(mount.dir) ? findKayFiles(mount.dir) : []))).flat()
  const mounted = [...new Set([...mountedFiles, ...editor === undefined ? [] : [editor]])].filter(file => !ownFiles.has(file))
  const libraries = await findKayLibraries(root)
  const fromLibraries = await reachableLibraryFiles(root, libraries, [...own, ...mounted], graph)

  return { files: [...own, ...mounted, ...fromLibraries.components], own, mounted, editor, libraries, fromLibraries }
}

// Whether the build promotes each file to an island: a static component that passes a function, whose imports reach an island of the project, of a library it mounts or of one it reaches.
export async function promotedFiles(root: string, libraries: KayLibrary[], files: string[], roles: BrowserRole[], graph: ImportGraph = new Map()): Promise<boolean[]> {
  const islandFiles = new Set(files.filter((_, index) => roles[index] === 'island').map(file => realpathSync(file)))
  const edges = new Map<string, Promise<string[]>>()
  const project = realpathSync(root) + sep

  return Promise.all(files.map(async (file, index) => roles[index] === 'promotable' && islandFiles.size > 0 && await reachesAny(root, libraries, realpathSync(file), islandFiles, edges, project, graph)))
}
