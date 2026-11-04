import type { Span, SpanOptions, Tracer } from '../src/server/trace'
import type { SpanIds, TraceContext } from '../src/server/trace-context'
import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import { pages } from '../src/server'
import { setTracer } from '../src/server/trace'
import { parseTraceparent } from '../src/server/trace-context'

const TRACE = '0af7651916cd43dd8448eb211c80319c'
const PARENT = 'b7ad6b7169203331'
const INCOMING = `00-${TRACE}-${PARENT}-01`
const SPAN_KEY = Symbol.for('OpenTelemetry Context Key SPAN')

interface Started {
  name: string
  // The ids of the remote span the context it was started with names.
  parent: SpanIds | undefined
  ids: SpanIds
}

// A tracer reading its parent the way OpenTelemetry's does, from the span stored under its context key, and giving each span its parent's trace id.
function tracer(): { tracer: Tracer, started: Started[] } {
  const started: Started[] = []
  let counter = 0
  const make = (name: string, _options?: SpanOptions, context?: TraceContext): Span => {
    const remote = (context?.getValue(SPAN_KEY) as { spanContext: () => SpanIds } | undefined)?.spanContext()
    const ids = { traceId: remote?.traceId ?? 'f'.repeat(32), spanId: String(++counter).padStart(16, '0'), traceFlags: remote?.traceFlags ?? 0 }

    started.push({ name, parent: remote, ids })

    return { setAttribute: () => undefined, setStatus: () => undefined, recordException: () => undefined, end: () => undefined, spanContext: () => ids }
  }

  return {
    tracer: {
      startSpan: make,
      startActiveSpan: (name: string, options: SpanOptions, ...rest: unknown[]) => {
        const fn = rest.at(-1) as (span: Span) => unknown

        return fn(make(name, options, rest.length === 2 ? rest[0] as TraceContext : undefined))
      },
    },
    started,
  }
}

const visit = (headers: Record<string, string> = {}, path = '/') => new Request(`http://localhost${path}`, { headers })

describe('parseTraceparent', () => {
  it('reads a version 00 header and refuses the malformed and all-zero ones', () => {
    expect(parseTraceparent(INCOMING)).toEqual({ traceId: TRACE, spanId: PARENT, traceFlags: 1 })
    expect(parseTraceparent(` ${INCOMING} `)).toEqual({ traceId: TRACE, spanId: PARENT, traceFlags: 1 })
    expect(parseTraceparent(null)).toBeUndefined()

    for (const bad of ['', 'garbage', `01-${TRACE}-${PARENT}-01`, `00-${TRACE.toUpperCase()}-${PARENT}-01`, `00-${'0'.repeat(32)}-${PARENT}-01`, `00-${TRACE}-${'0'.repeat(16)}-01`, `00-${TRACE}-${PARENT}`, `00-${TRACE}-${PARENT}-1`, `${INCOMING}-extra`])
      expect(parseTraceparent(bad)).toBeUndefined()
  })
})

