import type { BunPlugin } from 'bun'
import { dirname, sep } from 'node:path'
import { parseKay } from '../compiler/parser'

const KAY_FILE = /\.kay$/
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/
const CSS_FILE = /\.css$/
const ABSOLUTE_URL = /^\//
const TYPESCRIPT = /\.[cm]?ts$/
const TSX = /\.tsx$/
const JSX = /\.jsx$/

// For the stylesheet build: components and modules shrink to their imports, so Bun follows them down to every stylesheet a page uses.
// A page's server code is left out, and nothing outside the project but stylesheets is followed: no server-only module ever reaches the bundler.
export function styleImports(root: string): BunPlugin {
  const transpilers = new Map<Bun.JavaScriptLoader, Bun.Transpiler>()
  const transpiler = (loader: Bun.JavaScriptLoader) => {
    let found = transpilers.get(loader)

    if (!found)
      transpilers.set(loader, found = new Bun.Transpiler({ loader }))

    return found
  }
  const project = root + sep
  const keep = (specifier: string, importer: string): string | undefined => {
    let resolved: string

    try {
      resolved = Bun.resolveSync(specifier, dirname(importer))
    }
    catch {
      return undefined
    }

    if (CSS_FILE.test(resolved))
      return resolved

    return resolved.startsWith(project) && !resolved.includes(`${sep}node_modules${sep}`) && (KAY_FILE.test(resolved) || SCRIPT_FILE.test(resolved)) ? resolved : undefined
  }
  const imports = (code: string, importer: string, loader: Bun.JavaScriptLoader) => transpiler(loader).scanImports(code).map(({ path }) => keep(path, importer)).filter(path => path !== undefined).map(path => `import ${JSON.stringify(path)}\n`).join('')

  return {
    name: 'kay-styles',
    setup(build) {
      build.onLoad({ filter: KAY_FILE }, async ({ path }) => {
        // A component's imports all sit in its script; the server fence is left out.
        const source = await Bun.file(path).text()
        const script = parseKay(source).script

        return { contents: script ? imports(source.slice(script.start, script.end), path, 'ts') : '', loader: 'js' }
      })
      build.onLoad({ filter: SCRIPT_FILE }, async ({ path }) => ({ contents: imports(await Bun.file(path).text(), path, scriptLoader(path)), loader: 'js' }))
      // `url(/logo.png)` points at a public file the server serves as is.
      build.onResolve({ filter: ABSOLUTE_URL }, ({ path, importer }) => CSS_FILE.test(importer) ? { path, external: true } : undefined)
    },
  }
}

function scriptLoader(path: string): Bun.JavaScriptLoader {
  if (TYPESCRIPT.test(path))
    return 'ts'

  if (TSX.test(path))
    return 'tsx'

  return JSX.test(path) ? 'jsx' : 'js'
}

// For the island build: stylesheets reach the page through the stylesheet build, so the browser code leaves them out.
export function withoutStyles(): BunPlugin {
  return {
    name: 'kay-without-styles',
    setup(build) {
      build.onLoad({ filter: CSS_FILE }, () => ({ contents: '', loader: 'js' }))
    },
  }
}
