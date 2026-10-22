import type { Project } from '../project'
import type { ServerRecord } from '../server/server-record'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { ROOT_TOKEN, SERVER_DIR, SERVER_RECORD } from '../server/server-record'
import { ASSET_FILE } from './assets'
import { capturedLoads } from './captured-loads'
import { serverParts } from './compile'
import { KAY_FILE, SCRIPT_FILE, scriptLoader, transpilerFor } from './files'
import { findKayLibraries, libraryOf, settingsReplacements } from './libraries'
import { kay } from './plugin'

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
// A server on disk imports them from the record instead of compiling them as they load, so it loads no compiler; one the record lacks is compiled then, and a build whose modules the record cannot hold, such as one importing a wasm file by its path, writes none.
export async function writeServerRecord(project: Project): Promise<void> {
  const { root, config, paths } = project
  const record = join(paths.output, SERVER_RECORD)
  const dir = join(paths.output, SERVER_DIR)

  await clearServerRecord(paths.output)

  const base = realpathSync(root)
  const settings = config.settings ?? {}
  const placeholder = config.images?.placeholder
  const { modules } = await serverParts(project)
  const { loads, modules: virtual } = await capturedLoads(kay({ target: 'ssr', root, cacheDir: paths.cache, settings, placeholder, embedMaps: true, mapName: file => file }))
  const libraries = await findKayLibraries(root)
  const replaced = settingsReplacements(root, settings).flatMap(({ paths: found }) => found.map(path => realpathSync(path)))
  const files: ServerRecord['files'] = {}
  const covered = new Set<string>()
  const icons: ServerRecord['icons'] = {}
  const seen = new Set<string>()
  const queue = [...modules, ...existsSync(paths.entry) ? [paths.entry] : [], ...replaced].filter(path => existsSync(path)).map(path => realpathSync(path))
  const written = new Map<string, string>()
  const relativeTo = (path: string) => relative(base, path).split(sep).join('/')
  const kept = async (name: string, contents: string, loader: string): Promise<string> => {
    const file = `${Bun.hash(name).toString(36)}.${loader}`

    if (!written.has(file)) {
      await Bun.write(join(dir, file), contents.replaceAll(base + sep, `${ROOT_TOKEN}/`))
      written.set(file, name)
    }

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

      if (!('contents' in result) || typeof result.contents !== 'string') {
        unsupported = true

        continue
      }

      const name = relativeTo(path)

      if (SCRIPT_FILE.test(path) && result.contents === scanned && result.loader === loader)
        covered.add(name)
      else
        files[name] = { file: await kept(name, result.contents, result.loader ?? 'ts'), loader: (result.loader ?? 'ts') as 'ts', hash: Bun.hash(await Bun.file(path).bytes()).toString(36) }

      scanned = result.contents
      scanLoader = (result.loader ?? 'ts') as typeof scanLoader
    }

    if (scanned === undefined)
      continue

    for (const { path: specifier } of transpilerFor(scanLoader).scanImports(scanned)) {
      if (specifier.startsWith(ICONS)) {
        const icon = virtual.get(specifier)

        if (icon !== undefined && icons[specifier] === undefined)
          icons[specifier] = await kept(specifier, icon().contents, 'js')

        continue
      }

      const found = resolved(specifier, path)

      if (found === undefined)
        continue

      if (WASM_FILE.test(found))
        unsupported = true
      else if (followed(found))
        queue.push(found)
    }
  }

  if (unsupported) {
    await rm(dir, { recursive: true, force: true })

    return
  }

  await mkdir(dirname(record), { recursive: true })
  await Bun.write(record, JSON.stringify({ settings, ...placeholder === false && { placeholder }, files, covered: [...covered].sort(), icons, replaced: replaced.map(relativeTo).sort() } satisfies ServerRecord))
}
