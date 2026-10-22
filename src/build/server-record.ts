import type { Project } from '../project'
import type { ServerRecord } from '../server/server-record'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { KAY_SOURCE, recordName, ROOT_TOKEN, SERVER_DIR, SERVER_RECORD, UP_TOKEN } from '../server/server-record'
import { ASSET_FILE } from './assets'
import { capturedLoads } from './captured-loads'
import { serverParts } from './compile'
import { KAY_FILE, SCRIPT_FILE, scriptLoader, transpilerFor } from './files'
import { findKayLibraries, libraryOf, settingsReplacements } from './libraries'
import { kay } from './plugin'
import { splitEmbeddedMap } from './sourcemap'

const WASM_FILE = /\.wasm$/i
const NODE_MODULES = `${sep}node_modules${sep}`
const ICONS = '~icons/'

function resolved(specifier: string, importer: string): string | undefined {
  try {
    return realpathSync(Bun.resolveSync(specifier, dirname(importer)))
  }
  catch {
    // A builtin, or a module that is not there.
    return undefined
  }
}

// Dropped when a build starts, so its own prerender compiles the modules instead of importing the last build's.
export async function clearServerRecord(output: string): Promise<void> {
  await rm(join(output, SERVER_RECORD), { force: true })
  await rm(join(output, SERVER_DIR), { recursive: true, force: true })
}

