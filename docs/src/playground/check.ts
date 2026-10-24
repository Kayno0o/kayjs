import { compileKay } from '../../../src/compiler'
import { isRunnable } from './runnable'
import { renderServer } from './runtime'
import { stripTypes } from './strip'

// Whether the playground runs a docs example, found by running it: the static rule of `isRunnable`, then the server compile and a render with no props, which an example showing a fragment of a larger file, or needing a prop, does not survive. Run by the docs' build once per example, which highlighting caches.
export function runs(source: string): boolean {
  if (!isRunnable(source))
    return false

  try {
    const { tsx, diagnostics } = compileKay(source, '/playground.kay', { root: '/', output: 'html' })

    if (diagnostics.some(diagnostic => !diagnostic.checkOnly))
      return false

    renderServer(stripTypes(tsx))

    return true
  }
  catch {
    return false
  }
}
