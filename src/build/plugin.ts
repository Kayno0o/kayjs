import type { BunPlugin } from 'bun'
import type { ClassTable } from '../runtime/class-table'
import type { RouteMount } from '../server/routes'
import type { Target } from './transform'
import type { WorkerBundle, WorkerResult } from './worker-bundle'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { ISLAND_TWIN, withoutTwin } from '../compiler'
import { KayError } from '../compiler/errors'
import { RESIZABLE } from '../runtime/image'
import { dominantColorOf } from '../server/image-color'
import { imageHeader } from '../server/image-format'
import { ASSET_FILE, clientDir, RENDER_OUTPUT, writeAsset } from './assets'
import { directImports } from './direct-imports'
import { SCRIPT_FILE, scriptLoader } from './files'
import { expandGlobs } from './glob'
import { iconModule, iconNames, installedIconSets } from './icons'
import { settingsReplacements } from './libraries'
import { liveIds } from './live-ids'
import { embeddedMapCached, transformKayCached } from './transform'

export interface KayPluginOptions {
  // Defaults to `dom` when bundling for the browser and `ssr` everywhere else, the Bun runtime included.
  target?: Target | undefined
  // On by default: islands hydrate the server markup instead of re-rendering it.
  hydratable?: boolean | undefined
  // Island ids are relative to this directory, and imported assets are written under its `.kay/client`; defaults to the working directory.
  root?: string | undefined
  // Keeps compiled files here between runs; off when unset.
  cacheDir?: string | undefined
  // `false` reads no imported image for the color its box shows until it loads: `images.placeholder`.
  placeholder?: false | undefined
  // The app's own module for a library's settings, by the library's name, relative to the root: `kay.config.ts`'s `settings`.
  settings?: Record<string, string> | undefined
  // A module every component imports, which ties the runtime it uses to the chunk the page loads first: see runtime-chunk.ts.
  anchor?: string | undefined
  // The runtime's lazy modules, which import `anchor` too.
  anchored?: ReadonlySet<string> | undefined
  // Development: every element carries its source position, for `kay dev`'s inspector.
  inspect?: boolean | undefined
  // The classes a later Tailwind class overrides, with which an island's literal classes resolve while compiling.
  classTable?: ClassTable | undefined
  // A browser build's API trees, whose modules islands get as stubs, and the modules it leaves to the page, which a worker's bundle takes as the islands do.
  api?: RouteMount[] | undefined
  external?: string[] | undefined
  // Points an import of names from `kay` at the runtime modules holding them: see direct-imports.ts.
  direct?: boolean | undefined
  // An executable's modules carry their own source map, for it to map the stacks of the errors it meets to `.kay` lines with no compiler: they register it under the path Bun shows for the file, relative to the working directory.
  embedMaps?: boolean | undefined
  // Rewrites a project module's source before the rest of the plugin reads it: the executable's `kay.config.ts` without its build plugins.
  rewrite?: ((file: string, source: string) => string) | undefined
}

