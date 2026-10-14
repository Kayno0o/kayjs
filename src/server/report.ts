import type { KayConfig } from '../config'
import { recordRequestError } from './dev-errors'
import { logMessage } from './log'

// Logs an error kay caught while answering `request`, under that request, and hands it to the app's `onError`, without holding the response for it.
export function reportServerError(error: unknown, request: Request, onError: KayConfig['onError']): void {
  logMessage('error', '', error, request)
  recordRequestError(error, request)

  if (onError)
    void deliver(error, request, onError)
}

async function deliver(error: unknown, request: Request, onError: NonNullable<KayConfig['onError']>): Promise<void> {
  try {
    await onError(error, request)
  }
  // A failing reporter is logged, never left to crash the process as an unhandled rejection.
  catch (failure) {
    logMessage('error', 'onError failed', failure, request)
  }
}
