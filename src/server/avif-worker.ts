/// <reference path="./wasm.d.ts" />
import decoderFactory from '@jsquash/avif/codec/dec/avif_dec.js'
import decoderPath from '@jsquash/avif/codec/dec/avif_dec.wasm' with { type: 'file' }
import { initEmscriptenModule } from '@jsquash/avif/utils.js'
import factory from './codec/avif-enc.js'
import wasmPath from './codec/avif-enc.wasm' with { type: 'file' }
import { decodePng, encodePng } from './png'

// An 8-bit RGBA PNG to encode, as Bun.Image writes every PNG, or an AVIF to decode into one.
export type AvifTask = { id: number, png: Uint8Array, quality: number, speed: number } | { id: number, avif: Uint8Array, width: number, height: number }

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
  const codec = await encoder
  const input = codec._malloc(pixels.length)

  if (input === 0)
    throw new Error(`no memory left for a ${width}x${height} image`)

  try {
    codec.HEAPU8.set(pixels, input)

    const size = codec._kay_avif_encode(input, width, height, quality, speed)

    if (size === 0)
      throw new Error(codec.UTF8ToString(codec._kay_avif_error()))

    const output = codec._kay_avif_output()

    // Read after the call, as a memory grown by the encode replaces HEAPU8.
    return codec.HEAPU8.slice(output, output + size)
  }
  finally {
    codec._free(input)
  }
}

async function decoded(avif: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const image = (await (decoder ??= loadDecoder())).decode(avif, 8)

  if (!image)
    throw new Error('libavif could not decode it')

  if (image.width !== width || image.height !== height)
    throw new Error(`it decodes to ${image.width}x${image.height}, not the ${width}x${height} its header gives`)

  return encodePng(new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength), image.width, image.height)
}

// kay's own build of libavif and libaom, with SIMD (codecs/avif); jsquash's scalar one encodes about half as fast.
async function loadEncoder(): ReturnType<typeof factory> {
  const module = await WebAssembly.compile(await Bun.file(wasmPath).arrayBuffer())

  return factory({
    instantiateWasm: (imports, done) => {
      const instance = new WebAssembly.Instance(module, imports)

      done(instance)

      return instance.exports
    },
  })
}

// Loaded with the first AVIF to decode, which a server resizing none never pays for.
async function loadDecoder(): Promise<AvifDecoder> {
  return initEmscriptenModule<AvifDecoder>(decoderFactory, await WebAssembly.compile(await Bun.file(decoderPath).arrayBuffer()))
}