// A static component imports its `?island` twin, the build of it that renders inside islands, as a module of its own.
const KAY_FILE = /\.kay(?:\?island)?$/
const TWIN_IMPORT = /\.kay\?island$/
// Where the bundler keeps twins: unlike the runtime loader, it resolves no specifier holding a `?`.
const TWIN_NAMESPACE = 'kay-island'
const ICON_SPECIFIER = /^~icons\//
const ICON_NAMESPACE = 'kay-icon'
const ANY = /.*/
// `new URL('file', import.meta.url)`, the way a module names a file shipped beside it: a relative path with no scheme, query or template part.
const FILE_URL = /new\s+URL\(\s*(["'`])((?:\.{1,2}\/)*[\w@-][^"'`\n$?#:]*)\1\s*,\s*import\.meta\.url\s*\)/g
const WASM_FILE = /\.wasm$/i
const WORKER_BUNDLE = join(import.meta.dir, 'worker-bundle.ts')

// The workers this process bundled, kept while the files they read and wrote are as they were: `kay dev` builds the same workers again with every edit, and a process each is most of what a build costs.
const bundledWorkers = new Map<string, { result: WorkerResult, stamp: string }>()

function stampOf(files: string[]): string {
  return files.map((file) => {
    const stat = statSync(file, { throwIfNoEntry: false })

    return `${stat?.mtimeMs}:${stat?.size}`
  }).join(',')
}

// `withColor` is on for the server's bundle alone: an island has the server's markup, so the color would only weigh on what it downloads.
async function assetModule(path: string, url: string, withColor: boolean, cacheDir: string | undefined): Promise<string> {
  if (!RESIZABLE.test(path))
    return `export default ${JSON.stringify(url)}`

  let size: { width: number, height: number, animated: boolean }

  // A file kay cannot decode is still served at its URL, with no variants, and so is an animated GIF, which a variant would flatten.
  try {
    size = await imageHeader(Bun.file(path))
  }
  catch {
    return `export default ${JSON.stringify(url)}`
  }

  if (size.animated)
    return `export default ${JSON.stringify(url)}`

  const color = withColor ? await dominantColorOf(path, cacheDir) : undefined

  if (color === undefined)
    return `import { registerImage } from 'kay/internal'\nexport default registerImage(${JSON.stringify(url)}, ${size.width}, ${size.height})`

  return `import { registerImage, registerPlaceholder } from 'kay/internal'\nexport default registerPlaceholder(registerImage(${JSON.stringify(url)}, ${size.width}, ${size.height}), ${JSON.stringify(color)})`
}

export function kay(options: KayPluginOptions = {}): BunPlugin {
  return kayPlugin(options, [])
}

// `workers`: in a worker's own bundle, the modules started as workers on the way to it, itself last.
export function kayPlugin(options: KayPluginOptions, workers: string[]): BunPlugin {
  return {
    name: 'kay',
    setup(build) {
      const target = options.target ?? (build.config?.target === 'browser' ? 'dom' : 'ssr')
      const root = options.root ?? process.cwd()
      // The project's TypeScript modules, read for their `import.meta.glob` calls, by their real path as Bun loads them.
      const realRoot = realpathSync(root)
      const projectScript = new RegExp(`^${RegExp.escape(realRoot + sep)}(?!(?:.*/)?node_modules/).*\\.(?:m?ts|tsx)$`)

      // A browser build ships the files its modules point at with `new URL`: a script bundled as a worker of its own, anything else as an asset. Each URL is relative to the module's chunk, so it holds under any base.
      // A build kept in memory, such as the one finding the runtime's chunk, writes nothing and leaves them as written.
      const browser = build.config?.target === 'browser' && build.config.outdir !== undefined
      const config = build.config
      const bundled = new Map<string, Promise<string>>()
      // Bun runs the plugin's callbacks outside the scope `inOutput` set, so the folder is read here.
      const dist = clientDir(root)

      const bundleWorker = async (path: string): Promise<string> => {
        const bundle: WorkerBundle = { entry: path, outdir: join(dist, 'assets'), minify: config.minify ?? false, define: config.define ?? {}, options: { ...options, root, anchor: undefined, anchored: undefined }, workers: [...workers, path] }
        const key = JSON.stringify(bundle)
        const kept = bundledWorkers.get(key)

        if (kept !== undefined && kept.result.outputs.every(output => existsSync(output)) && stampOf(kept.result.inputs) === kept.stamp)
          return kept.result.name

        const started = Date.now()
        // The bundle goes on stdin, as the class table it carries outgrows what one argument may hold; the command names the entry alone, which the process list shows.
        const child = Bun.spawn([process.execPath, WORKER_BUNDLE, path], { cwd: root, env: { ...process.env, [RENDER_OUTPUT]: basename(dirname(dist)) }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })

        // Written through the pipe, not as a `Blob`: under a DOM test the global `Blob` is the DOM's, which `Bun.spawn` refuses.
        void child.stdin.write(key)
        void child.stdin.end()
        const [name, problems, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

        if (code !== 0)
          throw new KayError('worker-build', `kay: the worker ${path} failed to build:\n${problems.trim()}`)

        let result: WorkerResult

        try {
          result = JSON.parse(name) as WorkerResult
        }
        catch {
          throw new KayError('worker-build', `kay: the worker ${path} printed output where its name was expected:\n${name.trim()}`)
        }

        // A file written while the bundle ran may not be the one it read.
        if (!result.ships && result.inputs.every(input => (statSync(input, { throwIfNoEntry: false })?.mtimeMs ?? 0) < started))
          bundledWorkers.set(key, { result, stamp: stampOf(result.inputs) })

        return result.name
      }

      const fileUrl = async (file: string, specifier: string): Promise<string | undefined> => {
        const path = resolve(dirname(file), specifier)

        if (statSync(path, { throwIfNoEntry: false })?.isFile() !== true)
          return undefined

        // An emscripten module starts itself as its threads' worker.
        if (path === workers.at(-1))
          return 'import.meta.url'

        if (workers.includes(path))
          throw new KayError('worker-build', `kay: the worker ${path} starts itself again through ${workers.slice(workers.indexOf(path) + 1).join(', ')}`)

        let name: string

        if (SCRIPT_FILE.test(path)) {
          if (!bundled.has(path))
            bundled.set(path, bundleWorker(path))

          name = await bundled.get(path)!
        }
        else {
          const url = await writeAsset(path, root, dist)

          name = url.slice(url.lastIndexOf('/') + 1)
        }

        // A worker's bundle sits in the assets beside the files it points at, the islands' chunks one directory up.
        return JSON.stringify(`./${workers.length > 0 ? '' : 'assets/'}${name}`)
      }

      const shippingFiles = async (source: string, file: string, loader: Bun.JavaScriptLoader): Promise<string> => {
        if (!browser || !source.includes('import.meta.url'))
          return source

        const urls = new Map<string, string | undefined>()

        // Read off the transpiled code, which drops comments, so a call a comment shows ships nothing.
        for (const [, , specifier] of new Bun.Transpiler({ loader }).transformSync(source).matchAll(FILE_URL)) {
          if (!urls.has(specifier!))
            urls.set(specifier!, await fileUrl(file, specifier!))
        }

        return source.replace(FILE_URL, (call: string, _quote: string, specifier: string) => {
          const url = urls.get(specifier)

          return url === undefined ? call : `new URL(${url}, import.meta.url)`
        })
      }

      const anchoring = (path: string, contents: string) => options.anchored?.has(path) === true ? `${contents}\nimport ${JSON.stringify(options.anchor)}\n` : contents

      const pointed = async (contents: string, loader: Bun.JavaScriptLoader = 'ts') => options.direct === true ? directImports(contents, loader) : contents

      // A twin's frames show its namespace and the whole path, where a file's show its path from where the build ran.
      const load = async (file: string, twin = false) => {
        const source = await Bun.file(withoutTwin(file)).text()

        const code = await transformKayCached(source, file, { target, hydratable: options.hydratable ?? true, root: options.root, cacheDir: options.cacheDir, inspect: options.inspect, classTable: options.classTable })
        const contents = await pointed(await shippingFiles(expandGlobs(code, withoutTwin(file), root, 'ts'), withoutTwin(file), 'ts'))

        const anchored = options.anchor !== undefined && options.anchor !== '' ? `${contents}\nimport ${JSON.stringify(options.anchor)}\n` : contents
        const map = options.embedMaps === true ? await embeddedMapCached(source, file, code, options.cacheDir) : undefined

        return { contents: map === undefined ? anchored : `${anchored}\nimport { registerEmbeddedMap } from 'kay/internal/server'\nregisterEmbeddedMap(${JSON.stringify(twin ? `${TWIN_NAMESPACE}:${file}` : relative(process.cwd(), file))}, ${JSON.stringify(map)})\n`, loader: 'ts' as const }
      }

      build.onLoad({ filter: KAY_FILE }, async ({ path }) => load(path))

      const iconSets = installedIconSets(root)

      // Only a bundle has a config; the runtime loader takes the specifier as it is.
      if (build.config !== undefined) {
        build.onResolve({ filter: TWIN_IMPORT }, ({ path, importer }) => ({ path: `${resolve(dirname(importer), withoutTwin(path))}${ISLAND_TWIN}`, namespace: TWIN_NAMESPACE }))
        build.onLoad({ filter: KAY_FILE, namespace: TWIN_NAMESPACE }, async ({ path }) => load(path, true))
        build.onResolve({ filter: ICON_SPECIFIER }, ({ path }) => ({ path, namespace: ICON_NAMESPACE }))
        build.onLoad({ filter: ANY, namespace: ICON_NAMESPACE }, ({ path }) => ({ contents: iconModule(iconSets, path), loader: 'js' }))
      }
      // The runtime resolves no made-up specifier through a plugin, so every icon of the installed sets is a virtual module, built when first imported.
      else {
        for (const [prefix, file] of iconSets) {
          for (const name of iconNames(prefix, file))
            build.module(`~icons/${name}`, () => ({ contents: iconModule(iconSets, `~icons/${name}`), loader: 'js' }))
        }
      }

      // A library's settings module loads as the app's own, wherever the library imports it from.
      for (const { paths, replacement } of settingsReplacements(root, options.settings ?? {})) {
        for (const path of paths)
          build.onLoad({ filter: new RegExp(`^${RegExp.escape(path)}$`) }, () => ({ contents: `export * from ${JSON.stringify(replacement)}\nexport { default } from ${JSON.stringify(replacement)}\n`, loader: 'ts' }))
      }

      // `with { type: 'file' }` asks for a wasm module's own path, as a server reading it does; a plugin sees no import's attributes, so they are read in the importer.
      const fileImports = new Set<string>()

      build.onResolve({ filter: WASM_FILE }, ({ path, importer }) => {
        // Bun resolves some imports a second time from the importer's directory.
        if (statSync(importer, { throwIfNoEntry: false })?.isFile() === true && new RegExp(`(["'])${RegExp.escape(path)}\\1\\s*with\\s*\\{\\s*type\\s*:\\s*(["'])file\\2`).test(readFileSync(importer, 'utf8')))
          fileImports.add(realpathSync(Bun.resolveSync(path, dirname(importer))))

        return undefined
      })

      // `import logo from './logo.png'` gives the URL the server serves it at, on the server and in islands alike; an image also records its size for `image()`.
      build.onLoad({ filter: ASSET_FILE }, async ({ path }) => {
        // Bun has no default to fall back on here: returning nothing from a wasm module's load crashes it.
        if (fileImports.has(path))
          return build.config === undefined ? { exports: { default: path }, loader: 'object' } : { contents: await Bun.file(path).bytes(), loader: 'file' }

        return { contents: await assetModule(path, await writeAsset(path, root, dist), target === 'ssr' && options.placeholder !== false, options.cacheDir), loader: 'js' }
      })

      // Last, as it takes every module: the runtime loader hands a module without a call back as it is, where the bundler loads it itself.
      build.onLoad({ filter: projectScript }, async ({ path }) => {
        const original = await Bun.file(path).text()
        const source = options.rewrite?.(path, original) ?? original
        const loader = scriptLoader(path)
        const contents = anchoring(path, await pointed(await shippingFiles(liveIds(expandGlobs(source, path, root, loader), path, realRoot, loader === 'tsx' || loader === 'jsx', build.config?.target !== 'browser'), path, loader), loader))

        return contents === original && build.config !== undefined ? undefined : { contents, loader }
      })

      // A package's modules, read only for the files they point at; the project's own were read above.
      if (browser) {
        build.onLoad({ filter: SCRIPT_FILE }, async ({ path }) => {
          if (projectScript.test(path))
            return undefined

          const source = await Bun.file(path).text()
          const contents = anchoring(path, await pointed(await shippingFiles(source, path, scriptLoader(path)), scriptLoader(path)))

          return contents === source ? undefined : { contents, loader: scriptLoader(path) }
        })
      }
    },
  }
}
