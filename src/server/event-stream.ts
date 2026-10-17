import type { EventStream } from '../runtime/live'
import { END_EVENT, ERROR_EVENT } from '../runtime/live'
import { localeState, runInLocale } from '../runtime/locale-state'
import { kayLog } from '../runtime/log'
import { encodeValue, unsendable } from '../runtime/wire'

// Bun closes a connection idle for 10 s by default, and proxies after a minute or so: a comment line now and then keeps a quiet stream open.
const HEARTBEAT_MS = 5000
const HEARTBEAT = new TextEncoder().encode(':\n\n')

// Where a failing event stream reports its error: logged, and handed to `onError` once the route answering with it is known.
export const streamReporters = new WeakMap<Response, { report: (error: unknown) => void }>()

// Thrown by a source that cannot serve its stream after all: the stream closes with no end or error event, which a browser takes as a drop and opens again after its backoff.
export class StreamRefused extends Error {
  override name = 'StreamRefused'
}

// Answers with a server-sent event per value `source` gives, which `stream()` reads typed in an island: values cross as island props do, Dates, Maps and Sets included.
// The source is read one value per value the browser takes, and stopped when it goes away; a source that throws ends the stream as failed, the error logged.
export function eventStream<T>(source: AsyncIterable<T> | Iterable<T>): EventStream<T> {
  const reporter = { report: (error: unknown) => kayLog('error', 'an event stream failed', error) }
  const response = new Response(eventBody(inRequestLocale(source), error => reporter.report(error)), { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' } })

  streamReporters.set(response, reporter)

  return response as EventStream<T>
}

// The source read in the locale the route answered in, which the body is read outside of.
function inRequestLocale<T>(source: AsyncIterable<T> | Iterable<T>): AsyncIterable<T> | Iterable<T> {
  const state = localeState()

  if (!state)
    return source

  const iterator = () => Symbol.asyncIterator in source ? source[Symbol.asyncIterator]() : source[Symbol.iterator]()

  return {
    [Symbol.asyncIterator]() {
      const read = iterator()

      return {
        next: async () => runInLocale(state, async () => read.next()),
        return: async () => runInLocale(state, async () => read.return?.() ?? { done: true, value: undefined }),
      }
    },
  }
}

// The body of an event stream, a source's failure handed to `report`.
export function eventBody<T>(source: AsyncIterable<T> | Iterable<T>, report: (error: unknown) => void): ReadableStream<Uint8Array> {
  let iterator: AsyncIterator<T> | Iterator<T> | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let cancelled = false
  const encoder = new TextEncoder()

  const finish = (controller: ReadableStreamDefaultController<Uint8Array>, event: string) => {
    clearInterval(heartbeat)
    controller.enqueue(encoder.encode(`event: ${event}\ndata:\n\n`))
    controller.close()
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!iterator) {
        iterator = Symbol.asyncIterator in source ? source[Symbol.asyncIterator]() : source[Symbol.iterator]()
        heartbeat = setInterval(() => controller.enqueue(HEARTBEAT), HEARTBEAT_MS)
      }

      try {
        const next = await iterator.next()

        if (cancelled)
          return

        if (next.done)
          finish(controller, END_EVENT)
        else
          controller.enqueue(encoder.encode(`data: ${encodeEvent(next.value)}\n\n`))
      }
      catch (error) {
        if (cancelled)
          return

        if (error instanceof StreamRefused) {
          clearInterval(heartbeat)
          controller.close()

          return
        }

        report(error)
        void iterator.return?.()
        finish(controller, ERROR_EVENT)
      }
    },
    // Not awaited: an async generator waiting on its next value only returns once it has one, which a quiet feed may never give.
    cancel() {
      cancelled = true
      clearInterval(heartbeat)
      void iterator?.return?.()
    },
  }, { highWaterMark: 0 })
}

function encodeEvent(value: unknown): string {
  try {
    return encodeValue(value)
  }
  catch (error) {
    const reason = unsendable(error)

    throw reason === undefined ? error : new TypeError(`kay: a value the event stream sent cannot reach the browser: ${reason}`)
  }
}
