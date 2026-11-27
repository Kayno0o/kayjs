import type { StandardSchemaV1 } from '@kayjs/kay/server'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRooms } from '../../plugin-live/src/index'
import { createMailer, MailNotConfiguredError, resend } from '../../plugin-mail/src/index'
import { mcp, pruneEmpty } from '../../plugin-mcp/src/index'
import { action } from '../src/server/action'
import { testApp } from '../src/test/index'

const tempDirs: string[] = []

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const d of tempDirs)
    rmSync(d, { recursive: true, force: true })
})

function makeCtx(urlStr: string, init?: RequestInit, ip?: string) {
  const url = new URL(urlStr)
  const request = new Request(urlStr, init)
  return {
    request,
    url,
    params: {},
    query: url.searchParams,
    locals: {},
    ip,
    cookies: { get: () => undefined, set: () => {}, delete: () => {} },
    json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }),
    text: (body: string, status = 200) => new Response(body, { status }),
    html: (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html' } }),
    redirect: (to: string, status = 302) => Response.redirect(to, status),
  } as unknown as import('../src/server/index').RequestContext
}

describe('Cross-plugin audit part 2 (#3635): @kayjs/live, @kayjs/mail, @kayjs/mcp', () => {
  describe('@kayjs/live server', () => {
    it('does not fire onLeave when onJoin throws and restores room and client counts', () => {
      const rooms = createRooms<{ ok: boolean }, string>({ maxConnectionsPerClient: 1 })
      let leftCalls = 0

      expect(() => rooms.stream(makeCtx('http://localhost/live', undefined, '10.0.0.1'), {
        room: 'r1',
        member: 'alice',
        pingMs: 0,
        onJoin() {
          throw new Error('join failed')
        },
        onLeave() {
          leftCalls++
        },
      })).toThrow('join failed')

      expect(leftCalls).toBe(0)
      expect(rooms.size('r1')).toBe(0)

      // Client slot must have been released so the same IP can connect again
      const ac = new AbortController()
      const res = rooms.stream(makeCtx('http://localhost/live', { signal: ac.signal }, '10.0.0.1'), {
        room: 'r1',
        member: 'alice',
        pingMs: 0,
        onLeave() {
          leftCalls++
        },
      })
      expect(res.status).toBe(200)
      expect(rooms.size('r1')).toBe(1)
      ac.abort()
      expect(leftCalls).toBe(1)
      expect(rooms.size('r1')).toBe(0)
    })

    it('bounds backpressure by bytes rather than 64 chunks', () => {
      const rooms = createRooms<{ pad: string }, string>()
      let left = false
      const res = rooms.stream(makeCtx('http://localhost/live', undefined, '10.0.0.2'), {
        room: 'bytes',
        member: 'slow',
        pingMs: 0,
        onLeave() {
          left = true
        },
      })
      expect(res.status).toBe(200)
      expect(rooms.size('bytes')).toBe(1)

      // 3 chunks of 32 KiB (~96 KiB > default 64 KiB) drop a stalled consumer well before 64 chunks
      const payload = { pad: 'x'.repeat(32 * 1024) }
      rooms.publish('bytes', payload)
      rooms.publish('bytes', payload)
      rooms.publish('bytes', payload)

      expect(rooms.size('bytes')).toBe(0)
      expect(left).toBe(true)

      // Explicit byte highWaterMark keeps small queued bytes alive until exceeded
      const ac = new AbortController()
      let leftSmall = false
      rooms.stream(makeCtx('http://localhost/live', { signal: ac.signal }, '10.0.0.3'), {
        room: 'small',
        member: 'ok',
        pingMs: 0,
        highWaterMark: 200,
        onLeave() {
          leftSmall = true
        },
      })
      rooms.publish('small', { pad: 'a'.repeat(50) })
      expect(rooms.size('small')).toBe(1)
      expect(leftSmall).toBe(false)

      // Exceeding 200 bytes drops on the next publish
      rooms.publish('small', { pad: 'b'.repeat(200) })
      rooms.publish('small', { pad: 'c' })
      expect(rooms.size('small')).toBe(0)
      expect(leftSmall).toBe(true)
      ac.abort()
    })

    it('does not pool missing-ctx.ip users into one shared anonymous 10-conn bucket', () => {
      const rooms = createRooms<{ n: number }, string>({
        maxConnectionsPerClient: 10,
        maxConnectionsPerRoom: 20,
        maxTotalConnections: 20,
      })
      const controllers: AbortController[] = []
      try {
        // 15 concurrent users with missing ctx.ip all succeed (not blocked at 10)
        for (let i = 0; i < 15; i++) {
          const ac = new AbortController()
          controllers.push(ac)
          const res = rooms.stream(makeCtx('http://localhost/live', { signal: ac.signal }, undefined), {
            room: 'lobby',
            member: `u${i}`,
            pingMs: 0,
          })
          expect(res.status).toBe(200)
        }
        expect(rooms.size('lobby')).toBe(15)

        // Room/total caps still protect the server even when ctx.ip is missing
        const capped = createRooms<{ n: number }, string>({
          maxConnectionsPerClient: 1,
          maxConnectionsPerRoom: 2,
        })
        const ac1 = new AbortController()
        const ac2 = new AbortController()
        controllers.push(ac1, ac2)
        expect(capped.stream(makeCtx('http://localhost/live', { signal: ac1.signal }, undefined), { room: 'r', member: 'a', pingMs: 0 }).status).toBe(200)
        expect(capped.stream(makeCtx('http://localhost/live', { signal: ac2.signal }, undefined), { room: 'r', member: 'b', pingMs: 0 }).status).toBe(200)
        expect(capped.stream(makeCtx('http://localhost/live', undefined, undefined), { room: 'r', member: 'c', pingMs: 0 }).status).toBe(503)

        // Explicit clientKey still enforces maxConnectionsPerClient even when ctx.ip is missing
        const keyed = createRooms<{ n: number }, string>({
          maxConnectionsPerClient: 1,
          clientKey: ctx => ctx.url.searchParams.get('uid') ?? undefined,
        })
        const acKey = new AbortController()
        controllers.push(acKey)
        expect(keyed.stream(makeCtx('http://localhost/live?uid=u1', { signal: acKey.signal }, undefined), { room: 'r', member: 'a', pingMs: 0 }).status).toBe(200)
        expect(keyed.stream(makeCtx('http://localhost/live?uid=u1', undefined, undefined), { room: 'r', member: 'b', pingMs: 0 }).status).toBe(429)
      }
      finally {
        for (const ac of controllers)
          ac.abort()
      }
    })

    it('serializes undefined message payloads as valid JSON null', () => {
      const rooms = createRooms<undefined, string>()
      const chunks: string[] = []
      const decoder = new TextDecoder()
      rooms.join('r', {
        id: 's1',
        member: 'm1',
        send: c => chunks.push(decoder.decode(c)),
        close: () => {},
      })

      rooms.publish('r', undefined, 'refresh', 'evt-1')
      expect(chunks).toEqual(['id: evt-1\nevent: refresh\ndata: null\n\n'])
      const dataLine = chunks[0]!.split('\n').find(l => l.startsWith('data: '))!
      expect(JSON.parse(dataLine.slice('data: '.length))).toBeNull()
    })
  })

  describe('@kayjs/live client', () => {
    it('avoids duplicate message listeners when events includes "message" and caps retries on 401/403/404', async () => {
      const origEventSource = globalThis.EventSource
      const instances: MockES[] = []

      class MockES {
        static readonly CONNECTING = 0
        static readonly OPEN = 1
        static readonly CLOSED = 2
        readonly CONNECTING = 0
        readonly OPEN = 1
        readonly CLOSED = 2
        readyState = 0
        url: string
        onopen: (() => void) | null = null
        onerror: ((ev?: Event) => void) | null = null
        onmessage: ((ev: Event) => void) | null = null
        listeners = new Map<string, Array<(ev: Event) => void>>()
        closed = false

        constructor(url: string) {
          this.url = url
          instances.push(this)
        }

        addEventListener(type: string, fn: (ev: Event) => void) {
          const list = this.listeners.get(type) ?? []
          list.push(fn)
          this.listeners.set(type, list)
        }

        dispatch(type: string, data: string) {
          const ev = { data } as unknown as Event
          if (type === 'message')
            this.onmessage?.(ev)
          for (const fn of this.listeners.get(type) ?? [])
            fn(ev)
        }

        close() {
          this.closed = true
          this.readyState = MockES.CLOSED
        }
      }

      globalThis.EventSource = MockES as unknown as typeof EventSource
      GlobalRegistrator.register({ url: 'http://localhost/' })
      try {
        const { root: createRoot } = await import('../src/reactivity/index')
        const { useLive } = await import('../../plugin-live/src/client')

        // 1. Deduplicate "message" and repeated named events
        const received: Array<{ v: number }> = []
        let dispose1!: () => void
        createRoot((d) => {
          dispose1 = d
          useLive<{ v: number }>('/api/stream', m => received.push(m), {
            events: ['message', 'update', 'update'],
          })
        })
        await Promise.resolve()

        const es = instances[0]!
        expect(es.listeners.has('message')).toBe(false)
        expect(es.listeners.get('update')?.length).toBe(1)

        es.dispatch('message', JSON.stringify({ v: 1 }))
        es.dispatch('update', JSON.stringify({ v: 2 }))
        expect(received).toEqual([{ v: 1 }, { v: 2 }])
        dispose1()

        // 2. Terminal 401/403/404 status stops immediately with zero retries
        for (const status of [401, 403, 404]) {
          const before = instances.length
          let disposeAuth!: () => void
          let conn!: ReturnType<typeof useLive<unknown>>
          createRoot((d) => {
            disposeAuth = d
            conn = useLive('/api/protected', undefined, {
              baseDelayMs: 5,
              maxDelayMs: 10,
              jitterMs: 0,
            })
          })
          await Promise.resolve()

          const authEs = instances[before]!
          authEs.readyState = MockES.CLOSED
          authEs.onerror?.({ status } as unknown as Event)
          expect(conn.status.value).toBe('closed')

          await Bun.sleep(30)
          expect(instances.length).toBe(before + 1)
          disposeAuth()
        }

        // 3. Standard browser EventSource (no status on error event) caps consecutive CLOSED retries
        const beforeCap = instances.length
        let disposeCap!: () => void
        let capConn!: ReturnType<typeof useLive<unknown>>
        createRoot((d) => {
          disposeCap = d
          capConn = useLive('/api/not-found', undefined, {
            baseDelayMs: 5,
            maxDelayMs: 10,
            jitterMs: 0,
            maxRetries: 2,
          })
        })
        await Promise.resolve()

        // Fail initial connection + 2 retries -> 3 total instances, then stops
        for (let i = 0; i < 4; i++) {
          const cur = instances[instances.length - 1]!
          cur.readyState = MockES.CLOSED
          cur.onerror?.(new Event('error'))
          await Bun.sleep(20)
        }
        expect(instances.length - beforeCap).toBe(3)
        expect(capConn.status.value).toBe('closed')
        disposeCap()
      }
      finally {
        await GlobalRegistrator.unregister()
        globalThis.EventSource = origEventSource
      }
    })
  })

  describe('@kayjs/mail', () => {
    it('rejects CR/LF/NUL header injection and escapes display names safely', async () => {
      const delivered: Array<{ from: string, to: string[], replyTo?: string | undefined, subject: string }> = []
      const mailer = createMailer({
        transport: {
          async send(m) {
            delivered.push({ from: m.from, to: m.to, replyTo: m.replyTo, subject: m.subject })
          },
        },
      })

      // Reject CR/LF/NUL in subject, string addresses, and object address fields
      await expect(mailer.send({ subject: 'Hi\r\nBcc: evil@x.test', to: 'a@b.test' })).rejects.toBeInstanceOf(RangeError)
      await expect(mailer.send({ subject: 'Hi\nBcc: evil@x.test', to: 'a@b.test' })).rejects.toBeInstanceOf(RangeError)
      await expect(mailer.send({ subject: 'Hi\0x', to: 'a@b.test' })).rejects.toBeInstanceOf(RangeError)
      await expect(mailer.send({ subject: 'Ok', from: 'a@b.test\r\nBcc: evil@x.test', to: 'c@d.test' })).rejects.toBeInstanceOf(RangeError)
      await expect(mailer.send({ subject: 'Ok', to: 'a@b.test\nBcc: evil@x.test' })).rejects.toBeInstanceOf(RangeError)
      await expect(mailer.send({ subject: 'Ok', to: ['ok@b.test', 'bad@b.test\r\nX-Inject: 1'] })).rejects.toBeInstanceOf(RangeError)
      await expect(mailer.send({ subject: 'Ok', replyTo: { name: 'Bad\r\nName', address: 'a@b.test' }, to: 'c@d.test' })).rejects.toBeInstanceOf(RangeError)
      await expect(mailer.send({ subject: 'Ok', replyTo: { name: 'Ok', address: 'a@b.test\n' }, to: 'c@d.test' })).rejects.toBeInstanceOf(RangeError)
      await expect(mailer.send({ subject: 'Ok', to: { name: 'Ok', address: 'a@b.test>, evil@x.test <c@d.test' } })).rejects.toBeInstanceOf(RangeError)
      expect(delivered.length).toBe(0)

      // Properly escapes display names with commas, quotes, backslashes, angle brackets, and non-ASCII
      await mailer.send({
        from: { name: 'Doe, Jane', address: 'jane@example.test' },
        to: [
          { name: 'He said "hi" \\ bye', address: 'a@example.test' },
          { name: 'Spoof <evil@x.test>', address: 'real@example.test' },
          { name: 'Marie', address: 'marie@example.test' },
          { name: '   ', address: 'bare@example.test' },
        ],
        replyTo: { name: 'René', address: 'rene@example.test' },
        subject: 'Hello',
      })

      expect(delivered).toEqual([{
        from: '"Doe, Jane" <jane@example.test>',
        to: [
          '"He said \\"hi\\" \\\\ bye" <a@example.test>',
          '"Spoof <evil@x.test>" <real@example.test>',
          'Marie <marie@example.test>',
          'bare@example.test',
        ],
        replyTo: '"René" <rene@example.test>',
        subject: 'Hello',
      }])
    })

    it('aborts stalled resend() requests with AbortSignal.timeout', async () => {
      const server = Bun.serve({
        port: 0,
        async fetch() {
          await Bun.sleep(5_000)
          return new Response('{}', { status: 200 })
        },
      })

      try {
        const transport = resend({
          apiKey: 're_test_123',
          endpoint: `http://127.0.0.1:${server.port}/emails`,
          timeoutMs: 60,
        })
        const t0 = performance.now()
        await expect(transport.send({
          id: '1',
          from: 'a@b.test',
          to: ['c@d.test'],
          subject: 'Timeout test',
          sentAt: new Date().toISOString(),
        })).rejects.toThrow()
        expect(performance.now() - t0).toBeLessThan(2_000)
      }
      finally {
        server.stop(true)
      }
    })

    async function resendAgainst(answers: Array<{ status: number, retryAfter?: string }>): Promise<{ keys: Array<string | null>, sent: Promise<void> }> {
      const keys: Array<string | null> = []
      const server = Bun.serve({
        port: 0,
        fetch(req) {
          keys.push(req.headers.get('idempotency-key'))
          const answer = answers[keys.length - 1] ?? { status: 200 }
          return new Response(`answer ${keys.length}`, { status: answer.status, headers: answer.retryAfter === undefined ? {} : { 'retry-after': answer.retryAfter } })
        },
      })
      const transport = resend({ apiKey: 're_test_123', endpoint: `http://127.0.0.1:${server.port}/emails` })
      const sent = transport.send({ id: 'mail-1', from: 'a@b.test', to: ['c@d.test'], subject: 'Retry test', sentAt: new Date().toISOString() })
      return { keys, sent: sent.finally(() => server.stop(true)) }
    }

    it('retries a resend() 429 or 5xx under the same idempotency key, waiting its retry-after', async () => {
      const t0 = performance.now()
      const { keys, sent } = await resendAgainst([{ status: 429, retryAfter: '0.01' }, { status: 503, retryAfter: '0.01' }])
      await sent
      expect(keys).toEqual(['mail-1', 'mail-1', 'mail-1'])
      expect(performance.now() - t0).toBeLessThan(450)
    })

    it('waits half a second before retrying a resend() answer with no retry-after', async () => {
      const t0 = performance.now()
      const { keys, sent } = await resendAgainst([{ status: 502 }])
      await sent
      expect(keys).toHaveLength(2)
      expect(performance.now() - t0).toBeGreaterThanOrEqual(480)
    })

    it('gives up on resend() after two retries, and never retries a 4xx other than 429', async () => {
      const unavailable = await resendAgainst([{ status: 500, retryAfter: '0.05' }, { status: 500, retryAfter: '0.05' }, { status: 500, retryAfter: '0.05' }])
      await expect(unavailable.sent).rejects.toThrow('@kayjs/mail (resend): HTTP 500: answer 3')
      expect(unavailable.keys).toHaveLength(3)
      const refused = await resendAgainst([{ status: 422 }])
      await expect(refused.sent).rejects.toThrow('@kayjs/mail (resend): HTTP 422: answer 1')
      expect(refused.keys).toHaveLength(1)
    })

    it('does not silently drop mail when NODE_ENV is unset outside dev', async () => {
      const prevEnv = process.env.NODE_ENV
      const prevDev = process.env.KAY_DEV
      const prevKey = process.env.RESEND_API_KEY
      delete process.env.NODE_ENV
      delete process.env.KAY_DEV
      delete process.env.RESEND_API_KEY

      try {
        // Unset NODE_ENV outside dev must fail fast instead of silently dropping
        const strict = createMailer()
        await expect(strict.send({ subject: 'Password reset', to: 'u@example.test' })).rejects.toBeInstanceOf(MailNotConfiguredError)

        // Custom transport outside dev does not keep copies in memory outbox
        const sent: string[] = []
        const withTransport = createMailer({
          transport: {
            async send(m) {
              sent.push(m.subject)
            },
          },
        })
        await withTransport.send({ subject: 'Magic link', to: 'u@example.test' })
        expect(sent).toEqual(['Magic link'])
        expect(withTransport.outbox).toEqual([])

        // Under KAY_DEV=1 with unset NODE_ENV, dev outbox works
        process.env.KAY_DEV = '1'
        const devMailer = createMailer()
        await devMailer.send({ subject: 'Dev mail', to: 'u@example.test' })
        expect(devMailer.outbox.length).toBe(1)

        // Staging NODE_ENV outside dev also throws MailNotConfiguredError
        delete process.env.KAY_DEV
        process.env.NODE_ENV = 'staging'
        await expect(createMailer().send({ subject: 'Staging mail', to: 'u@example.test' })).rejects.toBeInstanceOf(MailNotConfiguredError)
      }
      finally {
        if (prevEnv === undefined)
          delete process.env.NODE_ENV
        else
          process.env.NODE_ENV = prevEnv
        if (prevDev === undefined)
          delete process.env.KAY_DEV
        else
          process.env.KAY_DEV = prevDev
        if (prevKey !== undefined)
          process.env.RESEND_API_KEY = prevKey
      }
    })
  })

  describe('@kayjs/mcp', () => {
    it('validates transforming action schemas only once (no double validateSchema)', async () => {
      const dir = makeTemp('kay-mcp-transform-')
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      writeFileSync(join(dir, 'src/routes/index.tsx'), 'export default function Home() { return <h1>Ok</h1> }\n')

      let actionValidateCalls = 0
      const stringToNumberSchema: StandardSchemaV1<{ raw: string }, { value: number }> = {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate(input: unknown) {
            actionValidateCalls++
            const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
            if (typeof obj.raw !== 'string' || !/^\d+$/.test(obj.raw))
              return { issues: [{ message: 'raw must be a numeric string', path: ['raw'] }] }
            return { value: { value: Number(obj.raw) } }
          },
        },
      }

      const parseAction = action(stringToNumberSchema, async (input) => {
        return { doubled: input.value * 2, typeOfValue: typeof input.value }
      })

      let refValidateCalls = 0
      const refSchema: StandardSchemaV1<{ raw: string }, { value: number }> = {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate(input: unknown) {
            refValidateCalls++
            const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
            if (typeof obj.raw !== 'string')
              return { issues: [{ message: 'raw must be a string', path: ['raw'] }] }
            return { value: { value: Number(obj.raw) } }
          },
        },
      }

      const unschemedAction = action(async (ctx) => {
        return { ok: true, method: ctx.request.method }
      })

      const key = 'transform-key'
      const app = await testApp({
        root: dir,
        plugins: [
          mcp({
            token: key,
            schemas: { refNum: refSchema },
            tools: {
              parse: { action: parseAction, description: 'Parse numeric string.' },
              refTool: { action: unschemedAction, schemaRef: 'refNum', description: 'Uses shared schema.' },
            },
          }),
        ],
      })

      const call = async (name: string, args: Record<string, unknown>) => {
        const res = await app.fetch('/mcp/tools', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'authorization': `Bearer ${key}` },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
        })
        return res.json() as Promise<{ result: { content: Array<{ text: string }>, isError?: boolean } }>
      }

      const ok = await call('parse', { raw: '21' })
      expect(ok.result.isError).toBeUndefined()
      expect(JSON.parse(ok.result.content[0]!.text)).toEqual({ doubled: 42, typeOfValue: 'number' })
      expect(actionValidateCalls).toBe(1)

      const invalid = await call('parse', { raw: 'nope' })
      expect(invalid.result.isError).toBe(true)
      expect(invalid.result.content[0]!.text).toContain('raw must be a numeric string')
      expect(actionValidateCalls).toBe(2)

      const refRes = await call('refTool', { raw: '7' })
      expect(refRes.result.isError).toBeUndefined()
      expect(refValidateCalls).toBe(1)
    })

    it('reports non-strict budget warnings via ctx.warn() instead of console.warn', async () => {
      const dir = makeTemp('kay-mcp-warn-')
      const plugin = mcp({
        token: 'k',
        budget: { maxToolBytes: 80 },
        tools: {
          big: {
            description: 'x'.repeat(120),
            handler: () => 'ok',
          },
        },
      })

      const ctxWarnings: string[] = []
      const ctxErrors: string[] = []
      const consoleWarnings: unknown[] = []
      const origWarn = console.warn
      console.warn = (...args: unknown[]) => {
        consoleWarnings.push(args)
      }
      try {
        await plugin.check?.({
          root: dir,
          routesDir: join(dir, 'src/routes'),
          error: msg => ctxErrors.push(msg),
          warn: msg => ctxWarnings.push(msg),
        })
      }
      finally {
        console.warn = origWarn
      }

      expect(ctxErrors).toEqual([])
      expect(ctxWarnings.length).toBe(1)
      expect(ctxWarnings[0]).toContain('big')
      expect(consoleWarnings).toEqual([])
    })

    it('reads token: { file } asynchronously with caching and supports live token rotation and deletion', async () => {
      const mcpSrc = readFileSync(join(import.meta.dir, '../../plugin-mcp/src/index.ts'), 'utf8')
      expect(mcpSrc).not.toContain('readFileSync')
      expect(mcpSrc).not.toContain('existsSync')

      const dir = makeTemp('kay-mcp-token-file-')
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      writeFileSync(join(dir, 'src/routes/index.tsx'), 'export default function Home() { return <h1>Ok</h1> }\n')

      const keyFile = join(dir, 'mcp.token')
      writeFileSync(keyFile, 'token-v1\n')

      const app = await testApp({
        root: dir,
        plugins: [
          mcp({
            token: { file: keyFile },
            tools: { ping: { description: 'Ping.', handler: () => 'pong' } },
          }),
        ],
      })

      const pingWith = (bearer: string) => app.fetch('/mcp/tools', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': `Bearer ${bearer}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }),
      })

      // Repeated requests with unchanged file succeed
      expect((await pingWith('token-v1')).status).toBe(200)
      expect((await pingWith('token-v1')).status).toBe(200)
      expect((await pingWith('token-v2')).status).toBe(401)

      // Rotate token on disk -> immediately honored
      writeFileSync(keyFile, 'token-v2-rotated\n')
      expect((await pingWith('token-v1')).status).toBe(401)
      expect((await pingWith('token-v2-rotated')).status).toBe(200)

      // Delete token file -> cache cleared, endpoint returns 404
      unlinkSync(keyFile)
      expect((await pingWith('token-v2-rotated')).status).toBe(404)
    })

    it('guards pruneEmpty() against circular objects and arrays while preserving shared DAG references', () => {
      // Self-referential object
      const selfObj: Record<string, unknown> = { id: 1, empty: null }
      selfObj.self = selfObj
      const prunedSelf = pruneEmpty(selfObj)
      expect(prunedSelf).toEqual({ id: 1 })
      expect(() => JSON.stringify(prunedSelf)).not.toThrow()

      // Mutually circular objects
      const a: Record<string, unknown> = { name: 'a' }
      const b: Record<string, unknown> = { name: 'b', back: a }
      a.next = b
      expect(pruneEmpty(a)).toEqual({ name: 'a', next: { name: 'b' } })

      // Circular array
      const arr: unknown[] = [1, null, 'ok']
      arr.push(arr)
      const prunedArr = pruneEmpty(arr)
      expect(prunedArr).toEqual([1, 'ok'])
      expect(() => JSON.stringify(prunedArr)).not.toThrow()

      // Shared non-circular DAG reference is preserved in both places
      const shared = { tag: 'x', skip: null }
      expect(pruneEmpty({ first: shared, second: shared })).toEqual({
        first: { tag: 'x' },
        second: { tag: 'x' },
      })
    })

    it('masks raw err.message in production while preserving mapError and dev/test visibility', async () => {
      const dir = makeTemp('kay-mcp-mask-')
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      writeFileSync(join(dir, 'src/routes/index.tsx'), 'export default function Home() { return <h1>Ok</h1> }\n')

      class PublicDomainError extends Error {}

      const makePlugin = () => mcp({
        token: 'mask-key',
        mapError: err => err instanceof PublicDomainError ? `Domain: ${err.message}` : undefined,
        resources: {
          'kay://secret/boom': {
            read() {
              throw new Error('SELECT password_hash FROM users failed at /srv/db.sqlite')
            },
          },
        },
        tools: {
          internalBoom: {
            description: 'Throws internal DB error.',
            handler() {
              throw new Error('SQLITE_ERROR: table secret_tokens locked at /var/lib/app.db')
            },
          },
          mappedBoom: {
            description: 'Throws mapped domain error.',
            handler() {
              throw new PublicDomainError('Quota reached')
            },
          },
        },
      })

      const prodApp = await testApp({
        root: dir,
        outDir: 'dist-prod',
        nodeEnv: 'production',
        dev: false,
        plugins: [makePlugin()],
      })

      const rpc = async (app: Awaited<ReturnType<typeof testApp>>, method: string, params: Record<string, unknown>) => {
        const res = await app.fetch('/mcp/tools', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'authorization': 'Bearer mask-key' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        })
        return res.json() as Promise<{ result?: { content: Array<{ text: string }>, isError?: boolean }, error?: { code: number, message: string } }>
      }

      // Production masks raw tool error message
      const prodToolErr = await rpc(prodApp, 'tools/call', { name: 'internalBoom', arguments: {} })
      expect(prodToolErr.result?.isError).toBe(true)
      expect(prodToolErr.result?.content[0]?.text).toBe('Internal error')
      expect(prodToolErr.result?.content[0]?.text).not.toContain('SQLITE_ERROR')

      // Production still allows explicit mapError output
      const prodMapped = await rpc(prodApp, 'tools/call', { name: 'mappedBoom', arguments: {} })
      expect(prodMapped.result?.isError).toBe(true)
      expect(prodMapped.result?.content[0]?.text).toBe('Domain: Quota reached')

      // Production masks raw resource read error message
      const prodResErr = await rpc(prodApp, 'resources/read', { uri: 'kay://secret/boom' })
      expect(prodResErr.error?.code).toBe(-32603)
      expect(prodResErr.error?.message).toBe('Internal error')
      expect(prodResErr.error?.message).not.toContain('password_hash')

      // Production still reports -32602 unknown tool cleanly
      const prodUnknown = await rpc(prodApp, 'tools/call', { name: 'no_such_tool', arguments: {} })
      expect(prodUnknown.error?.code).toBe(-32602)
      expect(prodUnknown.error?.message).toContain('Unknown tool: no_such_tool')

      // Dev server exposes raw err.message for debugging
      const devApp = await testApp({
        root: dir,
        outDir: 'dist-dev',
        dev: true,
        plugins: [makePlugin()],
      })
      const devToolErr = await rpc(devApp, 'tools/call', { name: 'internalBoom', arguments: {} })
      expect(devToolErr.result?.isError).toBe(true)
      expect(devToolErr.result?.content[0]?.text).toContain('SQLITE_ERROR')
    })
  })
})
