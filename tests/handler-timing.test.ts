import type { Action } from '../src/runtime'
import type { Span, SpanOptions, Tracer } from '../src/server/trace'
import type { TraceContext } from '../src/server/trace-context'
import { AsyncLocalStorage } from 'node:async_hooks'
import { join } from 'node:path'
import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { encodeCall } from '../src/runtime/action'
import { observed } from '../src/server/api'
import { setTracer } from '../src/server/trace'
import { testSite } from '../src/test'

const ROOT = 'tests/fixtures/handler-timing'
const fixture = join(import.meta.dir, 'fixtures/handler-timing/src/routes')
const SPAN_KEY = Symbol.for('OpenTelemetry Context Key SPAN')
const AUTH = { authorization: 'Bearer x' }
const GUARDS = /^guards;dur=\d+\.\d$/
const HANDLER = /^handler;dur=\d+\.\d$/
const BOTH = /^guards;dur=\d+\.\d, handler;dur=\d+\.\d$/

// The sites a test opens, shut when it ends.
const opened: { close: () => Promise<void> }[] = []

afterEach(async () => {
  setTracer(undefined)
  await Promise.all(opened.splice(0).map(async site => site.close()))
})

async function site(options: Omit<NonNullable<Parameters<typeof testSite>[0]>, 'root' | 'islands'> = {}) {
  const made = await testSite({ root: ROOT, islands: false, ...options })

  opened.push(made)

  return made
}

// A call as an island posts it, to the action of the open page or of the guarded one; read once a site is up, which sets its url.
async function call(made: Awaited<ReturnType<typeof site>>, page: 'open' | 'members', headers: Record<string, string> = {}) {
  const { headers: own, body } = encodeCall({})
  const { save } = await import(join(fixture, page === 'open' ? 'index.kay' : 'members/index.kay')) as { save: Action<Record<never, never>, string> }

  return made.fetch(save.url, { method: 'POST', headers: { ...own, ...headers, origin: 'http://localhost' }, body })
}

interface Recorded {
  name: string
  parent: string | undefined
}

// A tracer with OpenTelemetry's four-argument `startActiveSpan`, which parents a span on the one stored under the context's span key, else on the span active where it starts.
function nesting(): { tracer: Tracer, ended: Recorded[] } {
  const active = new AsyncLocalStorage<string>()
  const ended: Recorded[] = []
  const make = (name: string, context?: TraceContext): Span & { name: string } => {
    const record = { name, parent: (context?.getValue(SPAN_KEY) as { name?: string } | undefined)?.name ?? active.getStore() }

    return { name, setAttribute: () => undefined, setStatus: () => undefined, recordException: () => undefined, end: () => void ended.push(record) }
  }
  const startActiveSpan = (name: string, _options: SpanOptions, context: TraceContext | ((span: Span) => unknown), fn?: (span: Span) => unknown) => {
    const run = fn ?? context as (span: Span) => unknown
    const span = make(name, fn ? context as TraceContext : undefined)

    return active.run(name, () => run(span))
  }

  return { tracer: { startSpan: (name, _options, context) => make(name, context), startActiveSpan: startActiveSpan as Tracer['startActiveSpan'] }, ended }
}

const variants = [
  ['root', {}],
  ['mounted', { base: '/blog', trailingSlash: 'always' as const }],
] as const

describe('the spans of an API handler', () => {
  for (const [name, options] of variants) {
    it(`nest under the request's span, through a handler that awaits (${name})`, async () => {
      const { tracer, ended } = nesting()
      const made = await site({ ...options, observe: { tracer } })
      const response = await made.fetch('/api/probe')

      expect(await response.text()).toBe('worked')

      // Elysia ends the request's span once the response is out.
      for (let tries = 0; ended.length < 3 && tries < 100; tries++)
        await Bun.sleep(5)

      const request = ended.find(span => span.parent === undefined)!
      const handler = ended.find(span => span.name.startsWith('kay.handler '))!

      expect(request.name).toMatch(/^GET \/.*api\/probe\/?$/)
      expect(handler.name).toBe(`kay.handler ${request.name}`)
      expect(handler.parent).toBe(request.name)
      expect(ended.find(span => span.name === 'probe.work')).toEqual({ name: 'probe.work', parent: handler.name })
      expect(ended).toHaveLength(3)
    })
  }

  it('wraps a handler that starts no span of its own in one, and starts none without a tracer', async () => {
    const { tracer, ended } = nesting()
    const made = await site({ observe: { tracer } })

    expect((await made.fetch('/api/members', { headers: AUTH })).status).toBe(200)

    for (let tries = 0; ended.length < 2 && tries < 100; tries++)
      await Bun.sleep(5)

    expect(ended.map(span => span.name).toSorted()).toEqual(['GET /api/members', 'kay.handler GET /api/members'])

    setTracer(undefined)
    ended.length = 0

    const bare = await site()

    expect((await bare.fetch('/api/probe')).status).toBe(200)
    expect(ended).toEqual([])
  })
})

