import type { KayExtension } from '../config'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// What config loading reads of the packages an app installs, kept apart from libraries.ts so the server never loads the compiler that one imports.
export interface Manifest {
  name?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  exports?: unknown
  kay?: { settings?: string, messages?: string }
}

export const APP_DEPENDENCIES: (keyof Manifest)[] = ['dependencies', 'devDependencies', 'optionalDependencies']

// The message catalogs the libraries the app depends on ship, as extensions listing nothing else: a library whose package.json declares `"kay": { "messages": "./src/messages" }` gives its `<locale>.ts` texts to every app that installs it, with no line in `kay.config.ts`.
export function libraryMessageExtensions(root: string): KayExtension[] {
  const manifest = readManifest(root)

  if (!manifest)
    return []

  return dependencyNames(manifest, APP_DEPENDENCIES).flatMap((name) => {
    const dir = packageDir(root, name)
    const messages = dir === undefined ? undefined : readManifest(dir)?.kay?.messages

    return dir === undefined || typeof messages !== 'string' ? [] : [{ name, messages: resolve(dir, messages) }]
  })
}

export function dependencyNames(manifest: Manifest, fields: (keyof Manifest)[]): string[] {
  return [...new Set(fields.flatMap(field => Object.keys(manifest[field] as Record<string, string> | undefined ?? {})))]
}

// Where `name` is installed as Bun resolves it from `from`: its `node_modules`, or one above.
export function packageDir(from: string, name: string): string | undefined {
  for (let dir = from; ; dir = resolve(dir, '..')) {
    const candidate = join(dir, 'node_modules', name)

    if (existsSync(join(candidate, 'package.json')))
      return candidate

    if (dir === resolve(dir, '..'))
      return undefined
  }
}

export function readManifest(dir: string): Manifest | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest
  }
  catch {
    return undefined
  }
}
