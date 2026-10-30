import { readFileSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, extname, resolve, sep } from 'node:path'
import process from 'node:process'

const KAY_PACKAGE = resolve(import.meta.dir, '../..')
const KAY_SOURCE = resolve(import.meta.dir, '..') + sep
const SCANNED = new Map<string, 'ts' | 'tsx' | 'js' | 'jsx'>([['.ts', 'ts'], ['.mts', 'ts'], ['.tsx', 'tsx'], ['.js', 'js'], ['.mjs', 'js'], ['.cjs', 'js'], ['.jsx', 'jsx']])
const KAY_SPECIFIER = /^kay(?:\/|$)/
const KAY_LIBRARY = /^(?:@kaynooo\/)?kayjs-/
const LIBRARY_FOLDER = /[\\/]node_modules[\\/](?:@kaynooo[\\/])?kayjs-/
// The names `mountComponent` defines for the bundle: a file of kay reading one is built for the app's settings, so the bundle keeps its own copy of it.
const DEFINED = /\bKAY_(?:FRENCH|I18N)\b/
// A file of kay reading the page keeps it per mount: what it holds of the document it first met, a listener or the tab's visibility, restarts as it does on a page load. The reactive core and the modules built on it alone are what the test and the bundle share.
const READS_PAGE = /\b(?:document|window|localStorage|sessionStorage|navigator|location|history|matchMedia|requestAnimationFrame|IntersectionObserver|MutationObserver|ResizeObserver|getComputedStyle|addEventListener|HTMLElement|Element|Node)\b/
const LINE_COMMENT = /^\s*(?:\/\/|\*|\/\*).*$/gm
// Bun words its refusal of a builtin in a browser build only when no plugin saw the import.
const NOT_BUILTIN = /^(?!(?:node|bun):)/
const BUILTINS = new Set(builtinModules)
const NODE_MODULES = `${sep}node_modules${sep}`
const transpilers = new Map<string, Bun.Transpiler>()

interface Scanned {
  version: string
  // Whether the file itself, and what it imports, allow it to be shared; the files to look at in turn.
  ok: boolean
  imports: string[]
}

// By path, valid while the file keeps its version: a test rewriting a file between mounts gets its new answer.
const scanned = new Map<string, Scanned>()
const packages = new Map<string, boolean>()
const libraries = new Map<string, boolean>()

interface BrowserEntries {
  // `kay/island`, `#schema`: the entries of kay that resolve to another file in a browser build.
  specifiers: Set<string>
  files: Set<string>
}

let browserEntries: BrowserEntries | undefined

// What kay selects by the `browser` condition: the bundle builds those for the browser, so they stay in it, and so does everything that imports one.
function kayBrowserEntries(): BrowserEntries {
  if (browserEntries)
    return browserEntries

  const entries: BrowserEntries = { specifiers: new Set(), files: new Set() }
  const manifest = JSON.parse(readFileSync(resolve(KAY_PACKAGE, 'package.json'), 'utf8')) as { exports?: Record<string, unknown>, imports?: Record<string, unknown> }
  const add = (specifier: string, target: unknown): void => {
    if (typeof target !== 'object' || target === null || !('browser' in target))
      return

    entries.specifiers.add(specifier)

    for (const file of Object.values(target)) {
      if (typeof file === 'string' && file.startsWith('./'))
        entries.files.add(resolve(KAY_PACKAGE, file))
    }
  }

  for (const [key, target] of Object.entries(manifest.exports ?? {}))
    add(`kay${key.slice(1)}`, target)

  for (const [key, target] of Object.entries(manifest.imports ?? {}))
    add(key, target)

  return browserEntries = entries
}

function mentionsBrowser(value: unknown): boolean {
  if (typeof value !== 'object' || value === null)
    return false

  return 'browser' in value || Object.values(value).some(mentionsBrowser)
}

