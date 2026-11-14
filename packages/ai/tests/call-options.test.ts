import type { Provider, Step } from '../src'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { ai, AiError, ask, describeImage, embed, fakeAi, speak, transcribe } from '../src'

const real = process.env.KAYJS_AI_REAL_PROVIDERS

beforeEach(() => {
  process.env.KAYJS_AI_REAL_PROVIDERS = '1'
  process.env.AI_TRANSCRIBE_MODEL = 'm'
  process.env.AI_SPEECH_MODEL = 'm'
  process.env.AI_EMBED_MODEL = 'm'
})

afterEach(() => {
  if (real === undefined)
    delete process.env.KAYJS_AI_REAL_PROVIDERS
  else
    process.env.KAYJS_AI_REAL_PROVIDERS = real

  delete process.env.AI_TRANSCRIBE_MODEL
  delete process.env.AI_SPEECH_MODEL
  delete process.env.AI_EMBED_MODEL
  ai()
  fakeAi.clear()
})

const FAST = { backoff: '1ms' } as const
const down = () => new AiError('unavailable', 'down', { status: 503 })
const PNG = Uint8Array.fromBase64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==')
const recording = new Blob(['audio'], { type: 'audio/webm' })

interface Seen { model: string, timeout: string, language?: string | undefined }

// A provider whose three non-chat calls fail as `fails` says, by call number, and record what they were sent.
function flaky(name: string, fails: (call: number) => Error | undefined): Provider & { seen: Seen[] } {
  const seen: Seen[] = []

  function run<T>(request: Seen, result: T): T {
    seen.push(request)

    const failure = fails(seen.length)

    if (failure)
      throw failure

    return result
  }

  return {
    name,
    model: 'm',
    seen,
    async* stream() {
      yield { text: 'x' }
    },
    transcribe: async ({ model, timeout, language }) => run({ model, timeout, language }, 'heard'),
    speak: async ({ model, timeout }) => run({ model, timeout }, new Blob(['sound'])),
    embed: async ({ model, timeout }) => run({ model, timeout }, [[1, 0]]),
  }
}

