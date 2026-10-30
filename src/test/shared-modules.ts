import { readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, extname, resolve, sep } from 'node:path'
import process from 'node:process'

const KAY_SOURCE = resolve(import.meta.dir, '..') + sep
const SCANNED = new Map<string, 'ts' | 'tsx' | 'js' | 'jsx'>([['.ts', 'ts'], ['.mts', 'ts'], ['.tsx', 'tsx'], ['.js', 'js'], ['.mjs', 'js'], ['.cjs', 'js'], ['.jsx', 'jsx']])
const KAY_SPECIFIER = /^(?:kay(?:\/|$)|kayjs-)/
// Bun words its refusal of a builtin in a browser build only when no plugin saw the import.
const NOT_BUILTIN = /^(?!(?:node|bun):)/
const BUILTINS = new Set(builtinModules)
const NODE_MODULES = `${sep}node_modules${sep}`
const transpilers = new Map<string, Bun.Transpiler>()
// Whether a file, and everything it imports from the project, is free of kay: by path, for the test process.
const clean = new Map<string, boolean>()

function scan(path: string, loader: 'ts' | 'tsx' | 'js' | 'jsx'): { path: string }[] {
  let transpiler = transpilers.get(loader)

  if (!transpiler)
    transpilers.set(loader, transpiler = new Bun.Transpiler({ loader }))

  return transpiler.scanImports(readFileSync(path, 'utf8'))
}

// A file the bundle would carry a copy of, where the test and the component would hold two: free of `.kay` files and of kay's runtime, which has a browser build of its own that a module running in the test process would not get.
function isClean(path: string, seen = new Set<string>()): boolean {
  const known = clean.get(path)

  if (known !== undefined)
    return known

  if (seen.has(path))
    return true

  seen.add(path)

  const loader = SCANNED.get(extname(path))
  let result = true

  if (loader !== undefined) {
    try {
      for (const { path: specifier } of scan(path, loader)) {
        if (!importIsClean(specifier, dirname(path), seen)) {
          result = false

          break
        }
      }
    }
    catch {
      result = false
    }
  }

  // A file seen again while walking a cycle is clean until its ring finishes; only a finished walk is kept.
  if (seen.size === 1 || !result)
    clean.set(path, result)

  return result
}

function importIsClean(specifier: string, from: string, seen: Set<string>): boolean {
  if (KAY_SPECIFIER.test(specifier))
    return false

  // A server module, which the browser build refuses with the chain of imports that reached it.
  if (specifier.startsWith('node:') || specifier.startsWith('bun:') || BUILTINS.has(specifier))
    return false

  let resolved: string

  try {
    resolved = Bun.resolveSync(specifier, from)
  }
  catch {
    return false
  }

  if (resolved.endsWith('.kay') || resolved.startsWith(KAY_SOURCE))
    return false

  // A dependency is not walked: only kay's own libraries import kay, and those are named above.
  return resolved.includes(NODE_MODULES) || isClean(resolved, seen)
}

// What the bundle imports from the test process rather than carrying: a module of the project or a package that needs nothing of kay, so a test importing the same file holds the same instance, and `mock.module()` reaches the component's static and dynamic imports. A module importing kay or a `.kay` file stays in the bundle, built for the browser and run afresh by each mount.
export function sharedModules(apiDirs: string[]): Bun.BunPlugin {
  const apiPrefixes = apiDirs.map(dir => dir + sep)

  return {
    name: 'kay-shared-modules',
    setup(build) {
      build.onResolve({ filter: NOT_BUILTIN }, (args) => {
        if (args.kind === 'entry-point-build' || args.kind === 'entry-point-run' || args.namespace !== 'file' || !args.importer)
          return undefined

        if (args.path.startsWith('node:') || args.path.startsWith('bun:') || KAY_SPECIFIER.test(args.path))
          return undefined

        let resolved: string

        try {
          resolved = Bun.resolveSync(args.path, dirname(args.importer) || process.cwd())
        }
        catch {
          return undefined
        }

        // An API module reaches the browser as the stub of where it is served, which its own load makes.
        if (!SCANNED.has(extname(resolved)) || resolved.startsWith(KAY_SOURCE) || apiPrefixes.some(prefix => resolved.startsWith(prefix)))
          return undefined

        return isClean(resolved) ? { path: resolved, external: true } : undefined
      })
    },
  }
}
