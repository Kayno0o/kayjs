import type { BunPlugin } from 'bun'
import type { KayLibrary } from './libraries'
import { readFileSync, statSync } from 'node:fs'
import { dirname, sep } from 'node:path'
import { withoutTwin } from '../compiler'
import { parseKay } from '../compiler/parser'
import { projectPaths } from '../project'
import { ASSET_FILE, writeAsset } from './assets'
import { collectionComponents, importedNames, rendersContent } from './collection-components'
import { scriptLoader, transpilerFor } from './files'
import { globbedFiles } from './glob'
import { libraryOf } from './libraries'

const KAY_FILE = /\.kay$/
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/
const CSS_FILE = /\.css$/
const ABSOLUTE_URL = /^\//
// `import css from './x.css' with { type: 'text' }` and its dynamic form: the file's text, read by the module, which no stylesheet build follows.
const TEXT_IMPORT = /\bfrom\s*(['"])([^'"\n]+)\1\s*(?:with|assert)\s*\{[^}]*\btype\s*:\s*(['"])text\3[^}]*\}|\bimport\(\s*(['"])([^'"\n]+)\4\s*,\s*\{\s*with\s*:\s*\{[^}]*\btype\s*:\s*(['"])text\6[^}]*\}\s*(?:,\s*)?\}\s*\)/g
const ANY = /.*/
const CSS_TEXT = 'kay-css-text'

// The specifiers `code` imports as text, each with how many times.
function textImports(code: string): Map<string, number> {
  const texts = new Map<string, number>()

  for (const match of code.matchAll(TEXT_IMPORT)) {
    const specifier = match[2] ?? match[5]!

    texts.set(specifier, (texts.get(specifier) ?? 0) + 1)
  }

  return texts
}

// What `code` imports, but for its text imports: each one drops one import of its specifier, so the same file imported for its effect too still counts.
function importedSpecifiers(code: string, loader: Bun.JavaScriptLoader): string[] {
  const texts = textImports(code)

  return transpilerFor(loader).scanImports(code).flatMap(({ path }) => {
    const left = texts.get(path) ?? 0

    if (left === 0)
      return [path]

    texts.set(path, left - 1)

    return []
  })
}

// A module importing each of these files for what it brings along.
function importing(paths: string[]): string {
  return paths.map(path => `import ${JSON.stringify(path)}\n`).join('')
}

