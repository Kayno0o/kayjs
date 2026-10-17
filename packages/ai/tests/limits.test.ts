import type { Piece, Provider } from '../src'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { nameUser } from 'kay/library'
import { memoryRates, sqliteRates } from 'kay/server'
import { answeringRequest } from '../../../src/server/log'
import { sendFrom } from '../../../src/server/rewrite'
import { ai, AiError, ask, fakeAi } from '../src'
import { forgetCounts, storeTimeout } from '../src/limits'

const REFUSED = Symbol.for('kay.refused')

beforeEach(() => forgetCounts())

afterEach(() => {
  ai()
  forgetCounts()
  storeTimeout(5000)
  fakeAi.clear()
})

// The fake reports 1 input token for a short prompt and one output token per 4 characters of the reply.
function usedBy(tokens: number): string {
  return 'x'.repeat(tokens * 4)
}

async function failure(reply: PromiseLike<unknown>): Promise<AiError> {
  try {
    await reply
  }
  catch (error) {
    expect(error).toBeInstanceOf(AiError)

    return error as AiError
  }

  throw new Error('the reply was not refused')
}

// A request from this address, or from the user named in `x-user`.
function rewrittenRequest(address: string, headers: Record<string, string> = {}): Request {
  const request = new Request('http://localhost/chat', { headers })

  sendFrom(request, address)

  return request
}

// A memory store remembering the keys it counted under.
function tracking() {
  const base = memoryRates()
  const keys = new Set<string>()

  return {
    keys,
    hit: (key: string, windowMs: number, weight?: number) => {
      keys.add(key)

      return base.hit(key, windowMs, weight)
    },
    peek: base.peek,
    count: () => base.peek([...keys][0]!)?.count,
  }
}

// A provider saying exactly these pieces, then failing with `error` when given one.
function saying(pieces: Piece[], error?: Error): Provider {
  return {
    name: 'scripted',
    model: 'm',
    async* stream() {
      yield* pieces

      if (error)
        throw error
    },
  }
}

// Runs `run` as the request being answered.
async function inside<T>(request: Request, run: () => PromiseLike<T>): Promise<T> {
  return answeringRequest(request, async () => run())
}

