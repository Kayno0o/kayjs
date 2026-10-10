import type { KayConfig } from '../config'
import { logError } from '../build/sourcemap'
import { pathOf } from './log'
import { requestId } from './protection'

// Logs an error kay caught while answering `request`, under the request it belongs to, and hands it to the app's `onError`, without holding the response for it.
export function reportServerError(error: unknown, request: Request, onError: KayConfig['onError']): void {
  const answering = `${request.method} ${pathOf(request.url)}, request ${requestId(request)}`

  logError(error, `kay: ${answering}`)

  if (onError)
    void deliver(error, request, onError, answering)
}

async function deliver(error: unknown, request: Request, onError: NonNullable<KayConfig['onError']>, answering: string): Promise<void> {
  try {
    await onError(error, request)
  }
  // A failing reporter is logged, never left to crash the process as an unhandled rejection.
  catch (failure) {
    logError(failure, `kay: onError failed for ${answering}`)
  }
}
