// Where an app's Iconify sets are installed: `@iconify-json/<prefix>` packages or the all-in-one `@iconify/json`, in the app's node_modules or a parent's (a workspace hoists them), the nearest first.

import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const PREFIX_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

// Looked up on disk at each call rather than through Bun's resolver, which remembers a package missing at the first lookup and would never see a set installed while `kay dev` runs.
function nodeModulesDirs(root: string): string[] {
  const dirs: string[] = []
  for (let dir = root; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'node_modules')))
      dirs.push(join(dir, 'node_modules'))
    if (dirname(dir) === dir)
      return dirs
  }
}

export function isSetPrefix(prefix: string): boolean {
  return PREFIX_RE.test(prefix)
}

/** The JSON file of the set `prefix` installed for the app at `root`. */
export function setFile(prefix: string, root: string): string | undefined {
  if (!isSetPrefix(prefix))
    return undefined
  for (const dir of nodeModulesDirs(root)) {
    for (const file of [join(dir, '@iconify-json', prefix, 'icons.json'), join(dir, '@iconify/json/json', `${prefix}.json`)]) {
      if (existsSync(file))
        return file
    }
  }
  return undefined
}

/** Every set installed for the app at `root`, as prefix to JSON file, sorted by prefix. */
export function installedSets(root: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const dir of nodeModulesDirs(root)) {
    for (const file of new Bun.Glob('@iconify-json/*/icons.json').scanSync({ cwd: dir, followSymlinks: true })) {
      const prefix = basename(dirname(file))
      if (isSetPrefix(prefix) && !found.has(prefix))
        found.set(prefix, join(dir, file))
    }
    for (const file of new Bun.Glob('@iconify/json/json/*.json').scanSync({ cwd: dir, followSymlinks: true })) {
      const prefix = basename(file, '.json')
      if (isSetPrefix(prefix) && !found.has(prefix))
        found.set(prefix, join(dir, file))
    }
  }
  return new Map([...found].sort(([a], [b]) => a.localeCompare(b)))
}
