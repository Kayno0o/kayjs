import type { Elysia } from 'elysia'
import type { LogLevel } from '../runtime/log'
import { AsyncLocalStorage } from 'node:async_hooks'
import process from 'node:process'
import { version } from '../../package.json'
import { ASSET_PREFIX } from '../build/assets'
import { describeThrown } from '../build/sourcemap'
import { setLogSink } from '../runtime/log'
import { requestId } from './protection'

// One line of the request log.
export interface RequestEntry {
  type: 'request'
  time: string
  level: 'info'
  method: string
  // Without the query string, which may carry tokens.
  path: string
  status: number
  // Milliseconds from the request arriving to its response being made, a streamed one's headers.
  duration: number
  // What its `X-Request-Id` header says, and the messages logged while answering it.
  id: string
}

// One of kay's own messages, an error it caught, a warning about the app, a notice such as a shutdown, or a library's, logged through `logFrom`.
export interface MessageEntry {
  type: 'message'
  time: string
  level: LogLevel
  // Who logged it: `'kay'`, or the name a library gave `logFrom`.
  from: string
  message: string
  // The request being answered when it was logged.
  request?: { method: string, path: string, id: string }
  // What was thrown, its stack mapped to `.kay` lines.
  error?: { name: string, message: string, stack?: string }
}

export type LogEntry = RequestEntry | MessageEntry

// `true` logs requests outside production too, `false` logs none; kay's messages go out either way, as text, as JSON with `'json'`, or to the function.
export type Logger = boolean | 'json' | ((entry: LogEntry) => void)

type Write = (entry: LogEntry) => void

const CONSOLE = { info: 'log', warn: 'warn', error: 'error' } as const
// The request each async context answers, set as it arrives.
const answering = new AsyncLocalStorage<Request>()
// The requests being answered: a context outliving its answer, a timer it started say, no longer logs under it.
const inFlight = new WeakSet<Request>()

// The path of a request's absolute URL, cut out rather than parsed: a request's URL comes normalized already, and parsing one costs more than logging it.
export function pathOf(url: string): string {
  const start = url.indexOf('/', url.indexOf('//') + 2)
  const query = url.indexOf('?', start)

  return url.slice(start, query === -1 ? undefined : query)
}

// Writes an entry as the `log` option says: a line of text, a JSON object, or a call to the app's function.
function writerFor(logger: Logger): Write {
  if (typeof logger === 'function')
    return logger

  if (logger === 'json')
    return entry => console[CONSOLE[entry.level]](JSON.stringify(entry))

  return entry => console[CONSOLE[entry.level]](formatted(entry))
}

function formatted(entry: LogEntry): string {
  if (entry.type === 'request')
    return `${entry.method} ${entry.path} ${entry.status} ${entry.duration}ms ${entry.id}`

  const about = entry.request && `${entry.request.method} ${entry.request.path}, request ${entry.request.id}`
  // The stack's first line says an error's message already.
  const message = entry.message === entry.error?.message ? undefined : entry.message
  const heading = `${entry.from}: ${[about, message].filter(part => part !== undefined && part !== '').join(': ')}`

  return entry.error ? `${heading}\n${entry.error.stack ?? `${entry.error.name}: ${entry.error.message}`}` : heading
}

let write = writerFor(true)

// Sends kay's messages, those of `kay` and `kay/server` alike, where the app's `log` option says; text until `pages()` sets it up.
export function useLogger(logger: Logger): void {
  write = writerFor(logger)
}

setLogSink((level, message, error, request, from) => logMessage(level, message, error, request, from))

// Logs one of kay's messages, or one of the library `from` names, under `request`, or the request being answered; `message` may be empty for an error that says it all.
export function logMessage(level: LogLevel, message: string, error?: unknown, request = currentRequest(), from = 'kay'): void {
  write(messageEntry(level, message, error, request, from))
}

function messageEntry(level: LogLevel, message: string, error?: unknown, request?: Request, from = 'kay'): MessageEntry {
  return {
    type: 'message',
    time: new Date().toISOString(),
    level,
    from,
    message: message === '' && error instanceof Error ? error.message : message,
    ...request && { request: { method: request.method, path: pathOf(request.url), id: requestId(request) } },
    ...error !== undefined && { error: thrown(error) },
  }
}

function thrown(error: unknown): NonNullable<MessageEntry['error']> {
  if (!(error instanceof Error))
    return { name: typeof error, message: describeThrown(error) }

  // Told by its name, as `kay dev` rebuilds it from its client build: its message is the report `kay check` prints, and its frames are the compiler's.
  if (error.name === 'KayCompileError')
    return { name: error.name, message: error.message, stack: error.message.trimStart() }

  return { name: error.name, message: error.message, ...error.stack !== undefined && error.stack !== '' && { stack: describeThrown(error) } }
}

function currentRequest(): Request | undefined {
  const request = answering.getStore()

  return request && inFlight.has(request) ? request : undefined
}

// Runs kay's answer to `request`, a page or an action, so a message logged on the way says which request it was, until the answer is made.
// Entering the context from an Elysia hook instead, which cannot wrap the handler, leaked it into the caller and stalled image requests.
export async function answeringRequest<T>(request: Request, run: () => Promise<T>): Promise<T> {
  inFlight.add(request)

  try {
    return await answering.run(request, run)
  }
  finally {
    inFlight.delete(request)
  }
}

// The server's first line, in the format the `log` option of this `pages()` says: where it listens, which kay runs it in which mode, and how many pages its build prerendered.
export function announceStart(app: Elysia, logger: Exclude<Logger, false>, prerendered: number): void {
  const writeLine = writerFor(logger)

  app.onStart((root) => {
    if (!root.server)
      return

    const mode = process.env.NODE_ENV === undefined ? '' : ` in ${process.env.NODE_ENV}`

    writeLine(messageEntry('info', `listening on ${root.server.url.origin}, kay ${version}${mode}, ${prerendered} ${prerendered === 1 ? 'page' : 'pages'} prerendered`))
  })
}

// Logs one line per request, `GET /blog/hello 200 12ms AZnL...`, in the format the `log` option of this `pages()` says; kay's own `/_kay/` routes and the health route are left out.
// A hook, so it reaches the app's routes registered after `pages()`.
export function logRequests(app: Elysia, logger: Exclude<Logger, false>, healthPath?: string): void {
  const started = new WeakMap<Request, { at: number, method: string, path: string, answered?: number }>()
  const writeLine = writerFor(logger)

  app.onRequest(({ request }) => {
    const pathname = pathOf(request.url)

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

    writeLine({ type: 'request', time: new Date().toISOString(), level: 'info', method: start.method, path: start.path, status, duration: Math.round((start.answered ?? performance.now()) - start.at), id: requestId(request) })
  })
}
