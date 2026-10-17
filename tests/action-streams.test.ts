import type { Action, ActionStream } from '../src/runtime'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { t } from 'elysia'
import { chromium } from 'playwright-core'
import { action, ActionRedirect, encodeCall } from '../src/runtime/action'
import { browserPath, testSite } from '../src/test'

const routes = 'tests/fixtures/action-streams/src/routes'
const site = await testSite({ routes, browser: true, mcp: true })
const mounted = await testSite({ routes, islands: false, base: '/blog', trailingSlash: 'always' })
const localized = await testSite({ routes, islands: false, i18n: { locales: ['fr', 'en'], defaultLocale: 'fr', messages: 'tests/fixtures/i18n/src/messages' } })
const fixture = join(import.meta.dir, 'fixtures/action-streams/src')
const actions = await import(join(fixture, 'routes/index.kay')) as {
  count: Action<{ to: number }, AsyncIterable<number>>
  dated: Action<Record<never, never>, AsyncIterable<{ at: Date, tags: Map<string, number> }>>
  empty: Action<Record<never, never>, AsyncIterable<never>>
  breaksEarly: Action<Record<never, never>, AsyncIterable<never>>
  breaksLate: Action<Record<never, never>, AsyncIterable<number>>
  endless: Action<Record<never, never>, AsyncIterable<number>>
  limited: Action<Record<never, never>, AsyncIterable<string>>
  baked: Action<Record<never, never>, AsyncIterable<string>>
  language: Action<Record<never, never>, AsyncIterable<string>>
  sendsAway: Action<Record<never, never>, AsyncIterable<string>>
  refuses: Action<{ full: boolean }, AsyncIterable<string>>
}
const { secret } = await import(join(fixture, 'routes/members/index.kay')) as { secret: Action<Record<never, never>, AsyncIterable<string>> }
const { seen } = await import(join(fixture, 'seen.ts')) as { seen: { started: number, stopped: number } }
const path = browserPath() ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined)

afterAll(async () => {
  await Promise.all([site.close(), mounted.close(), localized.close()])
})

// A call as an island posts it, its answer read raw.
async function posted(action: Action<never, unknown>, input?: unknown): Promise<Response> {
  const { headers, body } = encodeCall(input)

  return site.fetch(action.url, { method: 'POST', headers: { ...headers, origin: 'http://localhost' }, body })
}

// Waits for the endless stream's source to have been stopped `times` times in all.
async function stoppedTimes(times: number): Promise<void> {
  for (let tries = 0; seen.stopped < times; tries++) {
    if (tries === 200)
      throw new Error(`the endless stream stopped ${seen.stopped} times, not ${times}`)

    await Bun.sleep(10)
  }
}

describe('an action returning an async iterable', () => {
  it('streams every value to a call, which kay/test reads to its end', async () => {
    const values: number[] = await site.call(actions.count, { to: 3 })

    expect(values).toEqual([1, 2, 3])
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

  it('counts its rate limit before the first value', async () => {
    const jar = await testSite({ routes, islands: false })

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

    expect(thrown).toBeInstanceOf(ActionRedirect)
    expect((thrown as ActionRedirect).location).toBe('/done')
  })

  it('stops the iterable once the client goes away', async () => {
    const before = seen.stopped
    const response = await posted(actions.endless)
    const reader = response.body!.getReader()

    expect(new TextDecoder().decode((await reader.read()).value)).toContain('data: [0]')
    await reader.cancel()
    await stoppedTimes(before + 1)
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
})