describe('ai({ limit })', () => {
  it('refuses the ask past max with a limited error that waits for the window, before the provider is called', async () => {
    ai({ limit: { max: 2, window: '1m' } })
    await ask('a', { visitor: 'v' })
    await ask('b', { visitor: 'v' })

    const refused = await failure(ask('c', { visitor: 'v' }))

    expect(refused.kind).toBe('limited')
    expect(refused.limit).toBe('asks')
    expect(refused.retryAfter).toBeGreaterThan(0)
    expect(refused.retryAfter).toBeLessThanOrEqual(60)
    expect(fakeAi.asked).toHaveLength(2)
  })

  it('counts each visitor on its own', async () => {
    ai({ limit: { max: 1, window: '1m' } })
    await ask('a', { visitor: 'one' })
    await ask('a', { visitor: 'two' })
    expect((await failure(ask('b', { visitor: 'one' }))).kind).toBe('limited')
    expect((await failure(ask('b', { visitor: 'two' }))).kind).toBe('limited')
  })

  it('counts the signed-in user the visitor hook names, else the address, and lets neither stand for the other', async () => {
    ai({ limit: { max: 1, window: '1m' }, visitor: request => request.headers.get('x-user') ?? undefined })

    const asUser = (user: string, address: string) => rewrittenRequest(address, { 'x-user': user })

    // One user from two addresses is one visitor.
    await inside(asUser('ann', '203.0.113.1'), () => ask('a'))
    expect((await failure(inside(asUser('ann', '203.0.113.2'), () => ask('b')))).limit).toBe('asks')
    // Another user behind the first address is another visitor.
    await inside(asUser('bob', '203.0.113.1'), () => ask('a'))
    // Without a user, the address counts.
    await inside(rewrittenRequest('203.0.113.1'), () => ask('a'))
    expect((await failure(inside(rewrittenRequest('203.0.113.1'), () => ask('b')))).limit).toBe('asks')
    // A user called like an address does not take that address's window.
    await inside(asUser('203.0.113.9', '203.0.113.1'), () => ask('a'))
    await inside(rewrittenRequest('203.0.113.9'), () => ask('a'))
  })

  it('counts the user a library names to kay with no visitor option, and lets the visitor option override it', async () => {
    ai({ limit: { max: 1, window: '1m' } })

    const named = (user: string | undefined, address: string) => {
      const request = rewrittenRequest(address)

      nameUser(request, () => user)

      return request
    }

    await inside(named('ann', '203.0.113.1'), () => ask('a'))
    expect((await failure(inside(named('ann', '203.0.113.2'), () => ask('b')))).limit).toBe('asks')
    await inside(named('bob', '203.0.113.1'), () => ask('a'))
    // Nobody signed in: the address counts.
    await inside(named(undefined, '203.0.113.5'), () => ask('a'))
    expect((await failure(inside(named(undefined, '203.0.113.5'), () => ask('b')))).limit).toBe('asks')

    ai({ limit: { max: 1, window: '1m' }, visitor: () => 'mine' })
    await inside(named('cat', '203.0.113.7'), () => ask('a'))
    expect((await failure(inside(named('dan', '203.0.113.8'), () => ask('b')))).limit).toBe('asks')
  })

  it('does not run the visitor hook for an ask that names its visitor', async () => {
    ai({ limit: { max: 1, window: '1m' }, visitor: () => {
      throw new Error('hook ran')
    } })
    await inside(rewrittenRequest('203.0.113.1'), () => ask('a', { visitor: 'named' }))
  })

  it('lets a visitor hook answer later, and a call name the visitor over it', async () => {
    ai({ limit: { max: 1, window: '1m' }, visitor: async () => 'late' })
    await inside(rewrittenRequest('203.0.113.1'), () => ask('a'))
    expect((await failure(inside(rewrittenRequest('203.0.113.2'), () => ask('b')))).limit).toBe('asks')
    await inside(rewrittenRequest('203.0.113.2'), () => ask('b', { visitor: 'named' }))
  })

  it('counts every address of one IPv6 /64 as one', async () => {
    ai({ limit: { max: 1, window: '1m' } })
    await inside(rewrittenRequest('2001:db8:1:2::1'), () => ask('a'))
    expect((await failure(inside(rewrittenRequest('2001:db8:1:2:ffff::9'), () => ask('b')))).kind).toBe('limited')
  })

  it('counts the asks started together exactly', async () => {
    ai({ limit: { max: 3, window: '1m' } })

    const results = await Promise.allSettled(Array.from({ length: 10 }, async (_, index) => ask(`q${index}`, { visitor: 'v' })))

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(3)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(7)
    expect(fakeAi.asked).toHaveLength(3)
  })

  it('counts nothing for a reply that is never read', async () => {
    ai({ limit: { max: 1, window: '1m' } })
    ask('unread', { visitor: 'v' })
    await ask('read', { visitor: 'v' })
  })

  it('skips the visitor limit with no request and no visitor, as in a job', async () => {
    ai({ limit: { max: 1, window: '1m' } })
    await ask('a')
    await ask('b')
    await ask('c')
  })

  it('opens a fresh window once the last closed', async () => {
    ai({ limit: { max: 1, window: 1 } })
    await ask('a', { visitor: 'v' })
    expect((await failure(ask('b', { visitor: 'v' }))).kind).toBe('limited')
    await Bun.sleep(1100)
    await ask('c', { visitor: 'v' })
  })

  it('refuses a limit that is not a whole number of at least 1, or a window it cannot read', () => {
    expect(() => ai({ limit: { max: 0, window: '1m' } })).toThrow('max')
    expect(() => ai({ limit: { max: 1.5, window: '1m' } })).toThrow('max')
    expect(() => ai({ limit: { max: 1, window: 'soon' as '1m' } })).toThrow('window')
  })
})

