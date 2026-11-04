import type { Duration } from '../runtime/duration'
import { timeoutMs } from './config-limits'
import { requestRecord } from './request-record'

// What a request that ran past its `timeout` ends with, answered 504 through the nearest `_error.kay` for a page; logged and handed to `onError` as any server error is.
export class RequestTimeout extends Error {
  constructor(readonly ms: number) {
    super(`the request took longer than ${ms} ms`)
    this.name = 'RequestTimeout'
  }
}

// A request's clock and its signal: aborted by the timeout, and by the client leaving through `request.signal`.
export class Deadline {
  readonly controller = new AbortController()
  // Rejects with the `RequestTimeout` when the time is up; nobody waiting for it is no unhandled rejection.
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
    const error = new RequestTimeout(ms)

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

// Runs `work` and gives its answer, or throws a `RequestTimeout` once `ms` passed, aborting `ctx.signal`; the work is left running, as it cannot be stopped from outside, and sees the signal.
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

// The same for a page, whose own `timeout` is only known once its modules are imported: the clock is there from the start and `retime` sets it. A streamed body is cut when the time is up, its headers being sent.
export async function withPageTimeout(request: Request, fallback: number | undefined, work: () => Promise<Response>, expired: (error: RequestTimeout) => void): Promise<Response> {
  const deadline = deadlineOf(request)

  deadline.arm(fallback)

  let response: Response

  try {
    response = await Promise.race([work(), deadline.expiry.promise])
  }
  catch (error) {
    deadline.stop()

    throw error
  }

  if (response.body === null || !requestRecord(request).streamed) {
    deadline.stop()

    return response
  }

  return new Response(cut(response.body, deadline, expired), response)
}

// The page's setting overriding the app's, once known.
export function retime(request: Request, setting: Duration | false | undefined): void {
  if (setting === undefined)
    return

  deadlineOf(request).arm(timeoutMs(setting, 'the timeout of a page'))
}

// The body until the clock runs out, then an error: the client sees the connection end, and the timeout is reported.
function cut(body: ReadableStream<Uint8Array>, deadline: Deadline, expired: (error: RequestTimeout) => void): ReadableStream<Uint8Array> {
  const reader = body.getReader()

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await Promise.race([reader.read(), deadline.expiry.promise])

        if (chunk.done) {
          deadline.stop()
          controller.close()
        }
        else {
          controller.enqueue(chunk.value)
        }
      }
      catch (error) {
        deadline.stop()

        if (error instanceof RequestTimeout) {
          expired(error)
          await Promise.allSettled([reader.cancel(error)])
        }

        controller.error(error)
      }
    },
    async cancel(reason) {
      deadline.stop()
      await reader.cancel(reason)
    },
  })
}

// What a request that is no page, or whose page cannot be rendered, is answered with when it timed out.
export function timedOutResponse(): Response {
  return new Response('Gateway Timeout', { status: 504, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}
