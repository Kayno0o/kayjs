import type { BunPlugin } from 'bun'
import type { Target } from './transform'
import process from 'node:process'
import { withoutTwin } from '../compiler'
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

export function kay(options: KayPluginOptions = {}): BunPlugin {
  return {
    name: 'kay',
    setup(build) {
      const target = options.target ?? (build.config?.target === 'browser' ? 'dom' : 'ssr')

      build.onLoad({ filter: KAY_FILE }, async ({ path }) => {
        const source = await Bun.file(withoutTwin(path)).text()

        return { contents: await transformKayCached(source, path, { target, hydratable: options.hydratable ?? true, root: options.root, cacheDir: options.cacheDir }), loader: 'ts' }
      })
      // `import logo from './logo.png'` gives the URL the server serves it at, on the server and in islands alike.
      build.onLoad({ filter: ASSET_FILE }, async ({ path }) => ({ contents: `export default ${JSON.stringify(await writeAsset(path, options.root ?? process.cwd()))}`, loader: 'js' }))
    },
  }
}