describe('ai({ budget })', () => {
  it('refuses the next ask once the visitor\'s replies used the budget, for that visitor alone', async () => {
    ai({ budget: { tokens: 12, window: '1m' } })
    // Each reply is 1 input token and 10 output ones: 11 of 12, so one more ask goes through.
    fakeAi.reply(usedBy(10))
    await ask('a', { visitor: 'v' })
    fakeAi.reply(usedBy(10))
    await ask('a', { visitor: 'v' })

    const refused = await failure(ask('a', { visitor: 'v' }))

    expect(refused.kind).toBe('limited')
    expect(refused.limit).toBe('budget')
    expect(refused.retryAfter).toBeGreaterThan(0)
    expect(fakeAi.asked).toHaveLength(2)
    await ask('a', { visitor: 'other' })
  })

  it('lets the reply that overruns the budget mid-stream finish, and counts all of it', async () => {
    ai({ budget: { tokens: 5, window: '1m' } })
    fakeAi.reply(usedBy(40))
    expect(await ask('a', { visitor: 'v' })).toBe(usedBy(40))
    expect((await failure(ask('a', { visitor: 'v' }))).limit).toBe('budget')
  })

  it('caps the tokens of all visitors with total, a job included', async () => {
    ai({ budget: { tokens: 1000, total: 20, window: '1m' } })
    fakeAi.reply(usedBy(25))
    await ask('a', { visitor: 'one' })
    expect((await failure(ask('a', { visitor: 'two' }))).limit).toBe('total')
    expect((await failure(ask('a'))).limit).toBe('total')
  })

  it('counts a job against the total alone', async () => {
    ai({ budget: { tokens: 5, total: 100, window: '1m' } })
    fakeAi.reply(usedBy(30))
    await ask('a')
    await ask('b', { visitor: 'v' })
  })

  it('holds what a running reply may use, so asks started together are refused past the budget rather than all passing', async () => {
    const store = tracking()
    const count = 8

    ai({ budget: { tokens: 20, window: '1m', store } })

    for (let index = 0; index < count; index++)
      fakeAi.reply(usedBy(10))

    const results = await Promise.allSettled(Array.from({ length: count }, async (_, index) => ask(`q${index}`, { visitor: 'v' })))

    // The first holds its worst case (its input and maxTokens), so every other is refused while it runs.
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(count - 1)
    expect(store.count()).toBe(11)
  })

  it('holds the worst case of a reply per visitor and in total, and lets it go when the reply ends, fails or is stopped', async () => {
    ai({ budget: { tokens: 10_000, total: 10_000, window: '1m' } })

    const open = { name: 's', model: 'm', async* stream(_: unknown, signal: AbortSignal) {
      yield { text: 'a' }
      await new Promise(resolve => signal.addEventListener('abort', resolve))
    } }
    // Each holds 4096 + 1 tokens of the 10,000: the third finds 8,194 held and passes, the fourth finds 12,291 and is refused.
    const running = Array.from({ length: 3 }, () => ask('x', { visitor: 'v', provider: open }))
    const readers = running.map(reply => reply[Symbol.asyncIterator]())

    await Promise.all(readers.map(async reader => reader.next()))

    const refused = await failure(ask('x', { visitor: 'v' }))

    expect(refused.limit).toBe('budget')
    // Another visitor holds nothing, and meets the total.
    expect((await failure(ask('x', { visitor: 'w' }))).limit).toBe('total')

    for (const reply of running)
      reply.stop()

    await Promise.all(running)
    await ask('x', { visitor: 'v' })
    await ask('x', { visitor: 'w' })
  })

  it('lets a failing reply release what it held', async () => {
    ai({ budget: { tokens: 5000, window: '1m' } })
    await failure(ask('x', { visitor: 'v', provider: saying([], new AiError('unavailable', 'down')) }))
    await ask('x', { visitor: 'v' })
  })

  it('lets a burst through up to the limit when the budget has room for what they hold', async () => {
    ai({ limit: { max: 3, window: '1m' }, budget: { tokens: 100_000, window: '1m' } })

    for (let index = 0; index < 10; index++)
      fakeAi.reply(usedBy(10))

    const results = await Promise.allSettled(Array.from({ length: 10 }, async (_, index) => ask(`q${index}`, { visitor: 'v' })))

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(3)
  })

  it('counts the input and output tokens the provider reported', async () => {
    const store = tracking()

    ai({ budget: { tokens: 1000, window: '1m', store } })
    await ask('a', { visitor: 'v', provider: saying([{ text: 'hi' }, { usage: { inputTokens: 30, outputTokens: 12 } }, { finish: 'stop' }]) })
    expect(store.count()).toBe(42)
  })

  it('counts an estimate of what was read when a reply fails after some text and the provider reported no usage', async () => {
    const store = tracking()

    ai({ budget: { tokens: 1000, window: '1m', store } })
    await failure(ask('abcd'.repeat(5), { visitor: 'v', provider: saying([{ text: usedBy(6) }], new AiError('cut', 'cut')) }))
    // 5 tokens of prompt, 6 of reply.
    expect(store.count()).toBe(11)
  })

  it('counts nothing for a reply that failed before any text and any usage', async () => {
    const store = tracking()

    ai({ budget: { tokens: 1000, window: '1m', store } })
    await failure(ask('a', { visitor: 'v', provider: saying([], new AiError('unavailable', 'down')) }))
    expect(store.keys.size).toBe(0)
  })

  it('counts a reply the visitor stopped halfway for what was received', async () => {
    const store = tracking()

    ai({ budget: { tokens: 1000, window: '1m', store } })

    const reply = ask('abcd', { visitor: 'v', provider: { name: 's', model: 'm', async* stream(_, signal) {
      yield { usage: { inputTokens: 7 } }
      yield { text: usedBy(3) }
      await new Promise(resolve => signal.addEventListener('abort', resolve))
    } } })
    const reading = reply[Symbol.asyncIterator]()

    await reading.next()
    reply.stop()
    await reply
    // The provider's input count was known, the output one not: the text received stands for it.
    expect(store.count()).toBe(10)
  })

  it('counts the input of a reply stopped before the provider said anything, which it may already be reading', async () => {
    const store = tracking()

    ai({ budget: { tokens: 1000, window: '1m', store } })

    const reply = ask('abcd'.repeat(25), { visitor: 'v', provider: { name: 's', model: 'm', async* stream(_, signal) {
      await new Promise(resolve => signal.addEventListener('abort', resolve))
      yield* []
    } } })
    const reading = reply[Symbol.asyncIterator]()
    const first = reading.next()

    await Bun.sleep(10)
    reply.stop()
    await first
    expect(store.count()).toBe(25)
  })

  it('asks nothing and counts nothing for a reply stopped before it began', async () => {
    const store = tracking()

    ai({ budget: { tokens: 1000, window: '1m', store } })

    const controller = new AbortController()

    controller.abort()
    await ask('a', { visitor: 'v', signal: controller.signal })
    expect(store.keys.size).toBe(0)
    expect(fakeAi.asked).toEqual([])
  })

  it('opens a fresh window once the last closed', async () => {
    ai({ budget: { tokens: 3, window: 1 } })
    fakeAi.reply(usedBy(10))
    await ask('a', { visitor: 'v' })
    expect((await failure(ask('a', { visitor: 'v' }))).limit).toBe('budget')
    await Bun.sleep(1100)
    await ask('a', { visitor: 'v' })
  })

  it('counts a reply ending after its window rolled over in the new window', async () => {
    const store = tracking()

    ai({ budget: { tokens: 1000, window: 1, store } })

    const reply = ask('a', { visitor: 'v', provider: { name: 's', model: 'm', async* stream() {
      yield { text: 'start' }
      await Bun.sleep(1100)
      yield { usage: { inputTokens: 4, outputTokens: 6 } }
    } } })

    await reply
    expect(store.count()).toBe(10)
  })

  it('needs a store that can peek', () => {
    expect(() => ai({ budget: { tokens: 1, window: '1m', store: { hit: () => ({ count: 1, resetAt: 0 }) } } })).toThrow('peek')
  })

  it('refuses a budget that is not a whole number of at least 1', () => {
    expect(() => ai({ budget: { tokens: 0, window: '1m' } })).toThrow('tokens')
    expect(() => ai({ budget: { tokens: 10, total: 0.5, window: '1m' } })).toThrow('total')
  })
})

