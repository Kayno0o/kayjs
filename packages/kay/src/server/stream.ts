// A page with pending `<Suspense>` boundaries: its document flushes first, then each boundary as a script once it resolves or times out.

import type { PendingChunk, RenderContext, SettledChunk } from '../ssr/context'
import { getAppContext, runWithAppContext } from '../plugins/index'
import { streamChunkScript } from '../ssr/context'
import { currentRequest, runInRequest } from './request-scope'

const textEncoder = new TextEncoder()
// Where a streamed page's document splits: everything before it flushes first, resolved boundaries go in between.
export const STREAM_TAIL_MARK = '<!--kay:stream-tail-->'

function captureAsyncScope(): <T>(fn: () => T) => T {
  const appCtx = getAppContext()
  const reqScope = currentRequest()
  return <T>(fn: () => T): T => {
    const inner = reqScope !== undefined ? () => runInRequest(reqScope, fn) : fn
    return appCtx !== undefined ? runWithAppContext(appCtx, inner) : inner()
  }
}

/** `streamTimeout` is only named in the error: the page's boundaries share one `deadlineMs`. */
async function settleWithin(
  chunk: PendingChunk,
  deadlineMs: number,
  streamTimeout: number,
  signal: AbortSignal,
  runInScope: <T>(fn: () => T) => T,
): Promise<SettledChunk | undefined> {
  if (signal.aborted)
    return undefined
  const remaining = Math.max(0, deadlineMs - Date.now())
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const abortedOrTimedOut = new Promise<SettledChunk | undefined>((resolve) => {
    onAbort = () => resolve(undefined)
    signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      if (onAbort !== undefined)
        signal.removeEventListener('abort', onAbort)
      const error = new Error(`<Suspense> boundary ${chunk.id} did not resolve within ${streamTimeout} ms`)
      resolve({ html: runInScope(() => chunk.renderError(error)), error })
    }, remaining)
  })
  try {
    return await Promise.race([chunk.settled, abortedOrTimedOut])
  }
  finally {
    clearTimeout(timer)
    if (onAbort !== undefined)
      signal.removeEventListener('abort', onAbort)
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

  const runInScope = captureAsyncScope()
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
          const settled = await settleWithin(chunk, deadline, streamTimeout, abortCtrl.signal, runInScope)
          if (settled === undefined || closed || abortCtrl.signal.aborted)
            return
          if ('error' in settled)
            runInScope(() => onBoundaryError(settled.error))
          safeEnqueue(controller, textEncoder.encode(streamChunkScript(chunk.id, settled.html)))
          await flushPending()
        }))
      }
      await flushPending()
      if (!closed && !abortCtrl.signal.aborted) {
        safeEnqueue(controller, textEncoder.encode(tailHtml))
        closed = true
        safeClose(controller)
      }
    },
    cancel() {
      closed = true
      abortCtrl.abort()
    },
  })
}

function safeClose(controller: ReadableStreamDefaultController<Uint8Array>): boolean {
  try {
    controller.close()
    return true
  }
  catch {
    return false
  }
}

function trackEventStream(res: Response, active: Set<() => void>, disableTimeout?: () => void): Response {
  disableTimeout?.()
  if (res.body === null)
    return res
  const reader = res.body.getReader()
  let closed = false
  let closeStream: (() => void) | undefined
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      closeStream = () => {
        if (closed)
          return
        closed = true
        active.delete(closeStream!)
        safeClose(controller)
        void reader.cancel().catch(() => undefined)
      }
      active.add(closeStream)
    },
    async pull(controller) {
      if (closed)
        return
      try {
        const { done, value } = await reader.read()
        if (closed)
          return
        if (done) {
          closed = true
          if (closeStream !== undefined)
            active.delete(closeStream)
          controller.close()
        }
        else {
          controller.enqueue(value)
        }
      }
      catch (err) {
        if (!closed) {
          closed = true
          if (closeStream !== undefined)
            active.delete(closeStream)
          controller.error(err)
        }
      }
    },
    cancel(reason) {
      closed = true
      if (closeStream !== undefined)
        active.delete(closeStream)
      return reader.cancel(reason)
    },
  })
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
}

/** Tracks active SSE streams so graceful shutdown can end them before `server.stop()` drains in-flight requests. */
export function createStreamTracker() {
  const active = new Set<() => void>()
  return {
    track: (res: Response, disableTimeout?: () => void): Response => trackEventStream(res, active, disableTimeout),
    closeAll: (): Promise<void> => {
      for (const close of [...active])
        close()
      return Promise.resolve()
    },
  }
}
