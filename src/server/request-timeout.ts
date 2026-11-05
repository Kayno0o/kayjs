import type { Duration } from '../runtime/duration'
import { KayError } from '../compiler/errors'
import { timeoutMs } from './config-limits'
import { recordOf, requestRecord } from './request-record'

// What a request that ran past its `timeout` ends with, answered 504 through the nearest `_error.kay` for a page; logged and handed to `onError` as any server error is.
export class RequestTimeoutError extends KayError {
  override readonly name = 'RequestTimeoutError'
  declare readonly code: 'request-timeout'

  constructor(readonly ms: number) {
    super('request-timeout', `the request took longer than ${ms} ms`, { status: 504 })
  }
}

// A request's clock and its signal: aborted by the timeout, and by the client leaving through `request.signal`.
export class Deadline {
  readonly controller = new AbortController()
  // Rejects with the `RequestTimeoutError` when the time is up; nobody waiting for it is no unhandled rejection.
  readonly expiry = Promise.withResolvers<never>()
  signal: AbortSignal | undefined
  private readonly started = performance.now()
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor() {
    void Promise.allSettled([this.expiry.promise])
  }

  // Starts the clock for `ms` counted from the request's arrival, replacing any earlier one; `undefined` stops it.
  arm(ms: number | undefined): void {
    clearTimeout(this.timer)
    this.timer = undefined

    if (ms === undefined)
      return

    this.timer = setTimeout(() => this.expire(ms), Math.max(0, ms - (performance.now() - this.started)))
    this.timer.unref()
  }

  stop(): void {
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private expire(ms: number): void {
    const error = new RequestTimeoutError(ms)

    this.controller.abort(error)
    this.expiry.reject(error)
  }
}

export function deadlineOf(request: Request): Deadline {
  const record = requestRecord(request)

  return record.deadline ??= new Deadline()
}

// The signal `ctx.signal` is: it aborts when the client leaves and when the request's timeout is up.
export function requestSignal(request: Request): AbortSignal {
  const deadline = deadlineOf(request)

  return deadline.signal ??= AbortSignal.any([request.signal, deadline.controller.signal])
}

// Runs `work` and gives its answer, or throws a `RequestTimeoutError` once `ms` passed, aborting `ctx.signal`; the work is left running, as it cannot be stopped from outside, and sees the signal.
// `override` is the route's own setting, `false` for none, in place of `fallback`, the app's.
export async function withTimeout<T>(request: Request, override: number | false | undefined, fallback: number | undefined, work: () => Promise<T>): Promise<T> {
  const ms = override === false ? undefined : override ?? fallback

  if (ms === undefined)
    return work()

  const deadline = deadlineOf(request)

  deadline.arm(ms)

  try {
    return await Promise.race([work(), deadline.expiry.promise])
  }
  finally {
    deadline.stop()
  }
}

// The same for a page, whose own `timeout` is only known once its modules are imported. With the app's `timeout` the clock runs from the start; without one nothing is made until the page sets its own, which `retime` arms and `againstDeadline` holds the loads to. A streamed body is cut when the time is up, its headers being sent.
export async function withPageTimeout(request: Request, fallback: number | undefined, work: () => Promise<Response>, expired: (error: RequestTimeoutError) => void): Promise<Response> {
  let response: Response

  if (fallback === undefined) {
    try {
      response = await work()
    }
    catch (error) {
      recordOf(request)?.deadline?.stop()

      throw error
    }
  }
  else {
    const deadline = deadlineOf(request)

    deadline.arm(fallback)

    try {
      response = await Promise.race([work(), deadline.expiry.promise])
    }
    catch (error) {
      deadline.stop()

      throw error
    }
  }

  const deadline = recordOf(request)?.deadline

  if (deadline === undefined)
    return response

  if (response.body === null || !requestRecord(request).streamed) {
    deadline.stop()

    return response
  }

  return new Response(cut(response.body, deadline, expired), response)
}

// Holds `work` to the request's clock if it has one by now, as a page that sets its own `timeout` does once its modules are in.
export async function againstDeadline<T>(request: Request, work: Promise<T>): Promise<T> {
  const deadline = recordOf(request)?.deadline

  return deadline === undefined ? work : Promise.race([work, deadline.expiry.promise])
}

// The page's setting overriding the app's, once known.
export function retime(request: Request, setting: Duration | false | undefined): void {
  if (setting === undefined)
    return

  deadlineOf(request).arm(timeoutMs(setting, 'the timeout of a page'))
}

// The body until the clock runs out, then an error: the client sees the connection end, and the timeout is reported.
function cut(body: ReadableStream<Uint8Array>, deadline: Deadline, expired: (error: RequestTimeoutError) => void): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  const { signal } = deadline.controller
  let ended = false
  let release: () => void = () => undefined

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const timeUp = () => {
        ended = true
        expired(signal.reason as RequestTimeoutError)
        void reader.cancel(signal.reason)
        controller.error(signal.reason)
      }

      if (signal.aborted) {
        timeUp()

        return
      }

      signal.addEventListener('abort', timeUp, { once: true })
      release = () => signal.removeEventListener('abort', timeUp)
    },
    async pull(controller) {
      try {
        const chunk = await reader.read()

        if (ended)
          return

        if (chunk.done) {
          ended = true
          deadline.stop()
          release()
          controller.close()
        }
        else {
          controller.enqueue(chunk.value)
        }
      }
      catch (error) {
        if (ended)
          return

        ended = true
        deadline.stop()
        release()
        controller.error(error)
      }
    },
    async cancel(reason) {
      ended = true
      deadline.stop()
      release()
      await reader.cancel(reason)
    },
  })
}

// What a request that is no page, or whose page cannot be rendered, is answered with when it timed out.
export function timedOutResponse(): Response {
  return new Response('Gateway Timeout', { status: 504, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}
