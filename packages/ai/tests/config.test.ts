import process from 'node:process'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { ai, embed, fakeAi, speak, transcribe } from '../src'
import { choose } from '../src/config'

const NAMES = ['NODE_ENV', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_BASE_URL', 'AI_MODEL', 'AI_PROVIDER', 'AI_AUDIO_URL', 'AI_AUDIO_KEY', 'AI_TRANSCRIBE_MODEL', 'AI_SPEECH_MODEL', 'AI_VOICE', 'AI_EMBED_URL', 'AI_EMBED_KEY', 'AI_EMBED_MODEL']
const saved = Object.fromEntries(NAMES.map(name => [name, process.env[name]]))

beforeEach(() => {
  for (const name of NAMES)
    delete process.env[name]
})

afterEach(() => {
  for (const name of NAMES) {
    if (saved[name] === undefined)
      delete process.env[name]
    else
      process.env[name] = saved[name]
  }
})

function configure(env: Record<string, string>) {
  Object.assign(process.env, env)

  return choose()
}

describe('the provider the environment names', () => {
  it('is the fake under bun test, whatever keys are set', () => {
    expect(configure({ NODE_ENV: 'test', ANTHROPIC_API_KEY: 'k', AI_BASE_URL: 'http://x' }).provider.name).toBe('fake')
  })

  it('is the fake in development until something is configured', () => {
    expect(configure({ NODE_ENV: 'development' }).provider.name).toBe('fake')
    expect(choose().provider.name).toBe('fake')
    process.env.OPENAI_API_KEY = 'k'
    expect(choose().provider.name).toBe('openai')
  })

  it('is Anthropic for its key, OpenAI for its own, and an OpenAI-compatible server for a base URL', () => {
    expect(configure({ NODE_ENV: 'production', ANTHROPIC_API_KEY: 'k', AI_MODEL: 'claude-x' })).toMatchObject({ provider: { name: 'anthropic' }, model: 'claude-x' })
    delete process.env.ANTHROPIC_API_KEY
    expect(configure({ OPENAI_API_KEY: 'k' }).provider.name).toBe('openai')
    expect(configure({ AI_BASE_URL: 'http://localhost:11434/v1' }).provider.name).toBe('openai')
  })

  it('wants AI_PROVIDER to choose between two keys, and honours it', () => {
    expect(() => configure({ NODE_ENV: 'production', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' })).toThrow('AI_PROVIDER')
    expect(configure({ AI_PROVIDER: 'anthropic' }).provider.name).toBe('anthropic')
    expect(configure({ AI_PROVIDER: 'openai' }).provider.name).toBe('openai')
    expect(() => configure({ AI_PROVIDER: 'nonsense' })).toThrow('AI_PROVIDER')
  })

  it('stops a production server with nothing configured, naming the variables', () => {
    expect(() => configure({ NODE_ENV: 'production' })).toThrow('ANTHROPIC_API_KEY, OPENAI_API_KEY, or AI_BASE_URL')
  })

  it('stops AI_PROVIDER=anthropic without its key', () => {
    expect(() => configure({ NODE_ENV: 'production', AI_PROVIDER: 'anthropic', OPENAI_API_KEY: 'o' })).toThrow('ANTHROPIC_API_KEY is not set')
  })
})

describe('the extension', () => {
  it('lists the variables for kay env, the model required in production', () => {
    const { env } = ai()

    expect(Object.keys(env!.properties)).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_BASE_URL', 'AI_MODEL', 'AI_PROVIDER', 'AI_AUDIO_URL', 'AI_AUDIO_KEY', 'AI_TRANSCRIBE_MODEL', 'AI_SPEECH_MODEL', 'AI_VOICE', 'AI_EMBED_URL', 'AI_EMBED_KEY', 'AI_EMBED_MODEL'])
    expect(env!.properties.AI_MODEL).toMatchObject({ requiredInProduction: true })
    expect(env!.properties.ANTHROPIC_API_KEY).not.toMatchObject({ requiredInProduction: true })
  })
})

describe('the server of transcribe, speak and embed', () => {
  const seen: { path: string, authorization: string | null, body: string }[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname

      seen.push({ path, authorization: request.headers.get('authorization'), body: await request.text() })

      if (path.endsWith('/embeddings'))
        return Response.json({ data: [{ index: 0, embedding: [1, 0] }] })

      if (path.endsWith('/speech'))
        return new Response(new Uint8Array([1]), { headers: { 'content-type': 'audio/mpeg' } })

      return Response.json({ text: 'heard' })
    },
  })
  const root = `http://localhost:${server.port}/v1`
  const recording = new Blob(['x'], { type: 'audio/webm' })

  afterEach(() => {
    seen.length = 0
    fakeAi.clear()
  })

  afterAll(async () => server.stop(true))

  it('is the one its own variable names, with its own key', async () => {
    Object.assign(process.env, { NODE_ENV: 'production', AI_AUDIO_URL: root, AI_AUDIO_KEY: 'audio-key', OPENAI_API_KEY: 'openai-key', AI_TRANSCRIBE_MODEL: 'whisper-1' })

    expect(await transcribe(recording)).toBe('heard')
    expect(seen[0]).toMatchObject({ path: '/v1/audio/transcriptions', authorization: 'Bearer audio-key' })
  })

  it('never gets OPENAI_API_KEY at another origin than the server ask uses', async () => {
    Object.assign(process.env, { NODE_ENV: 'production', AI_EMBED_URL: root, OPENAI_API_KEY: 'openai-key', AI_EMBED_MODEL: 'nomic-embed-text' })

    await embed('a')

    expect(seen[0]?.authorization).toBeNull()

    process.env.AI_BASE_URL = `http://localhost:${server.port}/other`
    await embed('a')

    expect(seen[1]?.authorization).toBe('Bearer openai-key')
  })

  it('falls back to the OpenAI-compatible server ask uses, with the model and the voice from the environment', async () => {
    Object.assign(process.env, { NODE_ENV: 'production', AI_BASE_URL: root, AI_SPEECH_MODEL: 'tts-1', AI_VOICE: 'nova' })

    expect((await speak('Hi')).type).toBe('audio/mpeg')
    expect(seen[0]?.path).toBe('/v1/audio/speech')
    expect(JSON.parse(seen[0]!.body)).toEqual({ model: 'tts-1', input: 'Hi', voice: 'nova' })
  })

  it('names what to set: the server, a server for Anthropic, the model', async () => {
    process.env.NODE_ENV = 'production'

    await expect(transcribe(recording)).rejects.toThrow('set AI_AUDIO_URL')

    process.env.ANTHROPIC_API_KEY = 'k'

    await expect(embed('a')).rejects.toThrow('anthropic has no embeddings; set AI_EMBED_URL')

    process.env.AI_AUDIO_URL = root

    await expect(speak('Hi')).rejects.toThrow('set AI_SPEECH_MODEL')
  })

  it('is the fake in development until a server is configured', async () => {
    process.env.NODE_ENV = 'development'

    expect(await embed('a', { dimensions: 4 })).toHaveLength(4)
    expect(fakeAi.embedded[0]?.provider).toBe('fake')
    expect(seen).toHaveLength(0)
  })
})
