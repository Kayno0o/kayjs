import type { BunPlugin } from 'bun'
import type { Target } from './transform'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { ISLAND_TWIN, withoutTwin } from '../compiler'
import { RESIZABLE } from '../runtime/image'
import { ASSET_FILE, writeAsset } from './assets'
import { iconModule, iconNames, installedIconSets } from './icons'
import { settingsReplacements } from './libraries'
import { transformKayCached } from './transform'

export interface KayPluginOptions {
  // Defaults to `dom` when bundling for the browser and `ssr` everywhere else, the Bun runtime included.
  target?: Target | undefined
  // On by default: islands hydrate the server markup instead of re-rendering it.
  hydratable?: boolean | undefined
  // Island ids are relative to this directory, and imported assets are written under its `.kay/client`; defaults to the working directory.
  root?: string | undefined
  // Keeps compiled files here between runs; off when unset.
  cacheDir?: string | undefined
  // The app's own module for a library's settings, by the library's name, relative to the root: `kay.config.ts`'s `settings`.
  settings?: Record<string, string> | undefined
  // A module every component imports, which ties the runtime it uses to the chunk the page loads first: see runtime-chunk.ts.
  anchor?: string | undefined
  // Development: every element carries its source position, for `kay dev`'s inspector.
  inspect?: boolean | undefined
}

// A static component imports its `?island` twin, the build of it that renders inside islands, as a module of its own.
const KAY_FILE = /\.kay(?:\?island)?$/
const TWIN_IMPORT = /\.kay\?island$/
// Where the bundler keeps twins: unlike the runtime loader, it resolves no specifier holding a `?`.
const TWIN_NAMESPACE = 'kay-island'
const ICON_SPECIFIER = /^~icons\//
const ICON_NAMESPACE = 'kay-icon'
const ANY = /.*/

async function assetModule(path: string, url: string): Promise<string> {
  if (!RESIZABLE.test(path))
    return `export default ${JSON.stringify(url)}`

  let size: { width: number, height: number }

  // A file Bun cannot decode is still served at its URL, with no variants.
  try {
    size = await new Bun.Image(path).metadata()
  }
  catch {
    return `export default ${JSON.stringify(url)}`
  }

  return `import { registerImage } from 'kay/internal'
export default registerImage(${JSON.stringify(url)}, ${size.width}, ${size.height})`
}

export function kay(options: KayPluginOptions = {}): BunPlugin {
  return {
    name: 'kay',
    setup(build) {
      const target = options.target ?? (build.config?.target === 'browser' ? 'dom' : 'ssr')

      const load = async (file: string) => {
        const source = await Bun.file(withoutTwin(file)).text()

        const contents = await transformKayCached(source, file, { target, hydratable: options.hydratable ?? true, root: options.root, cacheDir: options.cacheDir, inspect: options.inspect })

        return { contents: options.anchor !== undefined && options.anchor !== '' ? `${contents}\nimport ${JSON.stringify(options.anchor)}\n` : contents, loader: 'ts' as const }
      }

      build.onLoad({ filter: KAY_FILE }, async ({ path }) => load(path))

      const iconSets = installedIconSets(options.root ?? process.cwd())

      // Only a bundle has a config; the runtime loader takes the specifier as it is.
      if (build.config !== undefined) {
        build.onResolve({ filter: TWIN_IMPORT }, ({ path, importer }) => ({ path: `${resolve(dirname(importer), withoutTwin(path))}${ISLAND_TWIN}`, namespace: TWIN_NAMESPACE }))
        build.onLoad({ filter: KAY_FILE, namespace: TWIN_NAMESPACE }, async ({ path }) => load(path))
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
      for (const { paths, replacement } of settingsReplacements(options.root ?? process.cwd(), options.settings ?? {})) {
        for (const path of paths)
          build.onLoad({ filter: new RegExp(`^${RegExp.escape(path)}$`) }, () => ({ contents: `export * from ${JSON.stringify(replacement)}\nexport { default } from ${JSON.stringify(replacement)}\n`, loader: 'ts' }))
      }

      // `import logo from './logo.png'` gives the URL the server serves it at, on the server and in islands alike; an image also records its size for `image()`.
      build.onLoad({ filter: ASSET_FILE }, async ({ path }) => ({ contents: await assetModule(path, await writeAsset(path, options.root ?? process.cwd())), loader: 'js' }))
    },
  }
}
