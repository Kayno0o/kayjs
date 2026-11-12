import type { PageError } from '../runtime'
import type { RequestContext } from './render'
import { browserOnlyHint, mappedStack } from '../build/sourcemap'
import { recordOf } from './request-record'
import { RequestTimeoutError } from './request-timeout'
import { Denied, NotFound } from './signals'

const named = new WeakSet<Error>()

export function pageErrorOf(error: unknown, dev: boolean | undefined): PageError {
  if (error instanceof NotFound)
    return { status: 404, message: 'Not Found' }

  if (error instanceof RequestTimeoutError)
    return { status: 504, message: dev ? error.message : 'Gateway Timeout' }

  return error instanceof Denied ? { status: error.status, message: error.message, ...error.data !== undefined && { data: error.data } } : describeError(error, dev)
}

// The error page is answered whatever the clock said: it stops, and `ctx.signal` follows only the client leaving, so a fetch of a layout is not cut by the timeout that brought the page here.
export function calmDeadline(ctx: RequestContext): void {
  const { request } = ctx

  recordOf(request)?.deadline?.stop()
  Object.defineProperty(ctx, 'signal', { get: () => request.signal, configurable: true })
}

// A server render failing on a browser-only global says which one, the component and line reading it and the ways out in the error's own message, so the log, `onError` and the development page all carry it, whatever the mode; only a failure pays for the source maps it reads.
export function nameBrowserRead(error: unknown): void {
  if (!(error instanceof Error) || named.has(error))
    return

  const stack = mappedStack(error)
  const hint = stack === undefined ? undefined : browserOnlyHint(error, stack)

  if (hint !== undefined && hint !== '') {
    named.add(error)
    error.message = hint
  }
}

export function describeError(error: unknown, dev = false): PageError {
  if (!dev)
    return { status: 500, message: 'Internal Server Error' }

  if (!(error instanceof Error))
    return { status: 500, message: String(error) }

  const stack = mappedStack(error)
  const hint = stack === undefined ? undefined : browserOnlyHint(error, stack)

  return { status: 500, message: hint !== undefined && hint !== '' ? hint : error.message, stack }
}