// Records the modules a server started from this build loads, compiled as the `.kay` loader would: the modules of the routes, the API, the extensions and the content config, and everything they import that the loader changes, `.kay` components, imported assets, `import.meta.glob` calls and the library settings the app replaces.
// A server on disk imports them from the record instead of compiling them as they load, so it loads no compiler; one the record lacks is compiled then, and a build whose modules the record cannot hold, such as a load answering with something else than code or a module already holding a token, writes none.
export async function writeServerRecord(project: Project): Promise<void> {
  const { root, config, paths } = project
  const record = join(paths.output, SERVER_RECORD)
  const dir = join(paths.output, SERVER_DIR)

  await clearServerRecord(paths.output)

  const base = realpathSync(root)
  const settings = config.settings ?? {}
  const placeholder = config.images?.placeholder
  const { modules } = await serverParts(project)
  const { loads, modules: virtual, resolves } = await capturedLoads(kay({ target: 'ssr', root, cacheDir: paths.cache, settings, placeholder, embedMaps: true, mapName: file => file }))
  const libraries = await findKayLibraries(root)
  const replaced = settingsReplacements(root, settings).flatMap(({ paths: found }) => found.map(path => realpathSync(path)))
  const files: ServerRecord['files'] = {}
  const covered: ServerRecord['covered'] = {}
  const icons: ServerRecord['icons'] = {}
  const seen = new Set<string>()
  const queue = [...modules, ...existsSync(paths.entry) ? [paths.entry] : [], ...replaced].filter(path => existsSync(path)).map(path => realpathSync(path))
  // The files to write, by name: a module's text still holds the paths the token will stand for.
  const written = new Map<string, { contents: string, tokenised: boolean }>()
  const recorded = new Set<string>()
  const relativeTo = (path: string) => recordName(base, path)
  const kept = (name: string, contents: string, extension: string, tokenised = true): string => {
    const file = `${Bun.hash(name).toString(36)}.${extension}`

    written.set(file, { contents, tokenised })

    return file
  }
  // A module the record can hold: the project's own scripts, the kay libraries', and the components and assets anywhere.
  const inProject = (path: string) => path.startsWith(base + sep) && !path.slice(base.length).includes(NODE_MODULES)
  const followed = (path: string) => ASSET_FILE.test(path) || KAY_FILE.test(path) || (SCRIPT_FILE.test(path) && (libraryOf(libraries, path) !== undefined || inProject(path)))
  let unsupported = false

  for (let path = queue.pop(); path !== undefined; path = queue.pop()) {
    if (seen.has(path))
      continue

    seen.add(path)

    const load = loads.find(one => one.filter.test(path))
    const loader = ASSET_FILE.test(path) ? undefined : scriptLoader(KAY_FILE.test(path) ? 'x.ts' : path)
    let scanned = loader === undefined ? undefined : await Bun.file(path).text()
    let scanLoader = loader ?? 'ts'

    if (load !== undefined) {
      let result: Awaited<ReturnType<typeof load.callback>>

      try {
        result = await load.callback({ path, namespace: 'file', loader: loader ?? 'file', defer: async () => Promise.resolve() })
      }
      catch {
        // A file that does not compile fails where the server imports it, with the error that says why.
        continue
      }

      if (result === undefined || result === null)
        continue

      // A wasm file imported with `type: 'file'` answers with its own path.
      const contents = 'contents' in result && typeof result.contents === 'string' ? result.contents : ownPath(result)

      if (contents === undefined) {
        unsupported = true

        continue
      }

      const name = relativeTo(path)
      const hash = Bun.hash(await Bun.file(path).bytes()).toString(36)
      const asLoader = 'contents' in result ? result.loader ?? 'ts' : 'js'

      recorded.add(path)

      if (SCRIPT_FILE.test(path) && contents === scanned && result.loader === loader) {
        covered[name] = Bun.hash(contents).toString(36)
      }
      else {
        const { code, blob } = splitEmbeddedMap(contents)

        files[name] = { file: kept(name, code, asLoader), loader: asLoader as 'ts', hash, ...blob !== undefined && { map: kept(`${name}.map`, blob, 'map', false) } }
      }

      scanned = contents
      scanLoader = asLoader as typeof scanLoader
    }

    if (scanned === undefined)
      continue

    for (const { path: specifier } of transpilerFor(scanLoader).scanImports(scanned)) {
      if (specifier.startsWith(ICONS)) {
        const icon = virtual.get(specifier)

        if (icon !== undefined && icons[specifier] === undefined)
          icons[specifier] = kept(specifier, icon().contents, 'js')

        continue
      }

      const found = resolved(specifier, path)

      if (found === undefined)
        continue

      // The plugin reads the importer of a wasm file for the attributes of its import.
      if (WASM_FILE.test(specifier)) {
        for (const resolver of resolves.filter(one => one.filter.test(specifier)))
          await resolver.callback({ path: specifier, importer: path, namespace: 'file', resolveDir: dirname(path), kind: 'import-statement' })
      }

      if (followed(found))
        queue.push(found)
    }
  }

  // A module already holding a token would be rewritten when it loads.
  if (unsupported || [...written.values()].some(({ contents }) => contents.includes(ROOT_TOKEN) || contents.includes(UP_TOKEN)))
    return

  // The directory the token stands for: the root, or the one above holding every recorded module, which a library outside the root needs.
  // Kay's own components move with kay, not with the app.
  const common = commonDirectory([base, ...[...recorded].filter(path => !path.startsWith(KAY_SOURCE))])
  const anchorDir = dirname(common) === common ? base : common
  const upwards = relative(base, anchorDir).split(sep).join('/')
  // The root as it is named when it is linked, which a module may hold in place of its real path.
  const named = resolve(root)
  const tokens = (text: string) => {
    const inRoot = text.replaceAll(base + sep, `${ROOT_TOKEN}/`).replaceAll(named + sep, `${ROOT_TOKEN}/`)

    return upwards === '' ? inRoot : inRoot.replaceAll(anchorDir + sep, `${UP_TOKEN}/`)
  }

  for (const [file, { contents, tokenised }] of written)
    await Bun.write(join(dir, file), tokenised ? tokens(contents) : contents)

  await mkdir(dirname(record), { recursive: true })
  await Bun.write(record, JSON.stringify({ settings, ...placeholder === false && { placeholder }, ...upwards !== '' && { anchor: upwards }, files, covered, icons, replaced: replaced.map(path => relative(base, path).split(sep).join('/')).sort() } satisfies ServerRecord))
}

// The module a wasm file imported with `type: 'file'` loads as, which answers with the file's own path.
function ownPath(result: object): string | undefined {
  const exported = 'exports' in result && 'loader' in result && result.loader === 'object' ? (result.exports as { default?: unknown } | undefined)?.default : undefined

  return typeof exported === 'string' ? `export default ${JSON.stringify(exported)}\n` : undefined
}

// The deepest directory holding every path.
function commonDirectory(paths: string[]): string {
  const [first = [], ...others] = paths.map(path => path.split(sep))
  let length = 0

  while (length < first.length && others.every(other => other[length] === first[length]))
    length++

  return first.slice(0, length).join(sep) || sep
}
