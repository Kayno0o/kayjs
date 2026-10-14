// The Emscripten glue codecs/avif/build.ts writes beside it, around codecs/avif/encode.c.
export interface AvifEncoderModule {
  HEAPU8: Uint8Array
  _malloc: (size: number) => number
  _free: (pointer: number) => void
  // The AVIF's length, read from `_kay_avif_output()` until the next call, or 0 on a failure `_kay_avif_error()` names.
  _kay_avif_encode: (rgba: number, width: number, height: number, quality: number, speed: number) => number
  _kay_avif_output: () => number
  _kay_avif_error: () => number
  UTF8ToString: (pointer: number) => string
}

export default function factory(options: {
  instantiateWasm: (imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance) => void) => WebAssembly.Exports
}): Promise<AvifEncoderModule>
