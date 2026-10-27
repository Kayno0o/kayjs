import type { RateStore } from 'kay'
import type { AskOptions, Provider } from '../src'
import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { nameUser } from 'kay/library'
import { memoryRates } from 'kay/server'
import { answeringRequest } from '../../../src/server/log'
import { protectionRefusal } from '../../../src/server/protection'
import { sendFrom } from '../../../src/server/rewrite'
import { ai, ask, fakeAi } from '../src'
import { forgetKept } from '../src/kept'
import { untilHolds } from './until'

afterEach(() => {
  ai()
  fakeAi.clear()
  forgetKept()
})

const id = 'reply-0001'
const slow: Provider = {
  name: 'slow',
  model: 'm',
  async* stream(_request, signal) {
    yield { text: 'one ' }
    await new Promise(resolve => signal.addEventListener('abort', resolve))
  },
}
const quick: Provider = {
  name: 'quick',
  model: 'm',
  async* stream() {
    yield { text: 'done' }
    yield { finish: 'stop' }
  },
}
const KEY = '/_kay/action/chat\n203.0.113.1'

function actionOf(limit: unknown, url = '/_kay/action/chat') {
  return { url, protection: { rateLimit: limit } } as never
}

// What kay does with a call to the action: the refusal check counts it, then the handler runs as the request being answered.
async function call<Answer>(action: never, header: string | undefined, handler: () => Promise<Answer>, visitor = 'ann'): Promise<{ refused: number | undefined, text: Answer | undefined }> {
  const request = new Request('http://localhost/_kay/action/chat', { headers: header === undefined ? {} : { 'x-kai-reply': header } })

  sendFrom(request, '203.0.113.1')
  nameUser(request, () => visitor)

  const refusal = await protectionRefusal(action, request, { body: {}, form: false, server: null, plain: false })

  if (refusal !== undefined && typeof refusal === 'object' && 'status' in refusal)
    return { refused: refusal.status, text: undefined }

  return { refused: undefined, text: await answeringRequest(request, handler) }
}

// The reply itself is handed back unread, as awaiting an outliving one would wait for it to end.
// The attempt is given back once the owner of the kept reply is known, a moment after the call answered.
async function counts(store: { peek: (key: string) => { count: number } | undefined }, key: string, count: number) {
  await untilHolds(() => store.peek(key)?.count === count, 1000)
  expect(store.peek(key)?.count).toBe(count)
}

const asking = (options: AskOptions) => async () => ({ reply: ask('x', options) })

// A reply kept for ann at the action, as the start call of a Chat leaves it.
async function started(action: never) {
  expect((await call(action, `start:${id}`, asking({ provider: slow, outlive: true }))).refused).toBeUndefined()
}

