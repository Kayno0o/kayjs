import type { ObserveConfig } from '../config'
import { within } from '@kaynooo/utils/promise'
import { errorCodeOf } from '../compiler/errors'
import { kayLog } from '../runtime/log'
import { recordRequestError } from './dev-errors'
import { logMessage } from './log'
import { nameBrowserRead } from './page-error'
import { judgingReads, RequestReadError } from './request-read'
import { requestRecord } from './request-record'

const ELYSIA_CODES = new Set(['NOT_FOUND', 'PARSE', 'VALIDATION', 'INVALID_COOKIE_SIGNATURE', 'INVALID_FILE_TYPE'])

// Elysia names the errors it means to answer itself; a hook or route that threw anything else reaches the catch-all with `UNKNOWN`, with no code from an `onRequest` hook, or with the error's own `code` (`ENOENT`, a database's), which Elysia takes for the context's.
// An error class the app registered with `.error()` keeps its own name as the code and is left to the app.
export function isUncaught(error: unknown, code: unknown): boolean {
  if (code === undefined || code === 'UNKNOWN' || code === 'INTERNAL_SERVER_ERROR')
    return true

  return typeof code === 'string' && !ELYSIA_CODES.has(code) && (error as { code?: unknown } | null)?.code === code
}

// Logs an error kay caught while answering `request`, under that request, and hands it to the app's `onError`, without holding the response for it.
export function reportServerError(error: unknown, request: Request, onError: ObserveConfig['onError']): void {
  const record = requestRecord(request)
  const seen = record.reported

  // Reported once per request, as the catch-all for errors no route caught meets the ones a route's own handler reported already.
  if (seen?.has(error))
    return

  if (seen)
    seen.add(error)
  else
    record.reported = new Set([error])

  nameBrowserRead(error)

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

async function deliver(error: unknown, request: Request | undefined, onError: NonNullable<ObserveConfig['onError']>, source?: string): Promise<void> {
  try {
    const code = errorCodeOf(error)

    await onError({ error, request, ...source !== undefined && { source }, ...code !== undefined && { code } })
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
let appOnError: ObserveConfig['onError']

export function useAppOnError(onError: ObserveConfig['onError']): void {
  appOnError = onError
}

// How long a caller waits for the app's `onError` when it holds a queue worker or delays an exit: a tracker that hangs must not.
const ON_ERROR_TIMEOUT_MS = 10_000

// Hands an error to the app's `onError`, and resolves once it returned or after `timeout` ms with a log saying it did not; never rejects.
async function deliverCapped(error: unknown, request: Request | undefined, timeout: number, source?: string): Promise<void> {
  const onError = appOnError

  if (!onError)
    return

  if (await within(deliver(error, request, onError, source), timeout, 'late' as const) === 'late')
    kayLog('error', `onError did not finish in ${timeout} ms, not waited for any longer`)
}

// Logs an error met outside any request, a scheduled, background or queued job or an `onStop` hook, and hands it to the app's `onError` with no request.
// Resolves once `onError` returned, or after `timeout` ms with a log saying it did not, and never rejects, for a caller about to exit or to take its next job to await.
export async function reportBackgroundError(message: string, error: unknown, timeout = ON_ERROR_TIMEOUT_MS): Promise<void> {
  kayLog('error', message, error)
  await deliverCapped(error, undefined, timeout)
}

// Logs an error a hook threw or left running, as `notify` and `decide` meet it, and hands it to the app's `onError` with the hook's `source` (`'cms.onSave'`), under its request when it has one.
export async function reportHookError(source: string, error: unknown, request: Request | undefined): Promise<void> {
  if (request === undefined)
    kayLog('error', `${source} failed`, error)
  else
    logMessage('error', `${source} failed`, error, request)

  await deliverCapped(error, request, ON_ERROR_TIMEOUT_MS, source)
}
