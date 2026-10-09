import type { AvifResult, AvifTask } from './avif-worker'
import { fileURLToPath } from 'node:url'

export const DEFAULT_AVIF_QUALITY = 50
// libavif's speed, 0 to 10: on photos 640 to 1600 pixels wide, 9 encodes 16 times faster than its default of 6 for the same size, at a luma SSIM 0.008 lower (0.961 against 0.969); 10 writes the same bytes as 9, 7 and 8 save little time.
export const AVIF_SPEED = 9

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
  const encoder = encoders.length < most && encoders.every(({ tasks }) => tasks.size > 0) ? startEncoder() : encoders.reduce((least, next) => next.tasks.size < least.tasks.size ? next : least)
  const id = nextId++

  clearTimeout(encoder.idle)
  encoder.worker.ref()

  return new Promise((resolve, reject) => {
    encoder.tasks.set(id, { resolve, reject })
    encoder.worker.postMessage({ id, png, quality, speed: AVIF_SPEED } satisfies AvifTask, [png.buffer])
  })
}

function startEncoder(): Encoder {
  const encoder: Encoder = { worker: new Worker(WORKER_URL) as Encoder['worker'], tasks: new Map() }

  encoder.worker.onmessage = ({ data }: MessageEvent<AvifResult>) => {
    const task = encoder.tasks.get(data.id)

    encoder.tasks.delete(data.id)

    if ('error' in data)
      task?.reject(new Error(`kay: AVIF encoding failed: ${data.error}`))
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
