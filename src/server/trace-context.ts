// The W3C trace context a request arrives with, read without OpenTelemetry: the context kay hands the tracer as the parent of a request's span.

// OpenTelemetry's `Context`, the part a tracer reads; an app's `propagation.extract(...)` result is one.
export interface TraceContext {
  getValue: (key: symbol) => unknown
  setValue: (key: symbol, value: unknown) => TraceContext
  deleteValue: (key: symbol) => TraceContext
}

export interface SpanIds {
  traceId: string
  spanId: string
  traceFlags: number
}

const TRACEPARENT = /^00-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/
// `trace.getSpan(context)` reads the span under this key.
const SPAN_KEY = Symbol.for('OpenTelemetry Context Key SPAN')

const NO_ID = /^0+$/
const noId = (id: string) => NO_ID.test(id)

// The ids of a `traceparent` header, or undefined for one malformed or with an all-zero id, which the spec says to ignore.
export function parseTraceparent(header: string | null): SpanIds | undefined {
  const match = header === null ? null : TRACEPARENT.exec(header.trim())

  if (!match || noId(match[1]!) || noId(match[2]!))
    return undefined

  return { traceId: match[1]!, spanId: match[2]!, traceFlags: Number.parseInt(match[3]!, 16) }
}

class RemoteContext implements TraceContext {
  constructor(private readonly values: ReadonlyMap<symbol, unknown>) {}

  getValue(key: symbol): unknown {
    return this.values.get(key)
  }

  setValue(key: symbol, value: unknown): TraceContext {
    return new RemoteContext(new Map(this.values).set(key, value))
  }

  deleteValue(key: symbol): TraceContext {
    const values = new Map(this.values)

    values.delete(key)

    return new RemoteContext(values)
  }
}

// A context whose span is the remote one, which a tracer makes the parent of the server span it starts.
export function remoteContext({ traceId, spanId, traceFlags }: SpanIds): TraceContext {
  return new RemoteContext(new Map([[SPAN_KEY, { spanContext: () => ({ traceId, spanId, traceFlags, isRemote: true }) }]]))
}

// The `traceresponse` header (W3C trace context level 2 draft) telling the caller the trace its request joined or started.
export function traceresponse({ traceId, spanId, traceFlags }: SpanIds): string {
  return `00-${traceId}-${spanId}-${traceFlags.toString(16).padStart(2, '0')}`
}

// The ids of a span, or undefined for one a no-op tracer made.
export function validIds(ids: SpanIds | undefined): SpanIds | undefined {
  return ids && !noId(ids.traceId) && !noId(ids.spanId) ? ids : undefined
}
