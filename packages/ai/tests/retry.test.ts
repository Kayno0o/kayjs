import type { Piece, Provider, Step } from '../src'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { s } from 'kay'
import { ai, AiError, ask, fakeAi, tool } from '../src'

const real = process.env.KAYJS_AI_REAL_PROVIDERS

beforeEach(() => {
  process.env.KAYJS_AI_REAL_PROVIDERS = '1'
})

afterEach(() => {
  if (real === undefined)
    delete process.env.KAYJS_AI_REAL_PROVIDERS
  else
    process.env.KAYJS_AI_REAL_PROVIDERS = real

  ai()
  fakeAi.clear()
})

const FAST = { backoff: '1ms' } as const
const down = () => new AiError('unavailable', 'down', { status: 503 })

type Behaviour = (call: number) => Piece[] | Error | { text: string, fails: Error }

// A provider answering each call as `behave` says: pieces, an error before anything, or a text and then an error.
function scripted(behave: Behaviour, name = 'scripted', model = 'm'): Provider & { calls: { model: string }[] } {
  const calls: { model: string }[] = []

  return {
    name,
    model,
    calls,
    async* stream(request): AsyncGenerator<Piece> {
      calls.push({ model: request.model })

      const outcome = behave(calls.length)

      if (outcome instanceof Error)
        throw outcome

      if (Array.isArray(outcome)) {
        yield* outcome

        return
      }

      yield { usage: { inputTokens: 1 } }
      yield { text: outcome.text }

      throw outcome.fails
    },
  }
}

// `ask` answers a thenable, not a promise, which `rejects` needs.
async function asked(...args: Parameters<typeof ask>): Promise<string> {
  return ask(...args)
}

const says = (text: string): Piece[] => [{ text }, { finish: 'stop' }]

describe('retry', () => {
  it('asks again after a failure before the first piece, and lists each request as a step', async () => {
    const provider = scripted(call => call === 1 ? down() : says('ok'))
    const errors: unknown[] = []
    const stepped: Step[] = []
    const reply = ask('hi', { provider, retry: FAST, onError: error => errors.push(error), onStep: step => stepped.push(step) })

    expect(await reply).toBe('ok')
    expect(provider.calls).toHaveLength(2)
    expect(errors).toHaveLength(1)
    expect(stepped.map(step => [step.attempt, step.failed])).toEqual([[1, 'unavailable'], [2, undefined]])
    expect((await reply.steps).map(step => step.model)).toEqual(['m', 'm'])
  })

  it('retries a rate limit, a timeout and a network failure but not a refused key or request', async () => {
    for (const kind of ['rate-limited', 'timeout', 'network'] as const) {
      const provider = scripted(call => call === 1 ? new AiError(kind, kind) : says('ok'))

      expect(await ask('hi', { provider, retry: FAST })).toBe('ok')
    }

    for (const kind of ['auth', 'invalid', 'protocol'] as const) {
      const provider = scripted(() => new AiError(kind, kind))

      await expect(asked('hi', { provider, retry: FAST })).rejects.toMatchObject({ kind })
      expect(provider.calls).toHaveLength(1)
    }
  })

  it('waits the Retry-After of a rate limit', async () => {
    const provider = scripted(call => call === 1 ? new AiError('rate-limited', 'slow', { retryAfter: 0.12 }) : says('ok'))
    const began = performance.now()

    expect(await ask('hi', { provider, retry: { backoff: '1ms', maxWait: '1s' } })).toBe('ok')
    expect(performance.now() - began).toBeGreaterThanOrEqual(110)
  })

  it('does not wait a Retry-After past maxWait, and throws it when nothing else is left to ask', async () => {
    const provider = scripted(() => new AiError('rate-limited', 'slow', { retryAfter: 60 }))
    const began = performance.now()

    await expect(asked('hi', { provider, retry: { ...FAST, maxWait: '1s' } })).rejects.toMatchObject({ kind: 'rate-limited', retryAfter: 60 })
    expect(provider.calls).toHaveLength(1)
    expect(performance.now() - began).toBeLessThan(500)
  })

  it('never waits past maxWait for a Retry-After just under it', async () => {
    const provider = scripted(call => call === 1 ? new AiError('rate-limited', 'slow', { retryAfter: 0.2 }) : says('ok'))
    // The jitter at its largest, read off the timer the retry sleeps on rather than the clock, which a loaded runner stretches.
    const random = spyOn(Math, 'random').mockReturnValue(0.999)
    const timer = spyOn(globalThis, 'setTimeout')
    let waits: number[]

    // Restoring a spy forgets its calls, so they are read first.
    try {
      expect(await ask('hi', { provider, retry: { backoff: '1ms', maxWait: '201ms' } })).toBe('ok')
    }
    finally {
      waits = timer.mock.calls.map(([, ms]) => ms ?? 0).filter(ms => ms >= 100)
      random.mockRestore()
      timer.mockRestore()
    }

    expect(waits).toHaveLength(1)
    expect(waits[0]).toBeGreaterThanOrEqual(200)
    expect(waits[0]).toBeLessThanOrEqual(201)
  })

  it('stops after attempts requests with the last error', async () => {
    const provider = scripted(() => down())

    await expect(asked('hi', { provider, retry: { ...FAST, attempts: 3 } })).rejects.toMatchObject({ kind: 'unavailable' })
    expect(provider.calls).toHaveLength(3)
  })

  it('never asks again once something streamed', async () => {
    const provider = scripted(() => ({ text: 'half', fails: down() }))

    await expect(asked('hi', { provider, retry: FAST })).rejects.toMatchObject({ kind: 'unavailable', partial: 'half' })
    expect(provider.calls).toHaveLength(1)
  })

  it('asks a real provider once more by default, and not with retry false', async () => {
    ai({ retry: { backoff: '1ms' } })

    const flaky = scripted(call => call === 1 ? down() : says('ok'))

    expect(await ask('hi', { provider: flaky })).toBe('ok')

    const off = scripted(() => down())

    await expect(asked('hi', { provider: off, retry: false })).rejects.toMatchObject({ kind: 'unavailable' })
    expect(off.calls).toHaveLength(1)
  })

  it('leaves the fake alone unless the ask names retry, so a test of an error path keeps failing', async () => {
    delete process.env.KAYJS_AI_REAL_PROVIDERS
    ai({ retry: FAST, fallback: [{ model: 'other' }] })
    fakeAi.fail(down())

    await expect(asked('hi')).rejects.toMatchObject({ kind: 'unavailable' })

    fakeAi.clear()
    fakeAi.fail(down())
    fakeAi.reply('then answered')

    expect(await ask('hi', { retry: FAST })).toBe('then answered')
  })

  it('scripts a failure then a success on the fake', async () => {
    delete process.env.KAYJS_AI_REAL_PROVIDERS
    fakeAi.fail(down())
    fakeAi.reply('back')

    const reply = ask('hi', { retry: FAST })

    expect(await reply).toBe('back')
    expect(fakeAi.asked).toHaveLength(2)
    expect((await reply.steps).map(step => step.failed)).toEqual(['unavailable', undefined])
  })

  it('stops waiting when the ask is aborted', async () => {
    const provider = scripted(() => down())
    const controller = new AbortController()
    const done = asked('hi', { provider, retry: { attempts: 3, backoff: '5s', maxWait: '10s' }, signal: controller.signal })

    setTimeout(() => controller.abort(), 30)

    expect(await done).toBe('')
    expect(provider.calls).toHaveLength(1)
  })

  it('refuses attempts and durations it cannot use', () => {
    expect(() => ai({ retry: { attempts: 0 } })).toThrow('attempts')
    expect(() => ai({ retry: { backoff: 'soon' as never } })).toThrow()
    expect(() => ask('hi', { retry: { attempts: 1.5 } })).toThrow('attempts')
    expect(() => ask('hi', { fallback: [{ model: '' }] })).toThrow('fallback')
  })
})

