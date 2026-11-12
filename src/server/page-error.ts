import type { PageError } from '../runtime'
import type { RequestContext } from './render'
import { browserOnlyHint, mappedStack } from '../build/sourcemap'
import { browserGlobalMissing } from '../compiler/globals'
import { recordOf } from './request-record'
import { RequestTimeoutError } from './request-timeout'
import { Denied, NotFound } from './signals'

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

// A server render failing on a browser-only global says which one, the component and line reading it and the ways out in the error's own message, so the log, `onError` and the development page all carry it, whatever the mode.
// Only a ReferenceError for such a name pays for the source maps; the original wording stays in `stack`.
export function nameBrowserRead(error: unknown): void {
  if (!(error instanceof Error) || browserGlobalMissing(error) === undefined)
    return

  const stack = mappedStack(error)
  const hint = stack === undefined ? undefined : browserOnlyHint(error, stack)

  if (hint === undefined || hint === '')
    return

  try {
    error.message = hint
  }
  // A frozen error keeps its message: the log still prepends the hint to its stack.
  catch {}
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
