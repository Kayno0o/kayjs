import type { KayExtension } from '../config'
import type { ImportGraph, KayLibrary } from './libraries'
import { existsSync } from 'node:fs'
import { extensionEditor, routeMounts } from '../server/routes'
import { findKayFiles } from './files'
import { findKayLibraries, reachableLibraryFiles } from './libraries'

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
