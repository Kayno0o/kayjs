// The WebAssembly build of the parser the compiler bundle loads from beside itself, as the browser has no native binding.
export function GET() {
  return new Response(Bun.file(Bun.resolveSync('@oxc-parser/binding-wasm32-wasip1/wasm', import.meta.dir)), { headers: { 'content-type': 'application/wasm', 'cache-control': 'no-cache' } })
}
