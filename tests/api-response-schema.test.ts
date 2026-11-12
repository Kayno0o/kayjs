import type { LogEntry } from '../src/server/log'
import type { Tracer } from '../src/server/trace'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { KayError } from '../src/compiler/errors'
import { setTracer } from '../src/server/trace'
import { pages } from './shared-pages'

const ROUTES = 'tests/fixtures/bare/src/routes'
const ITEMS = `import { t } from 'elysia'
import { api } from 'kay/server'

export default api()
  .get('/wrong', () => 'text' as unknown as number, { response: t.Number() })
  .get('/right', () => 3, { response: t.Number() })
  .get('/status', ({ status }) => status(200, 'text' as unknown as number), { response: { 200: t.Number() } })
  .post('/', ({ body }) => body.name, { body: t.Object({ name: t.String() }) })
`
const OWN = `import { t } from 'elysia'
import { api } from 'kay/server'

export default api().onError(({ code }) => code === 'VALIDATION' ? new Response('own', { status: 400 }) : undefined).get('/', () => 'text' as unknown as number, { response: t.Number() })
`
const GUARDED = `import { t } from 'elysia'
import { api } from 'kay/server'

export default api().get('/', () => 'text' as unknown as number, { response: t.Number() })
`
const GUARD = `import { guard } from 'kay'

export default guard(({ request, deny }) => {
  if (!request.headers.has('x-admin'))
    deny(403, 'Admins only')
})
`

let dir = ''
const reported: string[] = []
// The first line of an error message, the rest being its details.
const FIRST_LINE = /^.*/

async function app(options: { dev?: boolean, base?: string, trailingSlash?: 'always' | 'never' } = {}) {
  return pages({ requireGuards: false, dirs: { routes: ROUTES, api: join(dir, 'api') }, observe: { onError: ({ error, request }) => void reported.push(`${new URL(request!.url).pathname}: ${FIRST_LINE.exec((error as Error).message)![0]}`) }, prebuilt: true, ...options })
}

beforeAll(async () => {
  dir = await mkdtemp(join(process.cwd(), '.kay/api-response-'))
  await Promise.all([
    Bun.write(join(dir, 'api/items.ts'), ITEMS),
    Bun.write(join(dir, 'api/own.ts'), OWN),
    Bun.write(join(dir, 'api/guarded/_guard.ts'), GUARD),
    Bun.write(join(dir, 'api/guarded/index.ts'), GUARDED),
  ])
})

afterAll(async () => rm(dir, { recursive: true, force: true }))

describe('a response that fails its own schema', () => {
  it('answers a generic 500 in production, logs it and hands it to onError once, for a returned value and a status() answer', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    reported.length = 0

    try {
      const served = await app()
      const wrong = await served.handle(new Request('http://localhost/api/items/wrong'))

      expect(wrong.status).toBe(500)
      expect(await wrong.text()).toBe('Internal Server Error')
      expect((await served.handle(new Request('http://localhost/api/items/status'))).status).toBe(500)
      expect((await served.handle(new Request('http://localhost/api/items/right'))).status).toBe(200)
      expect(reported).toHaveLength(2)
      expect(reported[0]).toContain('/api/items/wrong')
      expect(logged).toHaveBeenCalledTimes(2)
      expect(logged.mock.calls[0]![0]).toContain('GET /api/items/wrong')
    }
    finally {
      logged.mockRestore()
    }
  })

  it('keeps answering 422 for refused input', async () => {
    const served = await app()

    expect((await served.handle(new Request('http://localhost/api/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))).status).toBe(422)
    expect(reported.filter(each => each.startsWith('/api/items:'))).toEqual([])
  })

  it('answers 500 with the detail in dev, and the same under a base and trailing slash (an API is not mounted under them)', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const dev = await app({ dev: true })
      const wrong = await dev.handle(new Request('http://localhost/api/items/wrong'))

      expect(wrong.status).toBe(500)
      expect(await wrong.text()).toContain('Expected number')

      const mounted = await app({ base: '/blog', trailingSlash: 'always' })

      expect((await mounted.handle(new Request('http://localhost/api/items/wrong'))).status).toBe(500)
    }
    finally {
      logged.mockRestore()
    }
  })

  it('is reported even when the module answers validation errors itself, which keeps its answer', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    reported.length = 0

    try {
      const served = await app()
      const own = await served.handle(new Request('http://localhost/api/own'))

      expect(own.status).toBe(400)
      expect(await own.text()).toBe('own')
      expect(reported).toHaveLength(1)
    }
    finally {
      logged.mockRestore()
    }
  })

  it('still answers the guards\' refusal first and a 500 to a caller they admit', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    reported.length = 0

    try {
      const served = await app()

      expect((await served.handle(new Request('http://localhost/api/guarded'))).status).toBe(403)
      expect((await served.handle(new Request('http://localhost/api/guarded', { headers: { 'x-admin': '1' } }))).status).toBe(500)
      expect(reported).toHaveLength(1)
    }
    finally {
      logged.mockRestore()
    }
  })
})

describe('the code of a response that fails its own schema', () => {
  it('is on the log entry, the span as kay.error.code and the onError event', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const entries: LogEntry[] = []
    const events: { code?: string | undefined, error: unknown }[] = []
    const attributes: Record<string, unknown> = {}
    const span = { setAttribute: (key: string, value: unknown) => void (attributes[key] = value), setStatus: () => undefined, recordException: () => undefined, end: () => undefined }
    const tracer = { startSpan: () => span, startActiveSpan: (_name: string, _options: unknown, ...rest: unknown[]) => (rest.at(-1) as (made: typeof span) => unknown)(span) } as unknown as Tracer

    try {
      const served = await pages({ requireGuards: false, dirs: { routes: ROUTES, api: join(dir, 'api') }, observe: { onError: ({ error, code }) => void events.push({ error, code }), log: entry => void entries.push(entry), tracer }, prebuilt: true })

      expect((await served.handle(new Request('http://localhost/api/items/wrong'))).status).toBe(500)

      for (let wait = 0; wait < 50 && events.length === 0; wait++)
        await Bun.sleep(10)

      expect(events.map(({ code }) => code)).toEqual(['response-schema-mismatch'])
      expect(events[0]!.error).toBeInstanceOf(KayError)
      expect(entries.flatMap(entry => entry.type === 'message' && entry.error ? [entry.error.code] : [])).toEqual(['response-schema-mismatch'])
      expect(attributes['kay.error.code']).toBe('response-schema-mismatch')
    }
    finally {
      setTracer(undefined)
      logged.mockRestore()
    }
  })
})