describe('when the store fails', () => {
  const broken = {
    hit: () => {
      throw new Error('disk full')
    },
    peek: () => {
      throw new Error('disk full')
    },
  }

  it('refuses the ask on a limit store that fails, rather than let a public chat run without it', async () => {
    ai({ limit: { max: 5, window: '1m', store: broken } })

    const refused = await failure(ask('a', { visitor: 'v' }))

    expect(refused.kind).toBe('unavailable')
    expect(refused.cause).toBeInstanceOf(Error)
    expect(fakeAi.asked).toEqual([])
  })

  it('refuses on a budget store that fails to read', async () => {
    ai({ budget: { tokens: 5, window: '1m', store: broken } })
    expect((await failure(ask('a', { visitor: 'v' }))).kind).toBe('unavailable')
    expect(fakeAi.asked).toEqual([])
  })

  it('refuses the ask when the store hangs, rather than hang the chat', async () => {
    const hanging = { hit: async () => new Promise<never>(() => undefined), peek: async () => new Promise<never>(() => undefined) }

    storeTimeout(30)
    ai({ limit: { max: 5, window: '1m', store: hanging } })

    const refused = await failure(ask('a', { visitor: 'v' }))

    expect(refused.kind).toBe('unavailable')
    expect(refused.message).toContain('did not answer')

    ai({ budget: { tokens: 5, window: '1m', store: hanging } })
    expect((await failure(ask('a', { visitor: 'v' }))).kind).toBe('unavailable')
  })

  it('ends the reply when the store hangs as the tokens are counted', async () => {
    const hanging = { hit: async () => new Promise<never>(() => undefined), peek: () => undefined }

    storeTimeout(30)
    ai({ budget: { tokens: 5000, window: '1m', store: hanging } })
    fakeAi.reply('fine')
    expect(await ask('a', { visitor: 'v' })).toBe('fine')
  })

  it('shares one store between the limit and the budget without mixing their counts', async () => {
    const store = tracking()

    ai({ limit: { max: 1, window: '1m', store }, budget: { tokens: 1000, window: '1m', store } })
    await ask('a', { visitor: 'v' })
    expect((await failure(ask('b', { visitor: 'v' }))).limit).toBe('asks')
    expect(store.keys.size).toBe(2)
  })

  it('logs a store that adds one to the count whatever the weight, rather than fail the reply', async () => {
    const ignoring = { hit: () => ({ count: 1, resetAt: Date.now() + 1000 }), peek: () => undefined }

    ai({ budget: { tokens: 1000, window: '1m', store: ignoring } })
    fakeAi.reply(usedBy(10))
    expect(await ask('a', { visitor: 'v' })).toBe(usedBy(10))
  })

  it('keeps the reply when the store fails only as the tokens are counted', async () => {
    const flaky = {
      peek: () => undefined,
      hit: () => {
        throw new Error('gone')
      },
    }

    ai({ budget: { tokens: 50, window: '1m', store: flaky } })
    fakeAi.reply('fine')
    expect(await ask('a', { visitor: 'v' })).toBe('fine')
  })

  it('refuses when the store answers something that is no window', async () => {
    const odd = { peek: () => ({ count: Number.NaN, resetAt: 0 }), hit: () => ({ count: 1, resetAt: 0 }) }

    ai({ budget: { tokens: 50, window: '1m', store: odd } })
    expect((await failure(ask('a', { visitor: 'v' }))).kind).toBe('unavailable')
  })
})

