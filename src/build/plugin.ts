import type { BunPlugin } from 'bun'
import type { Target } from './transform'
import { transformKay } from './transform'

export interface KayPluginOptions {
  // Defaults to `dom` when bundling for the browser and `ssr` everywhere else, the Bun runtime included.
  target?: Target
  // On by default: islands hydrate the server markup instead of re-rendering it.
  hydratable?: boolean
}

const KAY_FILE = /\.kay$/

export function kay(options: KayPluginOptions = {}): BunPlugin {
  return {
    name: 'kay',
    setup(build) {
      const target = options.target ?? (build.config?.target === 'browser' ? 'dom' : 'ssr')

      build.onLoad({ filter: KAY_FILE }, async ({ path }) => {
        const source = await Bun.file(path).text()

        return { contents: transformKay(source, path, { target, hydratable: options.hydratable ?? true }), loader: 'ts' }
      })
    },
  }
}
