import { parserWasm, respond } from '../../playground/bundle'

const wasm = parserWasm()

// The WebAssembly build of the parser the compiler bundle loads from beside itself, as the browser has no native binding.
export async function GET({ request }: { request: Request }) {
  return respond(request, await wasm(), { 'content-type': 'application/wasm', 'cache-control': 'no-cache' })
}