describe('fallback', () => {
  it('asks the next model once the first kept failing, and the step names the one that answered', async () => {
    const provider = scripted(request => request < 3 ? down() : says('from other'))
    const reply = ask('hi', { provider, retry: FAST, fallback: [{ model: 'other' }] })

    expect(await reply).toBe('from other')
    expect(provider.calls.map(call => call.model)).toEqual(['m', 'm', 'other'])

    const steps = await reply.steps

    expect(steps.map(step => [step.model, step.attempt, step.failed])).toEqual([['m', 1, 'unavailable'], ['m', 2, 'unavailable'], ['other', 3, undefined]])
  })

  it('goes to the fallback at once on a Retry-After past maxWait', async () => {
    const provider = scripted(request => request === 1 ? new AiError('rate-limited', 'slow', { retryAfter: 300 }) : says('cheap'))

    expect(await ask('hi', { provider, retry: FAST, fallback: [{ model: 'cheap' }] })).toBe('cheap')
    expect(provider.calls.map(call => call.model)).toEqual(['m', 'cheap'])
  })

  it('asks the provider of a fallback entry, and throws the last error when all fail', async () => {
    const first = scripted(() => down(), 'first')
    const second = scripted(() => new AiError('rate-limited', 'busy'), 'second', 's')

    await expect(asked('hi', { provider: first, retry: false, fallback: [{ model: 'x', provider: second }] })).rejects.toMatchObject({ kind: 'rate-limited' })
    expect(first.calls).toHaveLength(1)
    expect(second.calls.map(call => call.model)).toEqual(['x'])

    const third = scripted(() => says('ok'), 'third')

    expect(await ask('hi', { provider: scripted(() => down()), retry: false, fallback: [{ model: 'x', provider: third }] })).toBe('ok')
  })

  it('does not fall back from an error that is not about availability', async () => {
    const provider = scripted(() => new AiError('invalid', 'bad model'))

    await expect(asked('hi', { provider, fallback: [{ model: 'other' }] })).rejects.toMatchObject({ kind: 'invalid' })
    expect(provider.calls).toHaveLength(1)
  })

  it('takes the fallback of ai() and lets an ask replace it', async () => {
    ai({ retry: false, fallback: [{ model: 'backup' }] })

    const provider = scripted(request => request === 1 ? down() : says('ok'))

    expect(await ask('hi', { provider })).toBe('ok')
    expect(provider.calls.map(call => call.model)).toEqual(['m', 'backup'])

    const none = scripted(() => down())

    await expect(asked('hi', { provider: none, fallback: [] })).rejects.toMatchObject({ kind: 'unavailable' })
    expect(none.calls).toHaveLength(1)
  })

  it('retries one round of a tool loop that streamed in the round before', async () => {
    const look = tool({ name: 'look', description: 'Looks', input: s.Object({}), run: () => 'seen' })
    const provider = scripted((call) => {
      if (call === 1)
        return [{ text: 'let me look' }, { toolUse: { id: 'a', name: 'look', arguments: '{}' } }, { finish: 'stop' }]

      return call === 2 ? down() : says('done')
    })
    const reply = ask('go', { provider, tools: [look], retry: FAST })

    expect(await reply).toBe('let me look\n\ndone')
    expect((await reply.steps).map(step => step.failed)).toEqual([undefined, 'unavailable', undefined])
  })
})
