import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { answeringRequest } from '../../../src/server/log'
import { sendFrom } from '../../../src/server/rewrite'
import { ai, AiError, embed, speak, transcribe } from '../src'
import { forgetCounts } from '../src/limits'
import { aiTest } from '../src/test'

const model = aiTest()
const recording = new Blob(['not really audio'], { type: 'audio/webm' })

beforeEach(() => forgetCounts())

afterEach(() => {
  ai()
  forgetCounts()
})

function visitor(address: string): Request {
  const request = new Request('http://localhost/dictate')

  sendFrom(request, address)

  return request
}

async function inside<T>(request: Request, run: () => PromiseLike<T>): Promise<T> {
  return answeringRequest(request, async () => run())
}

async function failure(call: PromiseLike<unknown>): Promise<AiError> {
  try {
    await call
  }
  catch (error) {
    return error as AiError
  }

  throw new Error('the call did not fail')
}

describe('transcribe, speak and embed under ai({ rateLimit, budget })', () => {
  const calls: Record<string, () => Promise<unknown>> = {
    transcribe: async () => transcribe(recording),
    speak: async () => speak('Hi'),
    embed: async () => embed('Hi'),
  }

  for (const [name, call] of Object.entries(calls)) {
    it(`counts ${name} against the visitor's limit, refusing the call past it before the provider is called`, async () => {
      ai({ rateLimit: { max: 1, window: '1m' } })

      await inside(visitor('203.0.113.1'), call)

      const refused = await failure(inside(visitor('203.0.113.1'), call))

      expect(refused.kind).toBe('limited')
      expect(refused.limit).toBe('asks')
      expect(model.heard.length + model.spoken.length + model.embedded.length).toBe(1)
      await inside(visitor('203.0.113.2'), call)
    })

    it(`does not limit ${name} per visitor outside a request`, async () => {
      ai({ rateLimit: { max: 1, window: '1m' } })

      await call()
      await call()
      await call()
    })
  }

  it('counts the text of a speak against the budget, visitor and total', async () => {
    ai({ budget: { tokens: 100, total: 100, window: '1m' } })

    await inside(visitor('203.0.113.1'), async () => speak('x'.repeat(400)))

    expect((await failure(inside(visitor('203.0.113.1'), async () => embed('a')))).limit).toBe('budget')
    expect((await failure(inside(visitor('203.0.113.2'), async () => speak('x'.repeat(400))))).limit).toBe('total')
  })

  it('counts the size of a recording and the texts of an embed against the budget', async () => {
    ai({ budget: { tokens: 100, window: '1m' } })

    await inside(visitor('203.0.113.1'), async () => embed(['x'.repeat(200), 'x'.repeat(200)]))
    expect((await failure(inside(visitor('203.0.113.1'), async () => transcribe(recording)))).limit).toBe('budget')

    await inside(visitor('203.0.113.2'), async () => transcribe(new Blob([new Uint8Array(100_000)])))
    expect((await failure(inside(visitor('203.0.113.2'), async () => speak('Hi')))).limit).toBe('budget')
  })

  it('counts nothing for a call that failed', async () => {
    ai({ budget: { tokens: 100, window: '1m' } })
    model.speech(new AiError('unavailable', 'tts is down'))

    await failure(inside(visitor('203.0.113.1'), async () => speak('x'.repeat(400))))
    await inside(visitor('203.0.113.1'), async () => speak('Hi'))
  })
})

describe('the size of what is sent', () => {
  it('refuses a text past 4,096 characters to speak, a larger one with maxInputChars', async () => {
    expect((await failure(speak('x'.repeat(4097)))).kind).toBe('too-long')
    expect(model.spoken).toHaveLength(0)
    expect((await speak('x'.repeat(4096))).size).toBeGreaterThan(0)
    expect((await speak('x'.repeat(5000), { maxInputChars: 6000 })).size).toBeGreaterThan(0)
    expect((await failure(speak('Hello', { maxInputChars: 4 }))).kind).toBe('too-long')
  })

  it('refuses a recording past 10 MB to transcribe, a larger one with maxSize', async () => {
    const big = new Blob([new Uint8Array(10 * 1024 * 1024 + 1)])

    expect((await failure(transcribe(big))).kind).toBe('too-long')
    expect(model.heard).toHaveLength(0)
    expect(await transcribe(big, { maxSize: '11mb' })).toBe('Fake transcript')
    expect((await failure(transcribe(recording, { maxSize: 4 }))).kind).toBe('too-long')
  })
})
