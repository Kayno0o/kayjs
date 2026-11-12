import type { SpanIds, TraceContext } from './trace-context'
import { errorCodeOf } from '../compiler/errors'
import { logMessage } from './log'
import { requestRecord } from './request-record'
import { Denied, NotFound, Redirect } from './signals'
import { contextOf, parseTraceparent, remoteContext, traceresponse, validIds } from './trace-context'

// The part of OpenTelemetry's `Tracer` kay calls: an app hands `trace.getTracer('my-site')` from its own @opentelemetry/api, its SDK exporting the spans, and kay depends on neither.
export interface Tracer {
  startSpan: (name: string, options?: SpanOptions, context?: TraceContext) => Span
  // OpenTelemetry's also takes `(name, options, context, fn)`, which kay uses when a request carries a parent; a tracer declaring three parameters gets `startSpan` with the parent instead, and its span is not made the active one.
  startActiveSpan: <F extends (span: Span) => unknown>(name: string, options: SpanOptions, fn: F) => ReturnType<F>
}

type ActiveWithParent = <F extends (span: Span) => unknown>(name: string, options: SpanOptions, context: TraceContext, fn: F) => ReturnType<F>

// What `observe.extract` is: reads the context a request arrives with out of its headers, `undefined` for none.
export type TraceExtractor = (headers: Headers) => TraceContext | undefined

export interface SpanOptions {
  // OpenTelemetry's SpanKind: 1 for the server span a request makes, 0 for the work inside it.
  kind?: number | undefined
  attributes?: Record<string, string | number | boolean> | undefined
}

export interface Span {
  setAttribute: (key: string, value: string | number | boolean) => unknown
  setStatus: (status: { code: number, message?: string }) => unknown
  recordException: (exception: Error | string) => unknown
  end: () => void
  // Its trace and span ids, which the log and the `traceresponse` header carry.
  spanContext?: () => SpanIds
}

export const SERVER_SPAN = 1
// OpenTelemetry's SpanStatusCode.ERROR.
const ERROR_STATUS = 2

let tracer: Tracer | undefined
let extractor: TraceExtractor | false | undefined
let warnedExtract = false

export function setTracer(given: Tracer | undefined, extract?: TraceExtractor | false): void {
  tracer = given
  extractor = extract
  warnedExtract = false
}

// The parent a request's span goes under: what `observe.extract` reads, else its `traceparent` header; none when `extract` is `false`.
function parentOf(request: Request): TraceContext | undefined {
  if (extractor === false)
    return undefined

  if (extractor === undefined) {
    const ids = parseTraceparent(request.headers.get('traceparent'))
    const state = request.headers.get('tracestate')

    return ids && remoteContext(state === null ? ids : { ...ids, traceState: state })
  }

  try {
    return extractor(request.headers)
  }
  catch (error) {
    if (!warnedExtract) {
      warnedExtract = true
      logMessage('warn', 'kay: observe.extract threw, so the request starts a trace of its own (said once)', error, request)
    }

    return undefined
  }
}

// Notes the trace a request's span belongs to, for its log lines and its `traceresponse` header.
export function noteTrace(request: Request, span: Span | undefined): void {
  const ids = validIds(span?.spanContext?.())

  if (ids)
    requestRecord(request).trace = ids
}

// Sends the `traceresponse` header of a request whose span was traced, on a response or on Elysia's `set`; written here, as Elysia parses the headers of a route whose handler names them.
export function replyTrace(request: Request, target: { headers: Headers | Record<string, string | number | undefined> }): void {
  const ids = requestRecord(request).trace

  if (!ids)
    return

  try {
    if (target.headers instanceof Headers)
      target.headers.set('traceresponse', traceresponse(ids))
    else
      target.headers.traceresponse = traceresponse(ids)
  }
  // Headers a `Response.redirect()` made are immutable.
  catch {}
}

export function tracing(): boolean {
  return tracer !== undefined
}

// `ctx.redirect()`, `ctx.notFound()` and `ctx.deny()` end the work as the app meant to, so their span is no failure.
export function failed(span: Span, error: unknown): void {
  if (error instanceof Redirect || error instanceof NotFound || error instanceof Denied)
    return

  span.recordException(error instanceof Error ? error : String(error))

  const code = errorCodeOf(error)

  if (code !== undefined)
    span.setAttribute('kay.error.code', code)

  span.setStatus({ code: ERROR_STATUS, message: error instanceof Error ? error.message : String(error) })
}

// A response the server failed: an error status on the span, what threw having been recorded where it threw.
export function answered(span: Span, status: number): void {
  span.setAttribute('http.response.status_code', status)

  if (status >= 500)
    span.setStatus({ code: ERROR_STATUS })
}

// Runs `fn` in a span the work it starts nests under, which ends as `fn` settles, recording what it throws; without a tracer it runs `fn` alone, a name given as a function never built.
// A `request` makes the span a server span under the trace its headers carry.
export function traced<T>(name: string | (() => string), options: SpanOptions | (() => SpanOptions), fn: (span?: Span) => T, request?: Request): T {
  return tracer ? inSpan(tracer, name, options, request && parentOf(request), fn, request) : fn()
}

// Runs `fn` in a span under `parent`, a span that outlives one call such as an API route's, which a handler running in Elysia's call is not otherwise nested under.
export function tracedUnder<T>(parent: Span, name: string | (() => string), fn: (span?: Span) => T): T {
  return tracer ? inSpan(tracer, name, {}, contextOf(parent), fn, undefined) : fn()
}

function inSpan<T>(own: Tracer, name: string | (() => string), options: SpanOptions | (() => SpanOptions), parent: TraceContext | undefined, fn: (span?: Span) => T, request: Request | undefined): T {
  const run = (span: Span) => {
    let result: T

    if (request)
      noteTrace(request, span)

    try {
      result = fn(span)
    }
    catch (error) {
      failed(span, error)
      span.end()

      throw error
    }

    if (!(result instanceof Promise)) {
      span.end()

      return result
    }

    const settled = async () => {
      try {
        return await result
      }
      catch (error) {
        failed(span, error)

        throw error
      }
      finally {
        span.end()
      }
    }

    return settled() as T
  }
  const given = typeof options === 'function' ? options() : options
  const title = typeof name === 'string' ? name : name()

  if (!parent)
    return own.startActiveSpan(title, given, run)

  // A wrapper written with rest parameters declares none, and forwards all four to a real tracer.
  if (own.startActiveSpan.length >= 4 || own.startActiveSpan.length === 0)
    return (own.startActiveSpan as unknown as ActiveWithParent)(title, given, parent, run)

  return run(own.startSpan(title, given, parent))
}

// A span that outlives one call, such as an API route's from its first hook to its response.
export function startSpan(name: string, options: SpanOptions, request?: Request): Span | undefined {
  const parent = request && tracer && parentOf(request)
  const span = parent ? tracer?.startSpan(name, options, parent) : tracer?.startSpan(name, options)

  if (request)
    noteTrace(request, span)

  return span
}
