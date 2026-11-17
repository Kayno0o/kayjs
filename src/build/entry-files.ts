import { resolve } from 'node:path'
import { lazyKey } from './lazy-components'
import { throughLinks } from './links'
import { variantFile } from './variants'

export const KAY_OUTPUT = /\.kay(?:\?uses=[^?]*)?$/

// Bun names entry points relative to the working directory, not the root: from a library holding a test app, its layout and the app's share a path.
// The file among `files` a build's entry point stands for, a variant or a link followed.
export function entryFile(root: string, entryPoint: string, files: Set<string>): string | undefined {
  const point = resolve(variantFile(entryPoint))

  return [point, throughLinks(root, point)].find(file => files.has(file))
}

// The lazy key of an entry point that is a component and no island.
export function lazyEntryKey(root: string, islandFiles: Set<string>): (entryPoint: string) => string | undefined {
  return entryPoint => KAY_OUTPUT.test(entryPoint) && entryFile(root, entryPoint, islandFiles) === undefined ? lazyKey(root, resolve(variantFile(entryPoint))) : undefined
}