// For the stylesheet build: components and modules shrink to their imports, so Bun follows them down to every stylesheet a page uses, and the assets they import are written for the server to serve.
// A page's server code is left out but for its assets, the components and stylesheets it imports, and the components of the collections whose entries it renders, and nothing outside the project but stylesheets is followed: no server-only module ever reaches the bundler.
export function styleImports(root: string, libraries: KayLibrary[] = []): BunPlugin {
  const project = root + sep
  // Tailwind reads the class names of every module the bundle parses, so importing the ones kay collected from the `.class` shorthand hands them over with no `@source` line.
  const classes = `import ${JSON.stringify(projectPaths(root).classes)}\n`
  const resolve = (specifier: string, importer: string): string | undefined => {
    try {
      return Bun.resolveSync(specifier, dirname(importer))
    }
    catch {
      return undefined
    }
  }
  const inProject = (path: string) => path.startsWith(project) && !path.includes(`${sep}node_modules${sep}`)
  // A kay library's components and modules are followed as the app's own are.
  const followed = (path: string) => CSS_FILE.test(path) || ((inProject(path) || libraryOf(libraries, path) !== undefined) && (KAY_FILE.test(path) || SCRIPT_FILE.test(path)))
  const scan = (code: string, importer: string, loader: Bun.JavaScriptLoader) => [...importedSpecifiers(code, loader).map(path => resolve(path, importer)).filter(path => path !== undefined), ...globbedFiles(code, importer, root, loader)]
  const imports = async (code: string, importer: string, loader: Bun.JavaScriptLoader) => {
    const paths = scan(code, importer, loader)

    await Promise.all(paths.filter(path => ASSET_FILE.test(path)).map(async path => writeAsset(path, root)))

    return importing(paths.filter(followed))
  }
  // Server code never reaches the bundler, but the assets it imports, through the project's modules too, are written all the same.
  const walked = new Set<string>()
  const serverAssets = async (code: string, importer: string, loader: Bun.JavaScriptLoader): Promise<void> => {
    await Promise.all(scan(code, importer, loader).map(async (path) => {
      if (ASSET_FILE.test(path)) {
        await writeAsset(path, root)

        return
      }

      if (!inProject(path) || !SCRIPT_FILE.test(path) || walked.has(path))
        return

      walked.add(path)
      await serverAssets(await Bun.file(path).text(), path, scriptLoader(path))
    }))
  }

  // A component the server code imports renders on the page as one the script imports does, so its stylesheets, and the ones the server code imports itself, are the page's too.
  const serverStyles = (code: string, importer: string) => importing(scan(code, importer, 'ts').filter(path => (KAY_FILE.test(path) || CSS_FILE.test(path)) && followed(path)))

  // A collection's components render inside the Markdown of its entries, so a page rendering one's `Content` renders those of every collection its server code imports.
  const collections = new Map<string, Promise<Map<string, string[]>>>()
  const readCollections = async (module: string) => collectionComponents(await Bun.file(module).text())
  const contentImports = async (code: string, importer: string) => {
    const files = await Promise.all([...importedNames(code)].map(async ([specifier, names]) => {
      const module = resolve(specifier, importer)

      if (module === undefined || !SCRIPT_FILE.test(module) || !(inProject(module) || libraryOf(libraries, module) !== undefined))
        return []

      const exported = collections.get(module) ?? readCollections(module)

      collections.set(module, exported)

      return [...await exported].flatMap(([name, components]) => names.has(name) || names.has('*') ? components.flatMap(component => resolve(component, module) ?? []) : [])
    }))

    return importing([...new Set(files.flat())].filter(followed))
  }

  return {
    name: 'kay-styles',
    setup(build) {
      build.onLoad({ filter: KAY_FILE }, async ({ path }) => {
        const source = await Bun.file(path).text()
        const { script, server, template } = parseKay(source)
        const styles = server ? serverStyles(source.slice(server.start, server.end), path) : ''
        const [contents, content] = await Promise.all([
          script ? imports(source.slice(script.start, script.end), path, 'ts') : '',
          server && rendersContent(template) ? contentImports(source.slice(server.start, server.end), path) : '',
          server ? serverAssets(source.slice(server.start, server.end), path, 'ts') : undefined,
        ])

        return { contents: classes + contents + styles + content, loader: 'js' }
      })
      build.onLoad({ filter: SCRIPT_FILE }, async ({ path }) => ({ contents: await imports(await Bun.file(path).text(), path, scriptLoader(path)), loader: 'js' }))
      // `url(/logo.png)` points at a public file the server serves as is.
      build.onResolve({ filter: ABSOLUTE_URL }, ({ path, importer }) => CSS_FILE.test(importer) ? { path, external: true } : undefined)
    },
  }
}

// For the island and executable builds: stylesheets reach the page through the stylesheet build, so the code leaves them out, but for a text import, which gives a module the file's text.
// A plugin sees no import's attributes, so they are read in the importer; a text import resolves apart, as its own module, so the same file imported for its effect elsewhere still brings nothing.
export function withoutStyles(): BunPlugin {
  return {
    name: 'kay-without-styles',
    setup(build) {
      build.onResolve({ filter: CSS_FILE }, ({ path, importer }) => {
        const file = withoutTwin(importer)

        // Bun resolves some imports a second time from the importer's directory.
        if (statSync(file, { throwIfNoEntry: false })?.isFile() !== true || !textImports(readFileSync(file, 'utf8')).has(path))
          return undefined

        return { path: Bun.resolveSync(path, dirname(file)), namespace: CSS_TEXT }
      })
      build.onLoad({ filter: ANY, namespace: CSS_TEXT }, async ({ path }) => ({ contents: await Bun.file(path).text(), loader: 'text' }))
      build.onLoad({ filter: CSS_FILE }, () => ({ contents: '', loader: 'js' }))
    },
  }
}
