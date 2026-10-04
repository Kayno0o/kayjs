import type { BunPlugin } from 'bun'
import type { Target } from './transform'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { ISLAND_TWIN, withoutTwin } from '../compiler'
import { ASSET_FILE, writeAsset } from './assets'
import { transformKayCached } from './transform'

export interface KayPluginOptions {
  // Defaults to `dom` when bundling for the browser and `ssr` everywhere else, the Bun runtime included.
  target?: Target
  // On by default: islands hydrate the server markup instead of re-rendering it.
  hydratable?: boolean
  // Island ids are relative to this directory, and imported assets are written under its `.kay/client`; defaults to the working directory.
  root?: string
  // Keeps compiled files here between runs; off when unset.
  cacheDir?: string
}

// A static component imports its `?island` twin, the build of it that renders inside islands, as a module of its own.
const KAY_FILE = /\.kay(?:\?island)?$/
const TWIN_IMPORT = /\.kay\?island$/
// Where the bundler keeps twins: unlike the runtime loader, it resolves no specifier holding a `?`.
const TWIN_NAMESPACE = 'kay-island'
const RESIZABLE = /\.(?:png|jpe?g|webp)$/i

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

  return `import { registerImage } from 'kay/image'
export default registerImage(${JSON.stringify(url)}, ${size.width}, ${size.height})`
}

export function kay(options: KayPluginOptions = {}): BunPlugin {
  return {
    name: 'kay',
    setup(build) {
      const target = options.target ?? (build.config?.target === 'browser' ? 'dom' : 'ssr')

      const load = async (file: string) => {
        const source = await Bun.file(withoutTwin(file)).text()

        return { contents: await transformKayCached(source, file, { target, hydratable: options.hydratable ?? true, root: options.root, cacheDir: options.cacheDir }), loader: 'ts' as const }
      }

      build.onLoad({ filter: KAY_FILE }, async ({ path }) => load(path))

      // Only a bundle has a config; the runtime loader takes the specifier as it is.
      if (build.config) {
        build.onResolve({ filter: TWIN_IMPORT }, ({ path, importer }) => ({ path: `${resolve(dirname(importer), withoutTwin(path))}${ISLAND_TWIN}`, namespace: TWIN_NAMESPACE }))
        build.onLoad({ filter: KAY_FILE, namespace: TWIN_NAMESPACE }, async ({ path }) => load(path))
      }

      // `import logo from './logo.png'` gives the URL the server serves it at, on the server and in islands alike; an image also records its size for `image()`.
      build.onLoad({ filter: ASSET_FILE }, async ({ path }) => ({ contents: await assetModule(path, await writeAsset(path, options.root ?? process.cwd())), loader: 'js' }))
    },
  }
}
