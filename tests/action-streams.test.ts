import type { Action, ActionStream } from '../src/runtime'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { t } from 'elysia'
import { action, ActionRedirectError, encodeCall, SETTLED } from '../src/runtime/action'
import { actionStream } from '../src/runtime/action-stream'
import { browserPath, testSite } from '../src/test'

const site = await testSite({ root: 'tests/fixtures/action-streams', browser: true, mcp: true })
const mounted = await testSite({ root: 'tests/fixtures/action-streams', islands: false, base: '/blog', trailingSlash: 'always' })
const localized = await testSite({ root: 'tests/fixtures/action-streams', islands: false, i18n: { locales: ['fr', 'en'], defaultLocale: 'fr', messages: resolve('tests/fixtures/i18n/src/messages') } })
const fixture = join(import.meta.dir, 'fixtures/action-streams/src')
const actions = await import(join(fixture, 'routes/index.kay')) as {
  count: Action<{ to: number }, AsyncIterable<number>>
  dated: Action<Record<never, never>, AsyncIterable<{ at: Date, tags: Map<string, number> }>>
  thenable: Action<Record<never, never>, AsyncIterable<string>>
  empty: Action<Record<never, never>, AsyncIterable<never>>
  breaksEarly: Action<Record<never, never>, AsyncIterable<never>>
  breaksLate: Action<Record<never, never>, AsyncIterable<number>>
  endless: Action<Record<never, never>, AsyncIterable<number>>
  limited: Action<Record<never, never>, AsyncIterable<string>>
  baked: Action<Record<never, never>, AsyncIterable<string>>
  language: Action<Record<never, never>, AsyncIterable<string>>
  greets: Action<Record<never, never>, AsyncIterable<string>>
  slow: Action<Record<never, never>, AsyncIterable<string>>
  counted: Action<{ fail: boolean }, AsyncIterable<string>>
  trapped: Action<{ name: string }, AsyncIterable<string>>
  pretending: Action<{ name: string }, AsyncIterable<string>>
  sendsAway: Action<Record<never, never>, AsyncIterable<string>>
  refuses: Action<{ full: boolean }, AsyncIterable<string>>
  libraryLimited: Action<Record<never, never>, AsyncIterable<string>>
  libraryWorded: Action<Record<never, never>, AsyncIterable<string>>
  libraryBroken: Action<{ refusal: unknown }, AsyncIterable<string>>
  libraryForbidden: Action<Record<never, never>, AsyncIterable<string>>
}
const { secret } = await import(join(fixture, 'routes/members/index.kay')) as { secret: Action<Record<never, never>, AsyncIterable<string>> }
const { seen } = await import(join(fixture, 'seen.ts')) as { seen: { started: number, stopped: number, slowStopped: number, quietStopped: number, pages: { slow: number, await: number, slowServed: number }, slowGate: PromiseWithResolvers<void> } }
const path = browserPath()

afterAll(async () => {
  await Promise.all([site.close(), mounted.close(), localized.close()])
})

// A call as an island posts it, its answer read raw.
async function posted(action: Action<never, unknown>, input?: unknown): Promise<Response> {
  const { headers, body } = encodeCall(input)

  return site.fetch(action.url, { method: 'POST', headers: { ...headers, origin: 'http://localhost' }, body })
}

// Waits for the endless stream's source, or another `seen` counts, to have been stopped `times` times in all.
async function stoppedTimes(times: number, counter: 'stopped' | 'slowStopped' | 'quietStopped' = 'stopped'): Promise<void> {
  for (let tries = 0; seen[counter] < times; tries++) {
    if (tries === 200)
      throw new Error(`the stream stopped ${seen[counter]} times, not ${times}`)

    await Bun.sleep(10)
  }
}

// Waits for the `/kept/slow` and `/kept/await` pages to have been requested, or the slow one answered, `pages` times in all.
async function pagesServed(pages: Partial<typeof seen.pages>): Promise<void> {
  for (let tries = 0; Object.entries(pages).some(([name, times]) => seen.pages[name as keyof typeof seen.pages] < times); tries++) {
    if (tries === 1000)
      throw new Error(`the pages were requested ${JSON.stringify(seen.pages)}, not ${JSON.stringify(pages)}`)

    await Bun.sleep(10)
  }
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData()

  for (const [name, value] of Object.entries(fields))
    data.append(name, value)

  return data
}

