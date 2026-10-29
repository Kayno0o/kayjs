// The translation of `kay fmt --from-html`, fetched when the converter asks for it, so it is a chunk only that box fetches. A route of the docs bundles it with the parser's WebAssembly build, as the playground's compiler is, and the address is built at run time so the client build leaves it alone.
const CONVERTER = '/playground/converter.js'

export async function loadConverter(): Promise<typeof import('./playground/convert')> {
  return import(`${location.origin}${CONVERTER}`) as Promise<typeof import('./playground/convert')>
}
