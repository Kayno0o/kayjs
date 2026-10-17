import type { KayConfig } from '../config'
import { kayLog } from '../runtime/log'
import { recordRequestError } from './dev-errors'
import { logMessage } from './log'

// Logs an error kay caught while answering `request`, under that request, and hands it to the app's `onError`, without holding the response for it.
export function reportServerError(error: unknown, request: Request, onError: KayConfig['onError']): void {
  logMessage('error', '', error, request)
  recordRequestError(error, request)

  if (onError)
    void deliver(error, request, onError)
}

async function deliver(error: unknown, request: Request | undefined, onError: NonNullable<KayConfig['onError']>): Promise<void> {
  try {
    await onError(error, request)
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