describe('an action returning an async iterable', () => {
  it('streams every value to a call, which kay/test reads to its end', async () => {
    const values: number[] = await site.call(actions.count, { to: 3 })

    expect(values).toEqual([1, 2, 3])
  })

  it('streams a return that is also a thenable as the iterable it is, typed as one', async () => {
    const values: string[] = await site.call(actions.thenable)

    expect(values).toEqual(['one', 'one two'])
  })

  it('types a call as a stream of its values, and what a plain form post reads back as the last one', () => {
    const typed = action(t.Object({ to: t.Number() }), async function* ({ to }) {
      yield to
    })
    const answer = async (): Promise<ActionStream<number>> => typed({ to: 1 })
    const last = (): number | undefined => typed.succeeded()?.data
    // @ts-expect-error each value is a number
    const wrong = async (): Promise<ActionStream<string>> => typed({ to: 1 })

    expect([answer, last, wrong].every(read => typeof read === 'function')).toBe(true)
  })

  it('types a call as a stream when the handler returns an iterable that is also a thenable, as a model\'s reply is', () => {
    const reply = { then: (resolve: (text: string) => void) => void resolve('whole'), async* [Symbol.asyncIterator]() {
      yield 'part'
    } }
    const typed = action(() => reply)
    const answer = async (): Promise<ActionStream<string>> => typed()
    // @ts-expect-error the call is a stream, not the text the thenable resolves to
    const wrong = async (): Promise<string> => typed()

    expect([answer, wrong].every(read => typeof read === 'function')).toBe(true)
  })

  it('answers a call as server-sent events', async () => {
    const response = await posted(actions.count, { to: 1 })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toStartWith('text/event-stream')
    expect(await response.text()).toContain('event: end')
  })

  it('carries values devalue encodes', async () => {
    const [value] = await site.call(actions.dated)

    expect(value?.at).toEqual(new Date(0))
    expect(value?.tags).toEqual(new Map([['a', 1]]))
  })

  it('ends with no values for an empty iterable', async () => {
    expect(await site.call(actions.empty)).toEqual([])
  })

  it('answers an iterable throwing before its first value as a handler throwing', async () => {
    const refusal = await site.refusal(actions.breaksEarly, {})

    expect(refusal.status).toBe(500)
    expect(refusal.errors['']).toBe('Something went wrong on our side; try again later')
  })

  it('ends the stream as failed when the iterable throws after its first value', async () => {
    await expect(site.call(actions.breaksLate)).rejects.toThrow('failed')

    const response = await posted(actions.breaksLate)
    const text = await response.text()

    expect(text).toContain('data: ')
    expect(text).toContain('event: error')
  })

  it('validates the input before the first value', async () => {
    const refusal = await site.refusal(actions.count, { to: 9 })

    expect(refusal.status).toBe(422)
    expect(refusal.errors.to).toBe('Too many')
  })

  it('answers ctx.fail as for any action, or the stream the handler returned instead', async () => {
    const refusal = await site.refusal(actions.refuses, { full: true })

    expect(refusal.status).toBe(409)
    expect(refusal.errors['']).toBe('Full')
    expect(await site.call(actions.refuses, { full: false })).toEqual(['room'])
  })

  it('answers an error carrying a refusal from a library with its status, Retry-After and words, the action\'s own rate limit wording winning', async () => {
    const plain = await posted(actions.libraryLimited)
    const worded = await posted(actions.libraryWorded)

    expect(plain.status).toBe(429)
    expect(plain.headers.get('retry-after')).toBe('42')
    expect(await plain.text()).toContain('Slow down')
    expect(worded.status).toBe(429)
    expect(worded.headers.get('retry-after')).toBe('42')
    expect(await worded.text()).toContain('Back in 42 s')
  })

  it('answers a malformed refusal as a server error, and keeps a bad Retry-After off the header', async () => {
    for (const refusal of [{ status: 200, message: 'ok' }, { status: Number.NaN, message: 'x' }, { status: '429', message: 'x' }, { status: 429 }, { status: 429, message: 5 }, 'text', 7, null, []])
      expect((await posted(actions.libraryBroken, { refusal })).status).toBe(500)

    for (const retryAfter of [-3, 1.5, Number.NaN, '5', null]) {
      const answered = await posted(actions.libraryBroken, { refusal: { status: 429, retryAfter, message: 'Wait' } })

      expect(answered.status).toBe(429)
      expect(answered.headers.get('retry-after')).toBeNull()
    }
  })

  it('leaves the wording of a refusal that is no 429 to the library, its status and Retry-After kept', async () => {
    const answered = await posted(actions.libraryForbidden)

    expect(answered.status).toBe(403)
    expect(answered.headers.get('retry-after')).toBe('7')
    expect(await answered.text()).toContain('Not you')
  })

  it('counts its rate limit before the first value', async () => {
    const jar = await testSite({ root: 'tests/fixtures/action-streams', islands: false })

    expect(await jar.call(actions.limited)).toEqual(['ok'])
    expect((await jar.refusal(actions.limited, {})).status).toBe(429)
    await jar.close()
  })

  it('runs its guards before the first value', async () => {
    expect((await site.refusal(secret, {})).status).toBe(401)
    expect(await site.call(secret, {}, { headers: { 'x-member': 'yes' } })).toEqual(['secret'])
  })

  it('refuses another site\'s post before the handler runs', async () => {
    expect((await site.refusal(actions.count, { to: 1 }, { headers: { origin: 'https://elsewhere.example' } })).status).toBe(403)
  })

  it('sends the cookies the handler set before its first value', async () => {
    expect(await site.call(actions.baked)).toEqual(['baked'])
    expect(site.cookies.get('baked')).toBe('yes')
  })

  it('redirects when the handler does before its first value', async () => {
    let thrown: unknown

    try {
      await site.call(actions.sendsAway)
    }
    catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ActionRedirectError)
    expect((thrown as ActionRedirectError).location).toBe('/done')
  })

  it('stops the iterable once the client goes away', async () => {
    const before = seen.stopped
    const response = await posted(actions.endless)
    const reader = response.body!.getReader()

    expect(new TextDecoder().decode((await reader.read()).value)).toContain('data: [0]')
    await reader.cancel()
    await stoppedTimes(before + 1)
  })

  it('stops the iterable when the client goes away before its first value', async () => {
    const before = seen.slowStopped
    const leaving = new AbortController()
    const { headers, body } = encodeCall(undefined)
    const response = site.fetch(actions.slow.url, { method: 'POST', headers: { ...headers, origin: 'http://localhost' }, body, signal: leaving.signal })

    await Bun.sleep(10)
    leaving.abort()

    try {
      await response
    }
    catch {}

    await stoppedTimes(before + 1, 'slowStopped')
  })

  it('stops the iterable a plain form post drains once the browser goes away', async () => {
    const before = seen.stopped
    const leaving = new AbortController()
    const response = site.fetch(actions.endless.url, { method: 'POST', headers: { origin: 'http://localhost' }, body: new FormData(), signal: leaving.signal })

    await Bun.sleep(30)
    leaving.abort()

    try {
      await response
    }
    catch {}

    await stoppedTimes(before + 1)
  })

  it('sends each value as it comes when compressed, and stops once the client goes away', async () => {
    const compressed = await testSite({ root: 'tests/fixtures/action-streams', islands: false, compress: true })
    const before = seen.stopped
    const { headers, body } = encodeCall(undefined)
    const response = await compressed.fetch(actions.endless.url, { method: 'POST', headers: { ...headers, 'origin': 'http://localhost', 'accept-encoding': 'gzip' }, body })

    expect(response.headers.get('content-encoding')).toBe('gzip')

    const reader = response.body!.pipeThrough(new DecompressionStream('gzip')).getReader()
    const decoder = new TextDecoder()
    let received = ''

    while (!received.includes('data: [2]'))
      received += decoder.decode((await reader.read()).value, { stream: true })

    await reader.cancel()
    await stoppedTimes(before + 1)
    await compressed.close()
  })

  it('counts a succeeded-only rate limit once the first value is there', async () => {
    const limited = await testSite({ root: 'tests/fixtures/action-streams', islands: false })

    expect((await limited.refusal(actions.counted, { fail: true })).status).toBe(500)
    expect((await limited.refusal(actions.counted, { fail: true })).status).toBe(500)
    expect(await limited.call(actions.counted, { fail: false })).toEqual(['ok'])
    expect((await limited.refusal(actions.counted, { fail: false })).status).toBe(429)
    await limited.close()
  })

  it('refuses a bot the honeypot caught before the first value, or answers it with nothing when pretending', async () => {
    await expect(site.call(actions.trapped, form({ name: 'a', website: 'spam' }) as never)).rejects.toMatchObject({ status: 422, errors: { website: 'Leave this field empty' } })
    expect(await site.call(actions.trapped, form({ name: 'a' }) as never)).toEqual(['a'])
    expect(await site.call(actions.pretending, form({ name: 'a', website: 'spam' }) as never)).toBeUndefined()
  })

  it('gives a plain form post the last value', async () => {
    const { status, html } = await site.submit(actions.count, { to: '2' }, { from: '/' })

    expect(status).toBe(200)
    expect(html).toContain('<p class="done">Last: 2</p>')
  })

  it('gives an agent calling it as a tool the last value', async () => {
    const result = await site.mcp.call('count', { to: 2 })

    expect(result).toMatchObject({ isError: false, text: '2' })
  })

  it('streams under a base path with trailing slashes', async () => {
    expect(await mounted.call(actions.count, { to: 2 }, { from: '/blog/' })).toEqual([1, 2])
  })

  it('runs in the locale of the page it was called from', async () => {
    expect(await localized.call(actions.language, {}, { from: '/en/' })).toEqual(['en'])
    expect(await localized.call(actions.language, {}, { from: '/' })).toEqual(['fr'])
  })

  it('keeps the locale for the values read after the answer went out', async () => {
    const { headers, body } = encodeCall(undefined)

    using server = Bun.serve({ port: 0, fetch: async request => localized.handle(request) })
    const response = await fetch(new URL(actions.greets.url, server.url), { method: 'POST', headers: { ...headers, origin: server.url.origin, referer: new URL('/en/', server.url).href }, body })

    // Over a server and read late, so the values after the first are pulled by its reads rather than where the answer was made.
    await Bun.sleep(30)

    expect(await response.text()).toContain('data: ["Home"]')
  })
})

