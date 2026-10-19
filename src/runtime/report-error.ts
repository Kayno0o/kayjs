import { withBase } from './base'

// Where the browser sends the errors it meets, for the server's `onError`.
const ERROR_URL = '/_kay/error'
const MAX_REPORTS = 10
const reported = new Set<string>()

// Sends an error to the server once per message and place, a few per page load at most, with the page's path only: its query and hash may hold what the user typed.
export function sendError(error: unknown, island?: string): void {
  const { name, message, stack } = error instanceof Error ? error : { name: 'Error', message: String(error), stack: undefined }
  const key = `${message}\n${stack}`

  if (reported.has(key) || reported.size >= MAX_REPORTS)
    return

  reported.add(key)
  void post(JSON.stringify({ name, message, stack, island, url: location.origin + location.pathname }))
}

async function post(body: string): Promise<void> {
  try {
    await fetch(withBase(ERROR_URL), { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body })
  }
  catch {}
}
