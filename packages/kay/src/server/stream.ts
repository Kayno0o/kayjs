// A page with pending `<Suspense>` boundaries: its document flushes first, then each boundary as a script once it resolves or times out.

import type { PendingChunk, RenderContext, SettledChunk } from '../ssr/context'
import { streamChunkScript } from '../ssr/context'

const textEncoder = new TextEncoder()
// Where a streamed page's document splits: everything before it flushes first, resolved boundaries go in between.
export const STREAM_TAIL_MARK = '<!--kay:stream-tail-->'

/** `streamTimeout` is only named in the error: the page's boundaries share one `deadlineMs`. */
async function settleWithin(chunk: PendingChunk, deadlineMs: number, streamTimeout: number, signal: AbortSignal): Promise<SettledChunk | undefined> {
  if (signal.aborted)
    return undefined
  const remaining = Math.max(0, deadlineMs - Date.now())
  let timer: ReturnType<typeof setTimeout> | undefined
  const abortedOrTimedOut = new Promise<SettledChunk | undefined>((resolve) => {
    const onAbort = () => resolve(undefined)
    signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      const error = new Error(`<Suspense> boundary ${chunk.id} did not resolve within ${streamTimeout} ms`)
      resolve({ html: chunk.renderError(error), error })
    }, remaining)
  })
  try {
    return await Promise.race([chunk.settled, abortedOrTimedOut])
  }
  finally {
    clearTimeout(timer)
  }
}

/** Streams `shell` (a document holding `STREAM_TAIL_MARK`), with every boundary of `rctx` flushed before its tail. */
export function streamDocument(shell: string, rctx: RenderContext, streamTimeout: number, onBoundaryError: (error: unknown) => void): ReadableStream<Uint8Array> {
  let splitAt = shell.lastIndexOf(STREAM_TAIL_MARK)
  let tailOffset = STREAM_TAIL_MARK.length
  if (splitAt === -1) {
    splitAt = shell.lastIndexOf('</body>')
    tailOffset = 0
  }
  const openingHtml = splitAt === -1 ? shell : shell.slice(0, splitAt)
  const tailHtml = splitAt === -1 ? '' : shell.slice(splitAt + tailOffset)

  const abortCtrl = new AbortController()
  let closed = false
  const deadline = Date.now() + streamTimeout

  const safeEnqueue = (controller: ReadableStreamDefaultController<Uint8Array>, data: Uint8Array): void => {
    if (closed || abortCtrl.signal.aborted)
      return
    try {
      controller.enqueue(data)
    }
    catch {
      closed = true
      abortCtrl.abort()
    }
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      safeEnqueue(controller, textEncoder.encode(openingHtml))
      // A resolved boundary can render boundaries of its own, so each flush also drains the ones it added.
      let flushed = 0
      const flushPending = async (): Promise<void> => {
        if (closed || abortCtrl.signal.aborted)
          return
        const chunks = rctx.pending.slice(flushed)
        flushed = rctx.pending.length
        await Promise.all(chunks.map(async (chunk) => {
          const settled = await settleWithin(chunk, deadline, streamTimeout, abortCtrl.signal)
          if (settled === undefined || closed || abortCtrl.signal.aborted)
            return
          if ('error' in settled)
            onBoundaryError(settled.error)
          safeEnqueue(controller, textEncoder.encode(streamChunkScript(chunk.id, settled.html)))
          await flushPending()
        }))
      }
      await flushPending()
      if (!closed && !abortCtrl.signal.aborted) {
        safeEnqueue(controller, textEncoder.encode(tailHtml))
        closed = true
        try {
          controller.close()
        }
        catch {}
      }
    },
    cancel() {
      closed = true
      abortCtrl.abort()
    },
  })
}
