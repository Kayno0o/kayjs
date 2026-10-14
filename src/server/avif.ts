import type { AvifResult, AvifTask } from './avif-worker'
import { fileURLToPath } from 'node:url'

export const DEFAULT_AVIF_QUALITY = 50
// libavif's speed, 0 to 10: 7 encodes about twice as fast as its default of 6 and writes 3 to 5% fewer bytes, at a luma SSIM about 0.005 lower; 9 is 4 times faster again but writes 30 to 40% more on flat images such as logos, and 8 doubles some photos.
export const AVIF_SPEED = 7
export { AVIF_ENCODER } from './codec/avif-enc-build'

// The worker's source, which `kay build --compile` adds as an entry of the executable, named after its file.
export const AVIF_WORKER_SOURCE = fileURLToPath(new URL('./avif-worker.ts', import.meta.url))
const WORKER_URL = new URL(import.meta.url.startsWith('file:///$bunfs/') ? './avif-worker.js' : './avif-worker.ts', import.meta.url)
// A worker with nothing to encode this long is stopped, giving back the memory libavif holds.
const IDLE_MS = 30_000

interface Encoder {
  // Bun's, which the DOM types the project also loads leave without `ref` and `unref`.
  worker: Worker & Pick<Bun.Worker, 'ref' | 'unref'>
  tasks: Map<number, { resolve: (bytes: Uint8Array) => void, reject: (error: Error) => void }>
  idle?: Timer
}

const encoders: Encoder[] = []
let most = 1
let nextId = 0

// How many images encode at once, each on its own thread: 1 for a server, which encodes only runtime images, more for a build.
export function setAvifThreads(count: number): void {
  most = Math.max(1, count)
}

// The image encoded as AVIF on a worker thread, the main thread kept free; a worker starts on the first call.
export async function encodeAvif(image: Bun.Image, quality: number): Promise<Uint8Array> {
  const png = await image.png({ compressionLevel: 0 }).bytes()

  return run(id => ({ id, png, quality, speed: AVIF_SPEED }), png)
}

// An AVIF decoded to a PNG on the same threads, as Bun.Image reads no AVIF on Linux, refused unless it decodes to the size its header gave. Its buffer is handed to the worker.
export async function decodeAvif(avif: Uint8Array, size: { width: number, height: number }): Promise<Uint8Array> {
  return run(id => ({ id, avif, ...size }), avif)
}

async function run(task: (id: number) => AvifTask, bytes: Uint8Array): Promise<Uint8Array> {
  const encoder = encoders.length < most && encoders.every(({ tasks }) => tasks.size > 0) ? startEncoder() : encoders.reduce((least, next) => next.tasks.size < least.tasks.size ? next : least)
  const id = nextId++

  clearTimeout(encoder.idle)
  encoder.worker.ref()

  return new Promise((resolve, reject) => {
    encoder.tasks.set(id, { resolve, reject })
    encoder.worker.postMessage(task(id), [bytes.buffer])
  })
}

function startEncoder(): Encoder {
  const encoder: Encoder = { worker: new Worker(WORKER_URL) as Encoder['worker'], tasks: new Map() }

  encoder.worker.onmessage = ({ data }: MessageEvent<AvifResult>) => {
    const task = encoder.tasks.get(data.id)

    encoder.tasks.delete(data.id)

    if ('error' in data)
      task?.reject(new Error(`kay: AVIF coding failed: ${data.error}`))
    else
      task?.resolve(data.bytes)

    if (encoder.tasks.size === 0) {
      // Unreferenced, an idle worker does not keep a build's process alive until it is stopped.
      encoder.worker.unref()
      encoder.idle = setTimeout(stopEncoder, IDLE_MS, encoder)
      encoder.idle.unref()
    }
  }

  encoder.worker.onerror = (event) => {
    for (const task of encoder.tasks.values())
      task.reject(new Error(`kay: the AVIF encoder stopped: ${event.message}`))

    stopEncoder(encoder)
  }

  encoders.push(encoder)

  return encoder
}

function stopEncoder(encoder: Encoder): void {
  clearTimeout(encoder.idle)
  encoder.worker.terminate()

  if (encoders.includes(encoder))
    encoders.splice(encoders.indexOf(encoder), 1)
}
