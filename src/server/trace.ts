import { Denied, NotFound, Redirect } from './signals'

// The part of OpenTelemetry's `Tracer` kay calls: an app hands `trace.getTracer('my-site')` from its own @opentelemetry/api, its SDK exporting the spans, and kay depends on neither.
export interface Tracer {
  startSpan: (name: string, options?: SpanOptions) => Span
  startActiveSpan: <F extends (span: Span) => unknown>(name: string, options: SpanOptions, fn: F) => ReturnType<F>
}

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
}

export const SERVER_SPAN = 1
// OpenTelemetry's SpanStatusCode.ERROR.
const ERROR_STATUS = 2

let tracer: Tracer | undefined

export function setTracer(given: Tracer | undefined): void {
  tracer = given
}

// `ctx.redirect()`, `ctx.notFound()` and `ctx.deny()` end the work as the app meant to, so their span is no failure.
export function failed(span: Span, error: unknown): void {
  if (error instanceof Redirect || error instanceof NotFound || error instanceof Denied)
    return

  span.recordException(error instanceof Error ? error : String(error))
  span.setStatus({ code: ERROR_STATUS, message: error instanceof Error ? error.message : String(error) })
}

// A response the server failed: an error status on the span, what threw having been recorded where it threw.
export function answered(span: Span, status: number): void {
  span.setAttribute('http.response.status_code', status)

  if (status >= 500)
    span.setStatus({ code: ERROR_STATUS })
}

// Runs `fn` in a span the work it starts nests under, which ends as `fn` settles, recording what it throws; without a tracer it runs `fn` alone.
export function traced<T>(name: string, options: SpanOptions, fn: (span?: Span) => T): T {
  if (!tracer)
    return fn()

  return tracer.startActiveSpan(name, options, (span) => {
    let result: T

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
  })
}

// A span that outlives one call, such as an API route's from its first hook to its response.
export function startSpan(name: string, options: SpanOptions): Span | undefined {
  return tracer?.startSpan(name, options)
}
