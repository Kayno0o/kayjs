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

const WASM_MAGIC = [0, 0x61, 0x73, 0x6D]

// Compiled once, as a trap has the encoder made again.
const compiled = compileEncoder()
let encoder = loadEncoder()
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
  const loading = encoder
  const codec = await loading

  // A task run meanwhile may have trapped, and had the encoder replaced.
  if (loading !== encoder)
    return encoded(png, quality, speed)

  const input = codec._malloc(pixels.length)

  if (input === 0)
    throw new Error(`no memory left for a ${width}x${height} image`)

  let size: number

  try {
    codec.HEAPU8.set(pixels, input)
    size = codec._kay_avif_encode(input, width, height, quality, speed)
  }
  catch (error) {
    // A trap (an abort in libaom, an access out of bounds) leaves the module's memory and statics as it stopped them, so the next task gets a new instance.
    encoder = loadEncoder()

    throw error
  }

  try {
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
  const loading = decoder ??= loadDecoder()
  const codec = await loading

  if (loading !== decoder)
    return decoded(avif, width, height)

  let image: ReturnType<AvifDecoder['decode']>

  try {
    image = codec.decode(avif, 8)
  }
  catch (error) {
    // A trap, as for the encoder: libavif answers a file it cannot decode with null.
    decoder = undefined

    throw error
  }

  if (!image)
    throw new Error('libavif could not decode it')

  if (image.width !== width || image.height !== height)
    throw new Error(`it decodes to ${image.width}x${image.height}, not the ${width}x${height} its header gives`)

  return encodePng(new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength), image.width, image.height)
}

// A wasm file's bytes: an executable embeds them zstd-compressed, which a wasm module's magic number tells from the plain file a build or `bun` reads.
async function wasmBytes(path: string): Promise<Uint8Array> {
  const bytes = await Bun.file(path).bytes()

  return WASM_MAGIC.every((byte, index) => bytes[index] === byte) ? bytes : Bun.zstdDecompress(bytes)
}

// kay's own build of libavif and libaom, with SIMD (codecs/avif); jsquash's scalar one encodes about half as fast.
async function compileEncoder(): Promise<WebAssembly.Module> {
  return WebAssembly.compile(await wasmBytes(wasmPath))
}

async function loadEncoder(): ReturnType<typeof factory> {
  const module = await compiled

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
  return initEmscriptenModule<AvifDecoder>(decoderFactory, await WebAssembly.compile(await wasmBytes(decoderPath)))
}
