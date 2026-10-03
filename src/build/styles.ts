import type { BunPlugin } from 'bun'
import { dirname, sep } from 'node:path'
import { parseKay } from '../compiler/parser'
import { ASSET_FILE, writeAsset } from './assets'

const KAY_FILE = /\.kay$/
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/
const CSS_FILE = /\.css$/
const ABSOLUTE_URL = /^\//
const TYPESCRIPT = /\.[cm]?ts$/
const TSX = /\.tsx$/
const JSX = /\.jsx$/

// For the stylesheet build: components and modules shrink to their imports, so Bun follows them down to every stylesheet a page uses, and the assets they import are written for the server to serve.
// A page's server code is left out but for its assets, and nothing outside the project but stylesheets is followed: no server-only module ever reaches the bundler.
export function styleImports(root: string): BunPlugin {
  const transpilers = new Map<Bun.JavaScriptLoader, Bun.Transpiler>()
  const transpiler = (loader: Bun.JavaScriptLoader) => {
    let found = transpilers.get(loader)

    if (!found)
      transpilers.set(loader, found = new Bun.Transpiler({ loader }))

    return found
  }
  const project = root + sep
  const resolve = (specifier: string, importer: string): string | undefined => {
    try {
      return Bun.resolveSync(specifier, dirname(importer))
    }
    catch {
      return undefined
    }
  }
  const followed = (path: string) => CSS_FILE.test(path) || (path.startsWith(project) && !path.includes(`${sep}node_modules${sep}`) && (KAY_FILE.test(path) || SCRIPT_FILE.test(path)))
  // With `assetsOnly`, the code is server code: its assets are written, nothing is followed.
  const imports = async (code: string, importer: string, loader: Bun.JavaScriptLoader, assetsOnly = false) => {
    const paths = transpiler(loader).scanImports(code).map(({ path }) => resolve(path, importer)).filter(path => path !== undefined)

    await Promise.all(paths.filter(path => ASSET_FILE.test(path)).map(async path => writeAsset(path, root)))

    return assetsOnly ? '' : paths.filter(followed).map(path => `import ${JSON.stringify(path)}\n`).join('')
  }

  return {
    name: 'kay-styles',
    setup(build) {
      build.onLoad({ filter: KAY_FILE }, async ({ path }) => {
        const source = await Bun.file(path).text()
        const { script, server } = parseKay(source)
        const [contents] = await Promise.all([
          script ? imports(source.slice(script.start, script.end), path, 'ts') : '',
          server && imports(source.slice(server.start, server.end), path, 'ts', true),
        ])

        return { contents, loader: 'js' }
      })
      build.onLoad({ filter: SCRIPT_FILE }, async ({ path }) => ({ contents: await imports(await Bun.file(path).text(), path, scriptLoader(path)), loader: 'js' }))
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
