/// <reference path="./wasm.d.ts" />
import factory from '@jsquash/avif/codec/enc/avif_enc.js'
import wasmPath from '@jsquash/avif/codec/enc/avif_enc.wasm' with { type: 'file' }
import { defaultOptions } from '@jsquash/avif/meta.js'
import { initEmscriptenModule } from '@jsquash/avif/utils.js'
import { decodePng } from './png'

export interface AvifTask {
  id: number
  // An 8-bit RGBA PNG, as Bun.Image writes every PNG.
  png: Uint8Array
  quality: number
}

export type AvifResult = { id: number, bytes: Uint8Array } | { id: number, error: string }

declare const self: Worker

const encoder = loadEncoder()

// Encodes AVIF off the main thread: libavif in wasm holds the thread it runs on for up to a second per image.
// Set before anything is awaited, or the first task, posted while the module loads, would be dropped.
self.onmessage = async ({ data: { id, png, quality } }: MessageEvent<AvifTask>) => {
  try {
    const { pixels, width, height } = decodePng(png)
    const bytes = (await encoder).encode(pixels, width, height, { ...defaultOptions, quality })

    if (!bytes)
      throw new Error('libavif gave no output')

    self.postMessage({ id, bytes } satisfies AvifResult, [bytes.buffer])
  }
  catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) } satisfies AvifResult)
  }
}

async function loadEncoder() {
  return initEmscriptenModule(factory, await WebAssembly.compile(await Bun.file(wasmPath).arrayBuffer()))
}
