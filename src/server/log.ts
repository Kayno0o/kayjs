import type { Elysia } from 'elysia'
import { ASSET_PREFIX } from '../build/assets'

export interface RequestLog {
  method: string
  // Without the query string, which may carry tokens.
  path: string
  status: number
  // Milliseconds from the request arriving to its response being made, a streamed one's headers.
  duration: number
}

export type RequestLogger = boolean | 'json' | ((entry: RequestLog) => void)

// Logs one line per request to stdout, `GET /blog/hello 200 12ms`, or one JSON object with `json`, or hands each entry to a function; kay's own `/_kay/` routes and the health route are left out.
// A hook, so it reaches the app's routes registered after `pages()`.
export function logRequests(app: Elysia, logger: Exclude<RequestLogger, false>, healthPath?: string): void {
  const started = new WeakMap<Request, { at: number, method: string, path: string, answered?: number }>()
  const write = typeof logger === 'function' ? logger : logger === 'json' ? (entry: RequestLog) => console.log(JSON.stringify({ time: new Date().toISOString(), ...entry })) : (entry: RequestLog) => console.log(`${entry.method} ${entry.path} ${entry.status} ${entry.duration}ms`)

  app.onRequest(({ request }) => {
    const { pathname } = new URL(request.url)

    if (!pathname.startsWith(ASSET_PREFIX) && pathname !== healthPath)
      started.set(request, { at: performance.now(), method: request.method, path: pathname })
  })

  // Elysia runs afterResponse hooks once the event loop gets to them, which a busy server may put off, so the clock stops as the response is made.
  app.mapResponse({ as: 'global' }, ({ request }) => {
    const start = started.get(request)

    if (start)
      start.answered = performance.now()
  })

  app.onAfterResponse({ as: 'global' }, ({ request, set, responseValue }) => {
    const start = started.get(request)

    if (!start)
      return

    const status = responseValue instanceof Response ? responseValue.status : typeof set.status === 'number' ? set.status : 200

    write({ method: start.method, path: start.path, status, duration: Math.round((start.answered ?? performance.now()) - start.at) })
  })
}