describe('an incoming traceparent', () => {
  afterAll(() => setTracer(undefined))

  it('puts the page span under the caller\'s trace, and answers the trace it joined', async () => {
    const { tracer: recording, started } = tracer()
    const site = await pages({ root: 'tests/fixtures/site', tracer: recording })
    const response = await site.handle(visit({ traceparent: INCOMING }))

    expect(response.status).toBe(200)
    expect(started[0]).toMatchObject({ name: 'GET /', parent: { traceId: TRACE, spanId: PARENT, traceFlags: 1 }, ids: { traceId: TRACE, spanId: '0000000000000001', traceFlags: 1 } })
    expect(response.headers.get('traceresponse')).toBe(`00-${TRACE}-0000000000000001-01`)
  })

  it('starts a trace of its own for a malformed header and sends its id', async () => {
    const { tracer: recording, started } = tracer()
    const site = await pages({ root: 'tests/fixtures/site', tracer: recording })
    const response = await site.handle(visit({ traceparent: `00-${'0'.repeat(32)}-${PARENT}-01` }))

    expect(started[0]!.parent).toBeUndefined()
    expect(response.headers.get('traceresponse')).toBe(`00-${'f'.repeat(32)}-0000000000000001-00`)
  })

  it('sends no traceresponse without a tracer', async () => {
    setTracer(undefined)

    const site = await pages({ root: 'tests/fixtures/site' })

    expect((await site.handle(visit({ traceparent: INCOMING }))).headers.has('traceresponse')).toBe(false)
  })

  it('is read by the extractor the config gives, and ignored when it is false', async () => {
    const seen: string[] = []
    const { tracer: recording, started } = tracer()
    const custom = await pages({ root: 'tests/fixtures/site', observe: { tracer: recording, extract: (headers) => {
      seen.push(headers.get('x-trace') ?? '')

      return {
        getValue: () => ({ spanContext: () => ({ traceId: TRACE, spanId: PARENT, traceFlags: 1 }) }),
        setValue: () => { throw new Error('unused') },
        deleteValue: () => { throw new Error('unused') },
      }
    } } })

    await custom.handle(visit({ 'x-trace': 'abc' }))
    expect(seen).toEqual(['abc'])
    expect(started[0]!.parent).toMatchObject({ traceId: TRACE })

    const { tracer: ignoring, started: ignored } = tracer()
    const off = await pages({ root: 'tests/fixtures/site', observe: { tracer: ignoring, extract: false } })

    await off.handle(visit({ traceparent: INCOMING }))
    expect(ignored[0]!.parent).toBeUndefined()
  })

  it('warns and starts a new trace when the extractor throws', async () => {
    const warned = spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      const { tracer: recording, started } = tracer()
      const site = await pages({ root: 'tests/fixtures/site', observe: { tracer: recording, extract: () => {
        throw new Error('bad carrier')
      } } })

      expect((await site.handle(visit({ traceparent: INCOMING }))).status).toBe(200)
      expect(started[0]!.parent).toBeUndefined()
      expect(warned).toHaveBeenCalled()
    }
    finally {
      warned.mockRestore()
    }
  })

  it('is on the request line and the messages logged under it', async () => {
    const lines: unknown[] = []
    const { tracer: recording } = tracer()
    const site = await pages({ root: 'tests/fixtures/site', tracer: recording, log: (entry: unknown) => void lines.push(entry) })
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      await site.handle(visit({ traceparent: INCOMING }))
      await site.handle(visit({ traceparent: INCOMING }, '/boom?fail'))
      await Bun.sleep(20)

      expect(lines).toContainEqual(expect.objectContaining({ type: 'request', path: '/', trace: TRACE }))
      expect(lines).toContainEqual(expect.objectContaining({ type: 'message', request: expect.objectContaining({ path: '/boom', trace: TRACE }) }))
    }
    finally {
      logged.mockRestore()
    }
  })

  it('joins the trace of an API request and an action call', async () => {
    const { tracer: recording, started } = tracer()
    const lines = spyOn(console, 'log').mockImplementation(() => undefined)

    try {
      const api = await pages({ root: 'tests/fixtures/production', prebuilt: false, tracer: recording })
      const echoed = await api.handle(new Request('http://localhost/api/echo', { method: 'POST', headers: { 'traceparent': INCOMING, 'content-type': 'text/plain' }, body: 'hello' }))

      expect(started.at(-1)).toMatchObject({ name: 'POST /api/echo', parent: { traceId: TRACE } })
      expect(echoed.headers.get('traceresponse')).toMatch(new RegExp(`^00-${TRACE}-\\d{16}-01$`))

      const bare = await pages({ routes: 'tests/fixtures/bare/src/routes', prebuilt: true, tracer: recording })
      const url = '/_kay/action/tests/fixtures/bare/src/routes/survey.kay/answer'
      const answered = await bare.handle(new Request(`http://localhost${url}`, { method: 'POST', headers: { traceparent: INCOMING, referer: 'http://localhost/survey' }, body: new URLSearchParams('tags=a&count=3') }))

      expect(answered.headers.get('traceresponse')).toMatch(new RegExp(`^00-${TRACE}-\\d{16}-01$`))
    }
    finally {
      lines.mockRestore()
    }
  })
})
