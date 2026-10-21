import type { KayConfig } from '../config'
import { callHook } from '../runtime/hook'
import { kayLog } from '../runtime/log'
import { recordRequestError } from './dev-errors'
import { logMessage } from './log'
import { judgingReads, RequestReadError } from './request-read'

const ELYSIA_CODES = new Set(['NOT_FOUND', 'PARSE', 'VALIDATION', 'INVALID_COOKIE_SIGNATURE', 'INVALID_FILE_TYPE'])

// Elysia names the errors it means to answer itself; a hook or route that threw anything else reaches the catch-all with `UNKNOWN`, with no code from an `onRequest` hook, or with the error's own `code` (`ENOENT`, a database's), which Elysia takes for the context's.
// An error class the app registered with `.error()` keeps its own name as the code and is left to the app.
export function isUncaught(error: unknown, code: unknown): boolean {
  if (code === undefined || code === 'UNKNOWN' || code === 'INTERNAL_SERVER_ERROR')
    return true

  return typeof code === 'string' && !ELYSIA_CODES.has(code) && (error as { code?: unknown } | null)?.code === code
}

const reported = new WeakMap<Request, Set<unknown>>()

// Logs an error kay caught while answering `request`, under that request, and hands it to the app's `onError`, without holding the response for it.
export function reportServerError(error: unknown, request: Request, onError: KayConfig['onError']): void {
  const seen = reported.get(request)

  // Reported once per request, as the catch-all for errors no route caught meets the ones a route's own handler reported already.
  if (seen?.has(error))
    return

  if (seen)
    seen.add(error)
  else
    reported.set(request, new Set([error]))

  // A read of what a request holds, met while the build renders a page once, is for the build to judge: it is no failure of a request.
  if (error instanceof RequestReadError && onError && judgingReads.has(onError)) {
    void deliver(error, request, onError)

    return
  }

  logMessage('error', '', error, request)
  recordRequestError(error, request)

  if (onError)
    void deliver(error, request, onError)
}

async function deliver(error: unknown, request: Request | undefined, onError: NonNullable<KayConfig['onError']>): Promise<void> {
  try {
    await callHook(onError, { error, request }, [error, request])
  }
  // A failing reporter is logged, never left to crash the process as an unhandled rejection.
  catch (failure) {
    if (request === undefined)
      kayLog('error', 'onError failed', failure)
    else
      logMessage('error', 'onError failed', failure, request)
  }
}

// What `onError` of the app being served is, for the errors met outside any request, where no config is at hand.
let appOnError: KayConfig['onError']

export function useAppOnError(onError: KayConfig['onError']): void {
  appOnError = onError
}

// How long a caller waits for the app's `onError` when it holds a queue worker or delays an exit: a tracker that hangs must not.
const ON_ERROR_TIMEOUT_MS = 10_000

// Logs an error met outside any request, a scheduled, background or queued job or an `onStop` hook, and hands it to the app's `onError` with no request.
// Resolves once `onError` returned, or after `timeout` ms with a log saying it did not, and never rejects, for a caller about to exit or to take its next job to await.
export async function reportBackgroundError(message: string, error: unknown, timeout = ON_ERROR_TIMEOUT_MS): Promise<void> {
  kayLog('error', message, error)

  if (!appOnError)
    return

  let timer: ReturnType<typeof setTimeout> | undefined

  const late = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      kayLog('error', `onError did not finish in ${timeout} ms, not waited for any longer`)
      resolve()
    }, timeout)
  })

  try {
    await Promise.race([deliver(error, undefined, appOnError), late])
  }
  finally {
    clearTimeout(timer)
  }
}
