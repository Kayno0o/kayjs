import type { BunPlugin } from 'bun'
import { compile } from 'svelte/compiler'

const SVELTE = /\.svelte$/

// Svelte 5 compiles each component for the server or the browser; browser output always supports hydration.
export function sveltePlugin(generate: 'client' | 'server'): BunPlugin {
  return {
    name: `svelte-${generate}`,
    setup(build) {
      build.onLoad({ filter: SVELTE }, async ({ path }) => {
        const { js } = compile(await Bun.file(path).text(), { filename: path, generate, runes: true })

        return { contents: js.code, loader: 'js' }
      })
    },
  }
}
