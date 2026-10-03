import { plugin } from 'bun'
import { kay } from '../build/plugin'

let loaderRoot: string | undefined

// Lets this process import `.kay` files as server modules; the loader is global, so one process serves one project.
export function registerLoader(root: string) {
  if (loaderRoot === undefined) {
    plugin(kay({ target: 'ssr', root }))
    loaderRoot = root
  }
  else if (loaderRoot !== root) {
    throw new Error(`kay: the .kay loader is registered for ${loaderRoot}; one process serves one project`)
  }
}