// A package picking its entry by the `browser` condition would give the test process another file than the bundle's, so it stays in the bundle.
function selectsByBrowser(resolved: string): boolean {
  const after = resolved.slice(resolved.lastIndexOf(NODE_MODULES) + NODE_MODULES.length).split(sep)
  const dir = resolved.slice(0, resolved.length - after.join(sep).length) + after.slice(0, after[0]!.startsWith('@') ? 2 : 1).join(sep)
  let known = packages.get(dir)

  if (known === undefined) {
    try {
      const manifest = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) as { browser?: unknown, exports?: unknown, imports?: unknown }

      known = manifest.browser !== undefined || mentionsBrowser(manifest.exports) || mentionsBrowser(manifest.imports)
    }
    catch {
      known = true
    }

    packages.set(dir, known)
  }

  return known
}

// Whether a file belongs to one of kay's libraries (kayjs-ui, kayjs-cms), by the name in the nearest package.json: its modules importing kay restart with each mount, as the library's state does on a page load, where an app's own are one instance with the test.
function inLibrary(path: string): boolean {
  const dir = dirname(path)
  let known = libraries.get(dir)

  if (known === undefined) {
    try {
      known = KAY_LIBRARY.test((JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) as { name?: string }).name ?? '')
    }
    catch {
      known = dir === dirname(dir) ? false : inLibrary(dir)
    }

    libraries.set(dir, known)
  }

  return known
}

// A package of the app's dependencies, whose own files are not walked; kay's libraries are, as they import kay.
function isDependency(resolved: string): boolean {
  return resolved.includes(NODE_MODULES) && !LIBRARY_FOLDER.test(resolved)
}

function versionOf(path: string): string {
  const stat = statSync(path, { throwIfNoEntry: false })

  return stat === undefined ? 'missing' : `${stat.mtimeMs}:${stat.size}`
}

function importsOf(path: string, loader: 'ts' | 'tsx' | 'js' | 'jsx'): { path: string }[] {
  let transpiler = transpilers.get(loader)

  if (!transpiler)
    transpilers.set(loader, transpiler = new Bun.Transpiler({ loader }))

  return transpiler.scanImports(readFileSync(path, 'utf8'))
}

// What one file asks of the bundle, from its own source alone.
function scan(path: string): Scanned {
  const version = versionOf(path)
  const known = scanned.get(path)

  if (known?.version === version)
    return known

  const loader = SCANNED.get(extname(path))
  const result: Scanned = { version, ok: true, imports: [] }

  scanned.set(path, result)

  if (loader === undefined)
    return result

  const fromKay = path.startsWith(KAY_SOURCE)
  const fromLibrary = !fromKay && inLibrary(path)

  try {
    const source = readFileSync(path, 'utf8')

    if (fromKay && (kayBrowserEntries().files.has(path) || DEFINED.test(source) || READS_PAGE.test(source.replace(LINE_COMMENT, '')))) {
      result.ok = false

      return result
    }

    for (const { path: specifier } of importsOf(path, loader)) {
      const reached = reach(specifier, dirname(path), fromKay, fromLibrary)

      if (reached === false) {
        result.ok = false

        break
      }

      if (reached !== undefined)
        result.imports.push(reached)
    }
  }
  catch {
    result.ok = false
  }

  return result
}

// The file an import leads to, undefined when there is none to look at (kay itself, a dependency), false when it cannot be shared.
function reach(specifier: string, from: string, fromKay: boolean, fromLibrary: boolean): string | false | undefined {
  if (KAY_LIBRARY.test(specifier))
    return false

  // A server module, which the browser build refuses with the chain of imports that reached it.
  if (specifier.startsWith('node:') || specifier.startsWith('bun:') || BUILTINS.has(specifier))
    return false

  if (kayBrowserEntries().specifiers.has(specifier))
    return false

  // The project's modules and kay's runtime are one instance for the test and the bundle, wherever kay is loaded from.
  if (!fromKay && KAY_SPECIFIER.test(specifier))
    return fromLibrary ? false : undefined

  let resolved: string

  try {
    resolved = Bun.resolveSync(specifier, from)
  }
  catch {
    return false
  }

  if (resolved.endsWith('.kay'))
    return false

  if (isDependency(resolved))
    return selectsByBrowser(resolved) ? false : undefined

  return resolved
}