describe('the store', () => {
  it('can be sqliteRates, which keeps the count over a restart', async () => {
    const path = join(tmpdir(), `kayjs-ai-${crypto.randomUUID()}.sqlite`)

    try {
      ai({ budget: { tokens: 5, window: '1m', store: sqliteRates(path) } })
      fakeAi.reply(usedBy(20))
      await ask('a', { visitor: 'v' })

      // Another process opens the same file.
      ai({ budget: { tokens: 5, window: '1m', store: sqliteRates(path) } })
      expect((await failure(ask('a', { visitor: 'v' }))).limit).toBe('budget')
    }
    finally {
      rmSync(path, { force: true })
    }
  })
})

describe('the error', () => {
  it('carries the kay refusal an action answers 429 with Retry-After from', async () => {
    ai({ limit: { max: 1, window: '1m' } })
    await ask('a', { visitor: 'v' })

    const refused = await failure(ask('b', { visitor: 'v' }))
    const refusal = (refused as unknown as Record<symbol, { status: number, retryAfter: number, message: string }>)[REFUSED]

    expect(refusal?.status).toBe(429)
    expect(refusal?.retryAfter).toBe(refused.retryAfter)
    expect(refusal?.message).toContain(String(refused.retryAfter))
  })

  it('carries no refusal when it is no limit', () => {
    expect((new AiError('network', 'down') as unknown as Record<symbol, unknown>)[REFUSED]).toBeUndefined()
  })
})

describe('ai() with nothing set', () => {
  it('limits nothing, and drops a limit the config no longer names', async () => {
    ai({ limit: { max: 1, window: '1m' } })
    ai()
    await ask('a', { visitor: 'v' })
    await ask('b', { visitor: 'v' })
  })
})