describe('the stream an island reads', () => {
  // An answer whose body sends `text` and stays open, telling whether it was cancelled.
  function answer(text: string): { response: Response, cancelled: () => boolean } {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start: controller => controller.enqueue(new TextEncoder().encode(text)),
      cancel: () => {
        cancelled = true
      },
    })

    return { response: new Response(body), cancelled: () => cancelled }
  }

  it('fails and stops the answer when a value does not decode', async () => {
    const { response, cancelled } = answer('data: [0]\n\ndata: {broken\n\n')
    const stream = actionStream<number>(response, SETTLED)
    const status = await new Promise(resolve => stream[SETTLED](resolve))

    expect(status).toBe('failed')
    expect(stream.last()).toBe(0)
    expect(cancelled()).toBe(true)
  })

  it('reads an answer a proxy rewrote with CRLF line breaks', async () => {
    const { response } = answer('data: [1]\r\n\r\nevent: end\r\ndata:\r\n\r\n')
    const stream = actionStream<number>(response, SETTLED)
    const status = await new Promise(resolve => stream[SETTLED](resolve))

    expect(status).toBe('done')
    expect(stream.last()).toBe(1)
  })
})

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('an island calling a streaming action', () => {
  it('reads each value as it comes, pending until the stream ends', async () => {
    const page = await site.open('/', { path })

    await page.click('button.start')
    await page.waitFor('p.status', { text: 'done' })

    expect(await page.text('p.last')).toBe('3')
    expect(await page.text('p.pending')).toBe('false')
    expect(page.errors).toEqual([])
  })

  it('stops the handler\'s iterable when the island closes the stream', async () => {
    const page = await site.open('/', { path })
    const before = seen.stopped

    await page.click('button.forever')
    await page.waitFor('p.status', { text: 'open' })
    await page.click('button.stop')
    await page.waitFor('p.status', { text: 'closed' })
    await stoppedTimes(before + 1)

    expect(await page.text('p.pending')).toBe('false')
  })

  it('closes a quiet stream a handler started once the visitor goes to another page', async () => {
    const page = await site.open('/', { path })
    const before = seen.quietStopped

    await page.click('button.quiet')
    await page.waitFor('p.status', { text: 'open' })
    await page.click('a.away')
    await page.waitFor('h1', { text: 'Elsewhere' })
    await stoppedTimes(before + 1, 'quietStopped')

    expect(page.errors).toEqual([])
  })

  // A `persist` island survives the swap, so a stream it started stays open with it and closes when a page without it takes its place.
  const origins = { click: 'click handler', setup: 'setup', window: '`listen` callback' }

  for (const [mode, starts] of [['click', 'button.begin'], ['setup', undefined], ['window', undefined]] as const) {
    it(`keeps a stream a persist island started from its ${origins[mode]} open across a page swap, closing it once the island goes`, async () => {
      const page = await site.open(`/kept/${mode}`, { path })
      const before = seen.quietStopped

      if (mode === 'window')
        await page.press('a')
      else if (starts)
        await page.click(starts)

      await page.waitFor('p.status', { text: 'open' })
      await page.click('a.next')
      await page.waitFor('h1', { text: 'Kept next' })
      await Bun.sleep(150)

      expect(seen.quietStopped).toBe(before)
      expect(await page.text('p.status')).toBe('open')

      await page.click('a.bare')
      await page.waitFor('h1', { text: 'Kept bare' })
      await stoppedTimes(before + 1, 'quietStopped')

      expect(page.errors).toEqual([])
    })
  }

  // The call's own result removes the block its button sits in, which must not end the stream the call answered with.
  const removed = { if: 'an `if`', for: 'a `for` row', match: 'a `match` arm', nested: 'an `if` in an `if`', await: 'an `await` block\'s `then`' }

  for (const mode of ['if', 'nested', 'for', 'match', 'await'] as const) {
    it(`keeps a stream open when its result removes the block holding ${removed[mode]} that called it, closing it with the page`, async () => {
      const page = await site.open(`/flip-${mode}`, { path })
      const before = seen.quietStopped

      await page.click('button.begin')
      await page.waitFor('p.status', { text: 'open' })
      await page.waitFor('button.begin', { gone: true })
      await Bun.sleep(150)

      expect(seen.quietStopped).toBe(before)
      expect(await page.text('p.status')).toBe('open')

      await page.click('a.away')
      await page.waitFor('h1', { text: 'Elsewhere' })
      await stoppedTimes(before + 1, 'quietStopped')

      expect(page.errors).toEqual([])
    })
  }

  it('keeps a stream no island owns open when the swap that began is superseded, closing it once a page is shown', async () => {
    const page = await site.open('/kept/await', { path })
    const before = seen.quietStopped

    await page.click('button.begin')
    await page.waitFor('p.status', { text: 'open' })
    // The slow page is held until this page has been asked for again, so the visitor's second click always supersedes the first however loaded the host is.
    const { slow, await: self, slowServed } = seen.pages

    await page.click('a.slow')
    await pagesServed({ slow: slow + 1 })
    await page.click('a.self')
    await pagesServed({ await: self + 1 })
    seen.slowGate.resolve()
    await pagesServed({ slowServed: slowServed + 1 })
    // Two frames, for the superseded response to have been handled.
    await page.evaluate(async () => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))

    expect(await page.path()).toBe('/kept/await')
    expect(seen.quietStopped).toBe(before)
    expect(await page.text('p.status')).toBe('open')

    await page.click('a.bare')
    await page.waitFor('h1', { text: 'Kept bare' })
    await stoppedTimes(before + 1, 'quietStopped')

    expect(page.errors).toEqual([])
  })
})
