import type { BunPlugin } from 'bun'
import type { ClientOptions } from '../build/client'
import { plugin } from 'bun'

// Plugins that load a native addon, which Bun keeps its global alive for: under `bun test --isolate` every file then pins its whole module graph for the rest of the run.
const NATIVE_PLUGINS = ['bun-plugin-tailwind']
let registered = false

// A config importing one of NATIVE_PLUGINS gets a plugin that loads the real one when a build runs it, not when the config is read, so a file that never builds a client for a browser loads no addon.
export function lazyNativePlugins(root: string): void {
  if (registered)
    return

  registered = true

  for (const name of NATIVE_PLUGINS) {
    let real: string

    try {
      real = Bun.resolveSync(name, root)
    }
    catch {
      continue
    }

    plugin({
      name: `kay-lazy-${name}`,
      setup(build) {
        build.module(name, () => ({
          contents: `export default { name: ${JSON.stringify(name)}, kayNative: true, async setup(build) { const { default: real } = await import(${JSON.stringify(real)}); return real.setup(build) } }`,
          loader: 'js',
        }))
      },
    })
  }
}

// The options of a build only run as a check, whose stylesheets nothing reads: without the plugins loading an addon, which that build would otherwise load.
export function checkOnly(options: ClientOptions): ClientOptions {
  return options.plugins === undefined ? options : { ...options, plugins: options.plugins.filter(one => !(one as BunPlugin & { kayNative?: boolean }).kayNative) }
}