describe('every call takes the options of an ask', () => {
  it('asks again after a transient failure, for embed, transcribe and speak alike', async () => {
    const provider = flaky('flaky', call => call % 2 === 1 ? down() : undefined)

    expect(await embed('a', { provider, retry: FAST })).toEqual([1, 0])
    expect(await transcribe(recording, { provider, retry: FAST })).toBe('heard')
    expect(await speak('hi', { provider, retry: FAST })).toBeInstanceOf(Blob)
    expect(provider.seen).toHaveLength(6)
  })

  it('never retries a failure that is not transient, nor with retry false', async () => {
    const refused = flaky('refused', () => new AiError('invalid', 'no', { status: 400 }))

    await expect(embed('a', { provider: refused, retry: FAST })).rejects.toMatchObject({ kind: 'invalid' })
    expect(refused.seen).toHaveLength(1)

    const downed = flaky('downed', down)

    await expect(embed('a', { provider: downed, retry: false })).rejects.toMatchObject({ kind: 'unavailable' })
    expect(downed.seen).toHaveLength(1)
  })

  it('falls back to the next model once the first kept failing', async () => {
    const provider = flaky('fb', call => call <= 2 ? down() : undefined)

    expect(await embed('a', { provider, model: 'first', retry: FAST, fallback: [{ model: 'second' }] })).toEqual([1, 0])
    expect(provider.seen.map(({ model }) => model)).toEqual(['first', 'first', 'second'])

    const other = flaky('other', () => undefined)
    const broken = flaky('broken', down)

    expect(await transcribe(recording, { provider: broken, retry: FAST, fallback: [{ model: 'x', provider: other }] })).toBe('heard')
    expect(other.seen).toHaveLength(1)
  })

  it('tells afterStep, onError and afterRequest, a retried request included', async () => {
    const provider = flaky('hooked', call => call === 1 ? down() : undefined)
    const steps: Step[] = []
    const errors: unknown[] = []
    const done: { text: string, steps: number }[] = []

    await transcribe(recording, {
      provider,
      retry: FAST,
      afterStep: (step) => { steps.push(step) },
      onError: ({ error }) => { errors.push(error) },
      afterRequest: ({ text, steps: all }) => { done.push({ text, steps: all.length }) },
    })

    await Bun.sleep(5)
    expect(steps.map(({ failed, attempt }) => [failed, attempt])).toEqual([['unavailable', 1], [undefined, 2]])
    expect(errors).toHaveLength(1)
    expect(done).toEqual([{ text: 'heard', steps: 2 }])
  })

  it('runs the hooks of ai() for these calls too', async () => {
    const seen: string[] = []

    ai({ afterRequest: () => {
      seen.push('ai')
    } })
    await speak('hi', { provider: flaky('set', () => undefined), afterRequest: () => {
      seen.push('call')
    } })
    await Bun.sleep(5)
    expect(seen).toEqual(['ai', 'call'])
  })

  it('takes a timeout as one duration or as connect and idle, which add up for a call answered whole', async () => {
    const provider = flaky('timed', () => undefined)

    await embed('a', { provider })
    await embed('a', { provider, timeout: '10s' })
    await embed('a', { provider, timeout: { connect: '2s', idle: '3s' } })
    expect(provider.seen.map(({ timeout }) => timeout)).toEqual(['2m', '10000ms', '5000ms'])
    expect(async () => embed('a', { provider, timeout: '0s' })).toThrow('embed({ timeout })')
  })

  it('takes a single duration as the connect and idle of an ask', async () => {
    const timeouts: unknown[] = []
    const provider: Provider = {
      name: 'spy',
      model: 'm',
      async* stream(request) {
        timeouts.push(request.timeouts)
        yield { text: 'ok' }
      },
    }

    await ask('hi', { provider, timeout: '7s' })
    expect(timeouts).toEqual([{ connect: '7000ms', idle: '7000ms' }])
  })

  it('stops with the signal, before the provider is called', async () => {
    const provider = flaky('stopped', () => undefined)

    await expect(embed('a', { provider, signal: AbortSignal.abort() })).rejects.toBeDefined()
    expect(provider.seen).toHaveLength(0)
  })

  it('gives describeImage the same options, its hooks included', async () => {
    const done: string[] = []

    fakeAi.reply({ data: { alt: 'a cat' } })
    expect(await describeImage(PNG, { afterRequest: () => {
      done.push('ok')
    } })).toBe('a cat')
    await Bun.sleep(5)
    expect(done).toEqual(['ok'])
  })
})

describe('locale', () => {
  it('gives transcribe the language its provider takes from a BCP 47 tag', async () => {
    const provider = flaky('lang', () => undefined)

    await transcribe(recording, { provider, locale: 'fr-FR' })
    await transcribe(recording, { provider, locale: 'pt-br' })
    await transcribe(recording, { provider, locale: 'en' })
    await transcribe(recording, { provider })
    expect(provider.seen.map(({ language }) => language)).toEqual(['fr', 'pt', 'en', undefined])
  })

  it('still takes the deprecated language, and refuses a tag that is none', async () => {
    const provider = flaky('old', () => undefined)

    await transcribe(recording, { provider, language: 'de' })
    expect(provider.seen[0]?.language).toBe('de')
    await expect(transcribe(recording, { provider, locale: 'not a tag' })).rejects.toThrow('BCP 47')
  })

  it('names the language of a tag to the model in describeImage', async () => {
    fakeAi.reply({ data: { alt: 'un chat' } })
    await describeImage(PNG, { locale: 'pt-BR' })
    expect(fakeAi.last()?.system).toContain('Brazilian Portuguese')

    fakeAi.reply({ data: { alt: 'un chat' } })
    await describeImage(PNG, { language: 'fr' })
    expect(fakeAi.last()?.system).toContain('French')
  })
})
