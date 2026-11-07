import type { KayErrorOptions } from '../compiler/errors'
import type { EventStream } from '../runtime/live'
import { KayError } from '../compiler/errors'
import { END_EVENT, ERROR_EVENT } from '../runtime/live'
import { localeState, runInLocale } from '../runtime/locale-state'
import { kayLog } from '../runtime/log'
import { SENDABLE_ID } from '../runtime/sse'
import { encodeValue, unsendable } from '../runtime/wire'

// Bun closes a connection idle for 10 s by default, and proxies after a minute or so: a comment line now and then keeps a quiet stream open.
const HEARTBEAT_MS = 5000
const HEARTBEAT = new TextEncoder().encode(':\n\n')

// The streams being read, each with what ends it cleanly: a stop ends them all first, as one that never ends would keep the server from stopping.
const draining = new Set<() => void>()

// Set once the process is stopping for good, so a stream that begins after the sweep ends at once rather than hold the server open.
let stopped = false

// Ends the open event streams and every one opened from then on, for a process that is going to exit.
export function stopEventStreams(): void {
  stopped = true
  endEventStreams()
}

// Ends every open event stream with no end or error event, which a browser takes as a drop and opens again after its backoff, on the next instance.
export function endEventStreams(): void {
  for (const end of draining)
    end()
}

// Where a failing event stream reports its error: logged, and handed to `onError` once the route answering with it is known.
export const streamReporters = new WeakMap<Response, { report: (error: unknown) => void }>()

// Thrown by a source that cannot serve its stream after all: the stream closes with no end or error event, which a browser takes as a drop and opens again after its backoff.
export class StreamRefusedError extends KayError {
  override readonly name = 'StreamRefusedError'
  declare readonly code: 'stream-refused'

  constructor(message: string, options?: KayErrorOptions) {
    super('stream-refused', message, options)
  }
}

// What a stream reads: an iterable, or a function making one from a signal aborted when the browser goes away, which a source blocked on a quiet feed passes to what it waits on.
type Source<T> = AsyncIterable<T> | Iterable<T> | ((signal: AbortSignal) => AsyncIterable<T> | Iterable<T>)

export interface EventStreamOptions<T> {
  // The id each event carries, which a browser sends back as `Last-Event-ID` when it reconnects, the route reading it with `lastEventId(request)` to continue after it. An id the browser would not send back fails the stream: printable ASCII, no space at either end, at most 1 KB.
  id?: (value: T) => string | number
}

// Answers with a server-sent event per value `source` gives, which `stream()` reads typed in an island: values cross as island props do, Dates, Maps and Sets included.
// The source is read one value per value the browser takes, and stopped when it goes away; a source that throws ends the stream as failed, the error logged.
export function eventStream<T>(source: Source<T>, options: EventStreamOptions<T> = {}): EventStream<T> {
  const reporter = { report: (error: unknown) => kayLog('error', 'an event stream failed', error) }
  const response = new Response(eventBody(localizedSource(source), error => reporter.report(error), options.id), { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' } })

  streamReporters.set(response, reporter)

  return response as EventStream<T>
}

// The source read in the locale the route answered in, which the body is read outside of.
function localizedSource<T>(source: Source<T>): Source<T> {
  const state = localeState()

  if (!state)
    return source

  if (typeof source === 'function')
    return signal => localizedIterable(runInLocale(state, () => source(signal)), state)

  return localizedIterable(source, state)
}

function localizedIterable<T>(source: AsyncIterable<T> | Iterable<T>, state: NonNullable<ReturnType<typeof localeState>>): AsyncIterable<T> {
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
export function eventBody<T>(source: Source<T>, report: (error: unknown) => void, id?: (value: T) => string | number): ReadableStream<Uint8Array> {
  let iterator: AsyncIterator<T> | Iterator<T> | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let cancelled = false
  const gone = new AbortController()
  const encoder = new TextEncoder()
  let drain: (() => void) | undefined

  const leave = () => {
    if (drain)
      draining.delete(drain)
  }

  const finish = (controller: ReadableStreamDefaultController<Uint8Array>, event: string) => {
    leave()
    clearInterval(heartbeat)
    controller.enqueue(encoder.encode(`event: ${event}\ndata:\n\n`))
    controller.close()
  }

  const open = () => {
    const made = typeof source === 'function' ? source(gone.signal) : source

    return Symbol.asyncIterator in made ? made[Symbol.asyncIterator]() : made[Symbol.iterator]()
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      heartbeat ??= setInterval(() => controller.enqueue(HEARTBEAT), HEARTBEAT_MS)

      if (stopped) {
        clearInterval(heartbeat)
        controller.close()

        return
      }

      if (!drain) {
        drain = () => {
          leave()
          cancelled = true
          gone.abort()
          clearInterval(heartbeat)
          void iterator?.return?.()
          controller.close()
        }

        draining.add(drain)
      }

      try {
        iterator ??= open()

        const next = await iterator.next()

        if (cancelled)
          return

        if (next.done)
          finish(controller, END_EVENT)
        else
          controller.enqueue(encoder.encode(`${idLine(id, next.value)}data: ${encodeEvent(next.value)}\n\n`))
      }
      catch (error) {
        if (cancelled)
          return

        if (error instanceof StreamRefusedError) {
          leave()
          clearInterval(heartbeat)
          controller.close()

          return
        }

        report(error)
        void iterator?.return?.()
        finish(controller, ERROR_EVENT)
      }
    },
    // Not awaited: an async generator waiting on its next value only returns once it has one, which a quiet feed may never give.
    cancel() {
      leave()
      cancelled = true
      gone.abort()
      clearInterval(heartbeat)
      void iterator?.return?.()
    },
  }, { highWaterMark: 0 })
}

// The `id:` line of an event, none when the stream gives no ids: a line break would end the field, a NUL makes a browser ignore it, and the client sends back only what `SENDABLE_ID` accepts.
function idLine<T>(id: ((value: T) => string | number) | undefined, value: T): string {
  if (!id)
    return ''

  const text = String(id(value))

  if (!SENDABLE_ID.test(text))
    throw new TypeError('kay: an event stream id must be printable ASCII of at most 1 KB with no space at either end')

  return `id: ${text}\n`
}

// The `Last-Event-ID` a browser sent when it reconnected, as the text `eventStream`'s `id` gave; undefined when there is none or it is not one a browser could have been given (hostile input), so the route starts from the beginning.
export function lastEventId(request: Request): string | undefined {
  const sent = request.headers.get('last-event-id')

  return sent !== null && SENDABLE_ID.test(sent) ? sent : undefined
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