describe('Server-Timing on an API route', () => {
  for (const [name, options] of variants) {
    it(`carries the guards and the handler when serverTiming is on (${name})`, async () => {
      const made = await site({ ...options, observe: { serverTiming: true } })

      expect((await made.fetch('/api/members', { headers: AUTH })).headers.get('server-timing')).toMatch(BOTH)
      expect((await made.fetch('/api/probe')).headers.get('server-timing')).toMatch(HANDLER)
    })
  }

  it('adds to a Server-Timing the handler set, and sends none for a handler that threw', async () => {
    const made = await site({ observe: { serverTiming: true } })
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      expect((await made.fetch('/api/own')).headers.get('server-timing')).toMatch(/^upstream;dur=1, handler;dur=\d+\.\d$/)

      const failed = await made.fetch('/api/boom')

      expect(failed.status).toBe(500)
      expect(failed.headers.get('server-timing')).toBeNull()
    }
    finally {
      logged.mockRestore()
    }
  })

  it('is sent in development unless serverTiming is false, and never in production by default', async () => {
    expect((await (await site({ dev: true })).fetch('/api/probe')).headers.get('server-timing')).toMatch(HANDLER)
    expect((await (await site({ dev: true, observe: { serverTiming: false } })).fetch('/api/probe')).headers.get('server-timing')).toBeNull()
    expect((await (await site()).fetch('/api/probe')).headers.get('server-timing')).toBeNull()
  })

  it('keeps the handler as written when neither tracing nor timing is on', () => {
    const handler = () => 'x'

    setTracer(undefined)

    expect(observed(handler, 'GET /x', { i18n: undefined as never })).toBe(handler)
    expect(observed(handler, 'GET /x', { i18n: undefined as never, serverTiming: false })).toBe(handler)
    expect(observed(handler, 'GET /x', { i18n: undefined as never, serverTiming: true })).not.toBe(handler)
  })
})

describe('Server-Timing on an action', () => {
  for (const [name, options] of variants) {
    it(`carries its guards and handler when serverTiming is on (${name})`, async () => {
      const made = await site({ ...options, observe: { serverTiming: true } })
      const guarded = await call(made, 'members', AUTH)

      expect(guarded.status).toBe(200)
      expect(guarded.headers.get('server-timing')).toMatch(BOTH)
      expect((await call(made, 'open')).headers.get('server-timing')).toMatch(HANDLER)
    })
  }

  it('leaves a refused call without a handler entry, and sends nothing when serverTiming is off', async () => {
    const on = await site({ observe: { serverTiming: true } })
    const refused = await call(on, 'members')

    expect(refused.status).toBe(401)
    expect(refused.headers.get('server-timing')).toBeNull()

    const off = await site()

    expect((await call(off, 'members', AUTH)).headers.get('server-timing')).toBeNull()
    expect((await call(off, 'open')).headers.get('server-timing')).toBeNull()
  })

  it('follows development: on by default, off with serverTiming false', async () => {
    expect((await call(await site({ dev: true }), 'open')).headers.get('server-timing')).toMatch(HANDLER)
    expect((await call(await site({ dev: true, observe: { serverTiming: false } }), 'open')).headers.get('server-timing')).toBeNull()
  })
})

describe('Server-Timing on an endpoint', () => {
  for (const [name, options] of variants) {
    it(`carries its guards and handler when serverTiming is on (${name})`, async () => {
      const made = await site({ ...options, observe: { serverTiming: true } })

      expect((await made.fetch('/members/export.csv', { headers: AUTH })).headers.get('server-timing')).toMatch(BOTH)
      expect((await made.fetch('/open.json')).headers.get('server-timing')).toMatch(HANDLER)
    })
  }

  it('adds to a Server-Timing the endpoint returned, and copies a response whose headers are immutable', async () => {
    const made = await site({ observe: { serverTiming: true } })

    expect((await made.fetch('/own.json')).headers.get('server-timing')).toMatch(/^upstream;dur=1, handler;dur=\d+\.\d$/)

    const moved = await made.fetch('/moved.txt', { redirect: 'manual' })

    expect(moved.status).toBe(302)
    expect(moved.headers.get('server-timing')).toMatch(HANDLER)
  })

  it('gives a request the guards refuse their time alone, and sends nothing when serverTiming is off', async () => {
    const on = await site({ observe: { serverTiming: true } })
    const refused = await on.fetch('/members/export.csv')

    expect(refused.status).toBe(401)
    expect(refused.headers.get('server-timing')).toMatch(GUARDS)

    const off = await site()

    expect((await off.fetch('/members/export.csv', { headers: AUTH })).headers.get('server-timing')).toBeNull()
    expect((await off.fetch('/open.json')).headers.get('server-timing')).toBeNull()
  })

  it('follows development: on by default, off with serverTiming false', async () => {
    expect((await (await site({ dev: true })).fetch('/open.json')).headers.get('server-timing')).toMatch(HANDLER)
    expect((await (await site({ dev: true, observe: { serverTiming: false } })).fetch('/open.json')).headers.get('server-timing')).toBeNull()
  })
})
