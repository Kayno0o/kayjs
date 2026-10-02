import type { BunPlugin } from 'bun'
import { transformAsync } from '@babel/core'
import typescript from '@babel/preset-typescript'
import solid from 'babel-preset-solid'

const TSX = /\.tsx$/

// Solid 1 compiles JSX with its babel preset, for the server (`ssr`) or the browser (`dom`), both hydratable.
export function solidPlugin(generate: 'dom' | 'ssr'): BunPlugin {
  return {
    name: `solid-${generate}`,
    setup(build) {
      build.onLoad({ filter: TSX }, async ({ path }) => {
        const result = await transformAsync(await Bun.file(path).text(), {
          filename: path,
          presets: [[solid, { generate, hydratable: true }], [typescript, { isTSX: true, allExtensions: true }]],
        })

        return { contents: result?.code ?? '', loader: 'js' }
      })
    },
  }
}
