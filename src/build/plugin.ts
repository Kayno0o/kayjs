import type { BunPlugin } from 'bun'
import type { Target } from './transform'
import { transformKayCached } from './transform'

export interface KayPluginOptions {
  // Defaults to `dom` when bundling for the browser and `ssr` everywhere else, the Bun runtime included.
  target?: Target
  // On by default: islands hydrate the server markup instead of re-rendering it.
  hydratable?: boolean
  // Island ids are relative to this directory; defaults to the working directory.
  root?: string
  // Keeps compiled files here between runs; off when unset.
  cacheDir?: string
}

const KAY_FILE = /\.kay$/

export function kay(options: KayPluginOptions = {}): BunPlugin {
  return {
    name: 'kay',
    setup(build) {
      const target = options.target ?? (build.config?.target === 'browser' ? 'dom' : 'ssr')

      build.onLoad({ filter: KAY_FILE }, async ({ path }) => {
        const source = await Bun.file(path).text()

        return { contents: await transformKayCached(source, path, { target, hydratable: options.hydratable ?? true, root: options.root, cacheDir: options.cacheDir }), loader: 'ts' }
      })
    },
  }
}