describe('a resume or stop against the action\'s rateLimit', () => {
  it('finds its reply past the limit, as a reload does, without spending an attempt', async () => {
    const store = memoryRates()
    const action = actionOf({ max: 2, window: '1m', store })

    await started(action)

    for (let reload = 0; reload < 3; reload++) {
      expect((await call(action, `resume:${id}`, asking({ provider: slow, outlive: true }))).refused).toBeUndefined()
      // The start counted once, and each resume gives its own back.
      await counts(store, KEY, 1)
    }

    expect((await call(action, undefined, asking({ provider: quick }))).refused).toBeUndefined()
    expect((await call(action, undefined, asking({ provider: quick }))).refused).toBe(429)
  })

  it('gives the attempt back for a stop that ends its reply too', async () => {
    const store = memoryRates()
    const action = actionOf({ max: 2, window: '1m', store })

    await started(action)

    for (let stops = 0; stops < 3; stops++) {
      expect((await call(action, `stop:${id}`, asking({ provider: slow }))).refused).toBeUndefined()
      await counts(store, KEY, 1)
    }
  })

  it('gives back at most three attempts per kept reply, resumes and stops together, then counts the rest', async () => {
    const store = memoryRates()
    const action = actionOf({ max: 50, window: '1m', store })

    await started(action)

    for (const header of [`resume:${id}`, `stop:${id}`, `resume:${id}`]) {
      await call(action, header, asking({ provider: slow, outlive: true }))
      await counts(store, KEY, 1)
    }

    for (const [index, header] of [`resume:${id}`, `stop:${id}`, `resume:${id}`].entries()) {
      await call(action, header, asking({ provider: slow, outlive: true }))
      await counts(store, KEY, 2 + index)
    }
  })

  it('gives back no more than the cap to resumes made together', async () => {
    const store = memoryRates()
    const action = actionOf({ max: 50, window: '1m', store })

    await started(action)
    await Promise.all(Array.from({ length: 10 }, async () => call(action, `resume:${id}`, asking({ provider: slow, outlive: true }))))
    await counts(store, KEY, 1 + 10 - 3)
    await Bun.sleep(20)
    expect(store.peek(KEY)?.count).toBe(8)
  })

  it('leaves an ordinary ask and a start counted', async () => {
    const action = actionOf({ max: 2, window: '1m', store: memoryRates() })

    expect((await call(action, undefined, asking({ provider: quick }))).refused).toBeUndefined()
    expect((await call(action, `start:${id}`, asking({ provider: quick }))).refused).toBeUndefined()
    expect((await call(action, undefined, asking({ provider: quick }))).refused).toBe(429)
  })

  it('leaves a forged header on an action that asks nothing counted', async () => {
    const action = actionOf({ max: 2, window: '1m', store: memoryRates() })
    const login = async () => ({ reply: 'wrong password' })

    for (let attempt = 0; attempt < 2; attempt++)
      expect((await call(action, `resume:${id}`, login)).refused).toBeUndefined()

    expect((await call(action, `resume:${id}`, login)).refused).toBe(429)
  })

  it('leaves a resume that finds nothing, or another visitor\'s reply, counted', async () => {
    const store = memoryRates()
    const action = actionOf({ max: 3, window: '1m', store })

    await started(action)
    expect((await call(action, 'resume:nothing-0001', asking({ provider: slow }))).refused).toBeUndefined()
    expect(store.peek(KEY)?.count).toBe(2)
    // Ann's reply, asked for by bob: counted, so ids cannot be probed for free.
    expect((await call(action, `resume:${id}`, asking({ provider: slow }), 'bob')).refused).toBeUndefined()
    expect(store.peek(KEY)?.count).toBe(3)
  })

  it('leaves the reply of another action counted', async () => {
    const store = memoryRates()
    const other = actionOf({ max: 3, window: '1m', store }, '/_kay/action/other')

    await started(actionOf({ max: 3, window: '1m', store: memoryRates() }))
    expect((await call(other, `resume:${id}`, asking({ provider: slow }))).refused).toBeUndefined()
    expect(store.peek('/_kay/action/other\n203.0.113.1')?.count).toBe(1)
  })

  it('gives back every counted limit of the action and leaves one counting the posts that went through alone', async () => {
    const first = memoryRates()
    const second = memoryRates()
    const succeeded = memoryRates()
    const action = actionOf([{ max: 5, window: '1m', store: first }, { max: 5, window: '1m', store: second }, { max: 5, window: '1m', count: 'succeeded', store: succeeded }])

    await started(action)
    expect(first.peek(KEY)?.count).toBe(1)
    expect(second.peek('/_kay/action/chat#1\n203.0.113.1')?.count).toBe(1)

    await call(action, `resume:${id}`, asking({ provider: slow, outlive: true }))
    await counts(first, KEY, 1)
    await counts(second, '/_kay/action/chat#1\n203.0.113.1', 1)
    expect(succeeded.peek('/_kay/action/chat#2\n203.0.113.1')).toBeUndefined()
  })

  it('gives back once however many asks the action makes', async () => {
    const store = memoryRates()
    const action = actionOf({ max: 9, window: '1m', store })
    const twice = async () => ({ first: ask('a', { provider: slow, outlive: true }), second: ask('b', { provider: slow, outlive: true }) })

    await call(action, `start:${id}`, twice)
    await call(action, `start:${id}-2`, twice)
    expect(store.peek(KEY)?.count).toBe(2)
    await call(action, `resume:${id}`, twice)
    await counts(store, KEY, 2)
    await Bun.sleep(20)
    expect(store.peek(KEY)?.count).toBe(2)
  })

  it('keeps a burst of parallel resumes capped: the refused ones stay counted, the others give theirs back', async () => {
    const store = memoryRates()
    const action = actionOf({ max: 3, window: '1m', store })

    await started(action)

    const results = await Promise.all(Array.from({ length: 8 }, async () => call(action, `resume:${id}`, asking({ provider: slow, outlive: true }))))
    const refused = results.filter(result => result.refused === 429).length

    // The check runs before the handler, so the burst meets the limit as it always did.
    expect(refused).toBeGreaterThan(0)
    const passed = results.length - refused

    // Only the first refunds of the reply are given back, so a burst cannot replay the action for free.
    await counts(store, KEY, 1 + refused + Math.max(0, passed - 3))
  })

  it('keeps a store with no refund counting, and throws nothing', async () => {
    const counts = new Map<string, number>()
    const legacy: RateStore = {
      hit(key) {
        counts.set(key, (counts.get(key) ?? 0) + 1)

        return { count: counts.get(key)!, resetAt: Date.now() + 60_000 }
      },
    }
    const action = actionOf({ max: 2, window: '1m', store: legacy })

    await started(action)
    expect((await call(action, `resume:${id}`, asking({ provider: slow, outlive: true }))).refused).toBeUndefined()
    expect((await call(action, `resume:${id}`, asking({ provider: slow, outlive: true }))).refused).toBe(429)
  })

  it('logs and goes on when the store fails to take the attempt back', async () => {
    const memory = memoryRates()
    const failing: RateStore = {
      hit: (key, window, weight) => memory.hit(key, window, weight),
      refund() {
        throw new Error('store down')
      },
    }
    const action = actionOf({ max: 5, window: '1m', store: failing })
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      await started(action)

      const { text } = await call(action, `resume:${id}`, asking({ provider: slow, outlive: true }))

      expect(await text!.reply.stream()[Symbol.asyncIterator]().next()).toMatchObject({ value: 'one ' })
      expect(warn).toHaveBeenCalled()
    }
    finally {
      warn.mockRestore()
    }
  })
})