// Whether a file, and every file of the project or of kay's runtime it imports, may be the test process's own instance in place of a copy in the bundle. Checking each file alone keeps a cycle from being judged half-walked.
function shareable(path: string, apiPrefixes: string[], known: Map<string, boolean>): boolean {
  const cached = known.get(path)

  if (cached !== undefined)
    return cached

  const seen = new Set<string>()
  const queue = [path]

  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    if (seen.has(next))
      continue

    seen.add(next)

    // An API module reaches the browser as the stub of where it is served, which its own load makes.
    if (apiPrefixes.some(prefix => next.startsWith(prefix)) || known.get(next) === false || !scan(next).ok) {
      known.set(path, false)

      return false
    }

    queue.push(...scan(next).imports)
  }

  // What a clean file imports is clean too, so a diamond of modules is walked once.
  for (const file of seen)
    known.set(file, true)

  return true
}

const SCRIPT = /\.[cm]?[jt]sx?$/
const EXPORT_STAR = /^export\s*\*\s*from\s*(['"])([^'"\n]+)\1/gm

// What the bundle imports from the test process rather than carrying: a module of the project or of kay's runtime, and a package, that needs nothing built for the browser, so a test importing the same file holds the same instance, a signal store's included, and `mock.module()` reaches the component's static and dynamic imports. A module importing a `.kay` file or one of the entries kay builds for the browser stays in the bundle, run afresh by each mount.
export function sharedModules(apiDirs: string[]): Bun.BunPlugin {
  const apiPrefixes = apiDirs.map(dir => dir + sep)
  const known = new Map<string, boolean>()

  // The file the bundle leaves to the test process for an import, undefined when it carries the file itself.
  function sharedFile(specifier: string, importer: string): string | undefined {
    // Entries kay builds for the browser, and the bundle's copies of `kay` and `kay/dom`, whose settings are the app's: their imports are what is shared.
    if (specifier.startsWith('node:') || specifier.startsWith('bun:') || KAY_SPECIFIER.test(specifier) || KAY_LIBRARY.test(specifier) || kayBrowserEntries().specifiers.has(specifier))
      return undefined

    let resolved: string

    try {
      resolved = Bun.resolveSync(specifier, dirname(importer) || process.cwd())
    }
    catch {
      return undefined
    }

    if (!SCANNED.has(extname(resolved)))
      return undefined

    return (isDependency(resolved) ? selectsByBrowser(resolved) : !shareable(resolved, apiPrefixes, known)) ? undefined : resolved
  }

  return {
    name: 'kay-shared-modules',
    setup(build) {
      build.onResolve({ filter: NOT_BUILTIN }, (args) => {
        if (args.kind === 'entry-point-build' || args.kind === 'entry-point-run' || args.namespace !== 'file' || !args.importer)
          return undefined

        const shared = sharedFile(args.path, args.importer)

        return shared === undefined ? undefined : { path: shared, external: true }
      })

      // Bun drops the import of an external module behind `export * from`, so the star names what the test process holds for the file.
      build.onLoad({ filter: SCRIPT, namespace: 'file' }, async ({ path }) => {
        if (path.includes(NODE_MODULES))
          return undefined

        const text = readFileSync(path, 'utf8')
        const stars = [...text.matchAll(EXPORT_STAR)]
        let contents = text

        for (const [statement, quote, specifier] of stars) {
          const shared = sharedFile(specifier!, path)

          if (shared === undefined)
            continue

          const names = Object.keys(await import(shared) as object).filter(name => name !== 'default')

          contents = contents.replace(statement, names.length === 0 ? `import ${quote}${specifier}${quote}` : `export { ${names.join(', ')} } from ${quote}${specifier}${quote}`)
        }

        return contents === text ? undefined : { contents, loader: SCANNED.get(extname(path))! }
      })
    },
  }
}
