import type { ActionOptions } from './actions'
import type { CookieJar } from './cookies'
import { eventBody } from './event-stream'
import { gatheringInvalidated, invalidatedText } from './live'
import { reportServerError } from './report'

export function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value
}

// The client going away stops the iterable, an endless one included, as it stops a stream.
export async function lastOf(source: AsyncIterable<unknown>, signal: AbortSignal): Promise<unknown> {
  const iterator = source[Symbol.asyncIterator]()
  const stop = () => void iterator.return?.()
  let last: unknown

  signal.addEventListener('abort', stop, { once: true })

  try {
    for (let next = await iterator.next(); next.done !== true; next = await iterator.next())
      last = next.value
  }
  finally {
    signal.removeEventListener('abort', stop)
  }

  return last
}

// The iterable with its first value read, so what it throws or stops with before one answers as the handler would; it is stopped when the client goes away before reading on.
export async function started(source: AsyncIterable<unknown>, signal: AbortSignal): Promise<AsyncIterable<unknown>> {
  const iterator = source[Symbol.asyncIterator]()
  const stop = () => void iterator.return?.()

  let first: IteratorResult<unknown> | undefined

  signal.addEventListener('abort', stop, { once: true })

  try {
    first = await iterator.next()
  }
  catch (error) {
    signal.removeEventListener('abort', stop)

    throw error
  }

  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        const next = first ?? await iterator.next()

        first = undefined

        if (next.done === true)
          signal.removeEventListener('abort', stop)

        return next
      },
      return: async (value?: unknown) => {
        signal.removeEventListener('abort', stop)

        return await iterator.return?.(value) ?? { done: true, value }
      },
    }),
  }
}

// The iterable, each step of it run as the handler's own, so the keys it invalidates while it streams reach `keys`.
export function gathering(source: AsyncIterable<unknown>, keys: Set<string>, asked: ReadonlySet<string>): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]: () => {
      const iterator = source[Symbol.asyncIterator]()

      return {
        next: async () => gatheringInvalidated(keys, async () => iterator.next(), asked),
        return: async (value?: unknown) => gatheringInvalidated(keys, async () => await iterator.return?.(value) ?? { done: true, value }, asked),
      }
    },
  }
}

// A call to a handler returning an async iterable gets its values as server-sent events, `readActionResponse` reading them as a stream; a throw past the first value ends it as failed. The end event names the followed keys the handler invalidated, as an answer's header does, which the page then leaves to its live connection.
export function streamed(request: Request, jar: CookieJar, headers: Headers, source: AsyncIterable<unknown>, status: number, { onError }: ActionOptions, invalidated: ReadonlySet<string>): Response {
  jar.writeTo(headers)
  headers.set('content-type', 'text/event-stream; charset=utf-8')
  headers.set('cache-control', 'no-cache')

  return new Response(eventBody(source, error => reportServerError(error, request, onError), undefined, () => invalidatedText(invalidated)), { status, headers })
}
