/// <reference path="./wasm.d.ts" />
import decoderFactory from '@jsquash/avif/codec/dec/avif_dec.js'
import decoderPath from '@jsquash/avif/codec/dec/avif_dec.wasm' with { type: 'file' }
import factory from '@jsquash/avif/codec/enc/avif_enc.js'
import wasmPath from '@jsquash/avif/codec/enc/avif_enc.wasm' with { type: 'file' }
import { defaultOptions } from '@jsquash/avif/meta.js'
import { initEmscriptenModule } from '@jsquash/avif/utils.js'
import { decodePng, encodePng } from './png'

// An 8-bit RGBA PNG to encode, as Bun.Image writes every PNG, or an AVIF to decode into one.
export type AvifTask = { id: number, png: Uint8Array, quality: number, speed: number } | { id: number, avif: Uint8Array, width: number, height: number }

interface AvifEncoder {
  encode: (data: Uint8Array, width: number, height: number, options: typeof defaultOptions) => Uint8Array<ArrayBuffer> | null
}

interface AvifDecoder {
  decode: (data: Uint8Array, bitDepth: 8) => { data: Uint8ClampedArray, width: number, height: number } | null
}

export type AvifResult = { id: number, bytes: Uint8Array } | { id: number, error: string }

declare const self: Worker

const encoder = loadEncoder()
let decoder: Promise<AvifDecoder> | undefined

// Encodes and decodes AVIF off the main thread: libavif in wasm holds the thread it runs on for up to a second per image.
// Set before anything is awaited, or the first task, posted while the module loads, would be dropped.
self.onmessage = async ({ data: task }: MessageEvent<AvifTask>) => {
  try {
    const bytes = 'avif' in task ? await decoded(task.avif, task.width, task.height) : await encoded(task.png, task.quality, task.speed)

    self.postMessage({ id: task.id, bytes } satisfies AvifResult, [bytes.buffer])
  }
  catch (error) {
    self.postMessage({ id: task.id, error: error instanceof Error ? error.message : String(error) } satisfies AvifResult)
  }
}

async function encoded(png: Uint8Array, quality: number, speed: number): Promise<Uint8Array> {
  const { pixels, width, height } = decodePng(png)
  const bytes = (await encoder).encode(pixels, width, height, { ...defaultOptions, quality, speed })

  if (!bytes)
    throw new Error('libavif gave no output')

  return bytes
}

async function decoded(avif: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const image = (await (decoder ??= loadDecoder())).decode(avif, 8)

  if (!image)
    throw new Error('libavif could not decode it')

  if (image.width !== width || image.height !== height)
    throw new Error(`it decodes to ${image.width}x${image.height}, not the ${width}x${height} its header gives`)

  return encodePng(new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength), image.width, image.height)
}

async function loadEncoder(): Promise<AvifEncoder> {
  return initEmscriptenModule<AvifEncoder>(factory, await WebAssembly.compile(await Bun.file(wasmPath).arrayBuffer()))
}

// Loaded with the first AVIF to decode, which a server resizing none never pays for.
async function loadDecoder(): Promise<AvifDecoder> {
  return initEmscriptenModule<AvifDecoder>(decoderFactory, await WebAssembly.compile(await Bun.file(decoderPath).arrayBuffer()))
}
