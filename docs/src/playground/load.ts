// Where the compiler is served from: a route of the docs bundles it for the browser on the first request, as kay's own client build refuses Babel's reads of `process`. The address is built at run time so the build leaves the import alone.
const COMPILER = '/playground/compiler.js'

// The compiler with the stripper, imported when the playground opens, so no other page fetches it.
export async function loadCompiler(): Promise<typeof import('./compile')> {
  return import(`${location.origin}${COMPILER}`) as Promise<typeof import('./compile')>
}
