// What the compiler asks of Bun and the file system, which a browser build swaps for the stand-ins of `host.browser.ts` through the `browser` field of package.json: the server compiler keeps these direct calls.
import type traverseModule from '@babel/traverse'
import { statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import process from 'node:process'
import { installedIconSets } from '../build/icons'
import { fnvHash } from './fnv-hash'

export { browserGlobals } from './globals'

const require = createRequire(import.meta.url)
let loadedTraverse: typeof traverseModule | undefined

// Loading it takes longer than most compiles, so a server whose `.kay` files all come from the compile cache never does; `kay dev` loads it ahead of time.
export function loadTraverse(): typeof traverseModule {
  loadedTraverse ??= (require('@babel/traverse') as { default: typeof traverseModule }).default

  return loadedTraverse
}

export function cwd(): string {
  return process.cwd()
}

// ESLint runs the processor under Node.
export function hash(text: string): string {
  return typeof Bun === 'undefined' ? fnvHash(text) : Bun.hash(text).toString(36)
}

export function markdownHtml(text: string, options: { autolinks: boolean }): string {
  return Bun.markdown.html(text, options)
}

// The HTML Markdown's parser makes of one raw-HTML entity, or none when there is no parser (the ESLint bundle).
export function markdownEntity(entity: string): string | undefined {
  return typeof Bun === 'undefined' || !('markdown' in Bun) ? undefined : Bun.markdown.html(entity)
}

// The prefixes of the icon sets the project at `root` installs, kept per root until its package.json or its icon sets change.
const iconSetCache = new Map<string, { stamp: string, sets: ReadonlySet<string> }>()

export function iconSetsOf(source: string, root: string | undefined): ReadonlySet<string> | undefined {
  if (root === undefined || !source.includes('~icons/'))
    return undefined

  const stamp = [join(root, 'package.json'), join(root, 'node_modules/@iconify-json')].map((path) => {
    try {
      return statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0
    }
    catch {
      return 0
    }
  }).join(':')
  const kept = iconSetCache.get(root)

  if (kept?.stamp === stamp)
    return kept.sets

  let sets: ReadonlySet<string>

  try {
    sets = new Set(installedIconSets(root).keys())
  }
  catch {
    sets = new Set()
  }

  iconSetCache.set(root, { stamp, sets })

  return sets
}
