import process from 'node:process'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { AiError, anthropic, openai, speak, transcribe } from '../src'
import { aiTest } from '../src/test'

const model = aiTest()
const recording = new Blob(['not really audio'], { type: 'audio/webm;codecs=opus' })

interface Received {
  path: string
  headers: Headers
  form: FormData | undefined
  json: Record<string, unknown> | undefined
}

const received: Received[] = []
let answer: (request: Request) => Response | Promise<Response> = () => new Response(null, { status: 500 })

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const multipart = (request.headers.get('content-type') ?? '').startsWith('multipart/')

    received.push({ path: new URL(request.url).pathname, headers: request.headers, form: multipart ? await request.clone().formData() : undefined, json: multipart ? undefined : await request.clone().json() as Record<string, unknown> })

    return answer(request)
  },
})

const voices = openai({ baseUrl: `http://localhost:${server.port}/v1/`, apiKey: 'sk-test-key' })

afterEach(() => {
  received.length = 0
})

afterAll(async () => server.stop(true))

async function failure(call: Promise<unknown>): Promise<AiError> {
  try {
    await call
  }
  catch (error) {
    return error as AiError
  }

  throw new Error('the call did not fail')
}

describe('transcribe', () => {
  it('answers from the fake under bun test, keeping what it heard', async () => {
    model.transcript('Bonjour')

    expect(await transcribe(recording, { language: 'fr' })).toBe('Bonjour')
    expect(await transcribe(recording)).toBe('Fake transcript')
    expect(model.heard).toHaveLength(2)
    expect(model.heard[0]).toMatchObject({ provider: 'fake', model: 'fake', audio: recording, language: 'fr' })
  })

  it('takes the script `when` accepts, an error or a function of what was heard', async () => {
    model.transcript('in French', heard => heard.language === 'fr')
    model.transcript(new AiError('unavailable', 'whisper is down'))
    model.transcript(heard => `${heard.audio.size} bytes`)

    expect((await failure(transcribe(recording))).kind).toBe('unavailable')
    expect(await transcribe(recording, { language: 'fr' })).toBe('in French')
    expect(await transcribe(recording)).toBe(`${recording.size} bytes`)
  })

  it('posts the recording to /audio/transcriptions as OpenAI takes it and trims the text', async () => {
    answer = () => Response.json({ text: '  Hello there \n' })

    expect(await transcribe(recording, { provider: voices, model: 'whisper-1', language: 'en' })).toBe('Hello there')

    const [sent] = received

    expect(sent?.path).toBe('/v1/audio/transcriptions')
    expect(sent?.headers.get('authorization')).toBe('Bearer sk-test-key')
    expect(sent?.form?.get('model')).toBe('whisper-1')
    expect(sent?.form?.get('language')).toBe('en')
    expect(sent?.form?.get('response_format')).toBe('json')
    expect((sent?.form?.get('file') as File).name).toBe('audio.webm')
  })

  it('keeps a File\'s own name and leaves the language out when none is given', async () => {
    answer = () => new Response('plain text\n', { headers: { 'content-type': 'text/plain' } })

    expect(await transcribe(new File(['x'], 'recording.m4a', { type: 'audio/mp4' }), { provider: voices, model: 'whisper-1' })).toBe('plain text')
    expect((received[0]?.form?.get('file') as File).name).toBe('recording.m4a')
    expect(received[0]?.form?.has('language')).toBe(false)
  })

  it('fails as an ask does, the key hidden from what the server echoed', async () => {
    answer = () => Response.json({ error: { message: 'Incorrect API key sk-test-key' } }, { status: 401 })

    const error = await failure(transcribe(recording, { provider: voices, model: 'whisper-1' }))

    expect(error.kind).toBe('auth')
    expect(error.message).toContain('[key]')
    expect(error.message).not.toContain('sk-test-key')
  })

  it('fails with a timeout when the server does not answer in time', async () => {
    const { promise: never } = Promise.withResolvers<Response>()

    answer = async () => never

    expect((await failure(transcribe(recording, { provider: voices, model: 'whisper-1', timeout: '50ms' }))).kind).toBe('timeout')
  })

  it('stops when its signal aborts', async () => {
    const { promise: never } = Promise.withResolvers<Response>()
    const stop = new AbortController()

    answer = async () => never

    const call = transcribe(recording, { provider: voices, model: 'whisper-1', signal: stop.signal })

    stop.abort(new Error('left'))

    await expect(call).rejects.toThrow('left')
  })

  it('refuses a provider with no speech to text before sending anything', async () => {
    expect((await failure(transcribe(recording, { provider: anthropic({ apiKey: 'k' }), model: 'm' }))).kind).toBe('unsupported')
  })
})

describe('speak', () => {
  it('answers a silent WAV from the fake, longer for a longer text, keeping what it was given', async () => {
    const short = await speak('Hi')
    const long = await speak('Hi there, how are you today', { voice: 'alloy', speed: 1.5 })

    expect(short.type).toBe('audio/wav')
    expect(new TextDecoder().decode((await short.bytes()).slice(0, 4))).toBe('RIFF')
    expect(long.size).toBeGreaterThan(short.size)
    expect(model.spoken[1]).toMatchObject({ provider: 'fake', model: 'fake', text: 'Hi there, how are you today', voice: 'alloy', speed: 1.5 })
  })

  it('returns the audio a script gives', async () => {
    const audio = new Blob(['mp3'], { type: 'audio/mpeg' })

    model.speech(audio)

    expect(await speak('Hi')).toBe(audio)
  })

  it('posts the text to /audio/speech and types the audio by the server\'s answer', async () => {
    answer = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/wav' } })

    const audio = await speak('Read me', { provider: voices, model: 'tts-1', voice: 'nova', speed: 0.5, format: 'wav' })

    expect(audio.type).toBe('audio/wav')
    expect([...await audio.bytes()]).toEqual([1, 2, 3])
    expect(received[0]?.path).toBe('/v1/audio/speech')
    expect(received[0]?.json).toEqual({ model: 'tts-1', input: 'Read me', voice: 'nova', speed: 0.5, response_format: 'wav' })
  })

  it('types the audio by its format when the server names no audio type, and sends no voice nor speed unless given', async () => {
    answer = () => new Response(new Blob([new Uint8Array([7])]))

    const audio = await speak('Read me', { provider: voices, model: 'tts-1' })

    expect(audio.type).toBe('audio/mpeg')
    expect(received[0]?.json).toEqual({ model: 'tts-1', input: 'Read me' })
  })

  it('refuses a speed out of 0.25 to 4', async () => {
    await expect(speak('Hi', { speed: 5 })).rejects.toThrow('0.25 to 4')
  })

  describe('given its own provider', () => {
    const real = process.env.KAYJS_AI_REAL_PROVIDERS

    beforeEach(() => {
      delete process.env.KAYJS_AI_REAL_PROVIDERS
    })

    afterEach(() => {
      process.env.KAYJS_AI_REAL_PROVIDERS = real
    })

    it('is answered by the fake under bun test, recording the provider', async () => {
      await speak('Hi', { provider: voices, model: 'tts-1' })

      expect(model.spoken[0]).toMatchObject({ provider: 'openai', model: 'tts-1' })
      expect(received).toHaveLength(0)
    })

    it('is refused when the provider has no text to speech, as it would be outside tests', async () => {
      expect((await failure(speak('Hi', { provider: anthropic({ apiKey: 'k' }), model: 'm' }))).kind).toBe('unsupported')
    })
  })
})
