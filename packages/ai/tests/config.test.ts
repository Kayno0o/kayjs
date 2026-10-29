import process from 'node:process'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { ai, anthropic, embed, fakeAi, openai, speak, transcribe } from '../src'
import { choose } from '../src/config'

const NAMES = ['NODE_ENV', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_BASE_URL', 'AI_INSECURE', 'AI_MODEL', 'AI_PROVIDER', 'AI_AUDIO_URL', 'AI_AUDIO_KEY', 'AI_TRANSCRIBE_MODEL', 'AI_SPEECH_MODEL', 'AI_VOICE', 'AI_EMBED_URL', 'AI_EMBED_KEY', 'AI_EMBED_MODEL']
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

// Like `configure` on a clean environment, for a case that must not meet what an earlier one left set.
function fresh(env: Record<string, string>) {
  for (const name of NAMES)
    delete process.env[name]

  return configure(env)
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

  it('stops AI_PROVIDER=openai without a key unless a compatible server is named', () => {
    expect(() => fresh({ NODE_ENV: 'production', AI_PROVIDER: 'openai', ANTHROPIC_API_KEY: 'a' })).toThrow('AI_PROVIDER is openai and OPENAI_API_KEY is not set')
    expect(() => fresh({ NODE_ENV: 'production', AI_PROVIDER: 'openai' })).toThrow('OPENAI_API_KEY is not set')
    expect(fresh({ NODE_ENV: 'production', AI_PROVIDER: 'openai', AI_BASE_URL: 'http://localhost:11434/v1' }).provider.name).toBe('openai')
    expect(fresh({ NODE_ENV: 'production', OPENAI_API_KEY: 'o' }).provider.name).toBe('openai')
    expect(fresh({ NODE_ENV: 'development' }).provider.name).toBe('fake')
  })
})

describe('the base URLs', () => {
  it('name the variable for a value that is not an http(s) URL', () => {
    expect(() => fresh({ NODE_ENV: 'production', AI_BASE_URL: 'localhost:11434/v1' })).toThrow('AI_BASE_URL')
    expect(() => fresh({ NODE_ENV: 'production', AI_BASE_URL: 'ftp://host/v1' })).toThrow('AI_BASE_URL must be an http or https URL')
    expect(() => fresh({ NODE_ENV: 'production', ANTHROPIC_API_KEY: 'a', AI_BASE_URL: 'proxy.example.com' })).toThrow('AI_BASE_URL')
  })

  it('take plain http for a loopback host, with or without a key', () => {
    for (const base of ['http://localhost:11434/v1', 'http://127.0.0.1', 'http://[::1]:11434/v1']) {
      expect(fresh({ NODE_ENV: 'production', AI_BASE_URL: base }).provider.name).toBe('openai')
      expect(fresh({ NODE_ENV: 'production', AI_BASE_URL: base, OPENAI_API_KEY: 'k' }).provider.name).toBe('openai')
    }
  })

  it('refuse a key over plain http elsewhere unless AI_INSECURE says the network is trusted', () => {
    const env = { NODE_ENV: 'production', AI_BASE_URL: 'http://host.docker.internal/v1', OPENAI_API_KEY: 'k' }

    expect(() => fresh(env)).toThrow('AI_INSECURE')
    expect(fresh({ ...env, AI_INSECURE: 'true' }).provider.name).toBe('openai')
    expect(fresh({ NODE_ENV: 'production', AI_BASE_URL: env.AI_BASE_URL }).provider.name).toBe('openai')
  })

  it('treat only the loopback names as loopback, whatever resembles them', () => {
    for (const base of ['http://127.evil.com', 'http://localhost.evil.com', 'http://localhost@evil.com', 'http://127.0.0.1.evil.com', 'http://localhost./v1', 'http://[::ffff:127.0.0.1]', 'http://a.localhost'])
      expect(() => fresh({ NODE_ENV: 'production', AI_BASE_URL: base, OPENAI_API_KEY: 'k' }), base).toThrow('AI_INSECURE')

    for (const base of ['http://LOCALHOST:1/v1', 'http://evil.com@localhost', 'http://127.1', 'http://[0:0:0:0:0:0:0:1]'])
      expect(fresh({ NODE_ENV: 'production', AI_BASE_URL: base, OPENAI_API_KEY: 'k' }).provider.name, base).toBe('openai')
  })

  it('check the base URL of a proxy for Anthropic, and of a provider built by hand', () => {
    expect(() => fresh({ NODE_ENV: 'production', AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'a', AI_BASE_URL: 'proxy.example.com' })).toThrow('AI_BASE_URL')
    expect(() => fresh({ NODE_ENV: 'production', AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'a', AI_BASE_URL: 'http://proxy.example.com' })).toThrow('AI_INSECURE')
    expect(() => openai({ baseUrl: 'localhost:11434', apiKey: 'k' })).toThrow('openai({ baseUrl })')
    expect(() => anthropic({ apiKey: 'k', baseUrl: 'http://proxy.example.com' })).toThrow('anthropic({ baseUrl })')
    expect(openai({ baseUrl: 'http://proxy.example.com', apiKey: 'k', insecure: true }).name).toBe('openai')
    expect(anthropic({ apiKey: 'k', baseUrl: 'http://proxy.example.com', insecure: true }).name).toBe('anthropic')
  })

  it('hold for the audio and embedding servers, and for the key an ask forwards to them', async () => {
    for (const name of NAMES)
      delete process.env[name]

    Object.assign(process.env, { NODE_ENV: 'production', AI_EMBED_URL: 'http://lan.example/v1', AI_EMBED_KEY: 'k', AI_EMBED_MODEL: 'm' })

    await expect(embed('a')).rejects.toThrow('AI_EMBED_URL is plain http')

    delete process.env.AI_EMBED_KEY
    Object.assign(process.env, { AI_AUDIO_URL: 'nonsense', AI_TRANSCRIBE_MODEL: 'w' })

    await expect(transcribe(new Blob(['x']))).rejects.toThrow('AI_AUDIO_URL is not a URL')

    Object.assign(process.env, { AI_BASE_URL: 'http://lan.example/v1', OPENAI_API_KEY: 'o', AI_AUDIO_URL: 'http://lan.example/audio' })

    await expect(transcribe(new Blob(['x']))).rejects.toThrow('AI_AUDIO_URL is plain http')
  })
})

describe('the extension', () => {
  it('lists the variables for kay env, the model required in production', () => {
    const { env } = ai()

    expect(Object.keys(env!.properties)).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_BASE_URL', 'AI_MODEL', 'AI_INSECURE', 'AI_PROVIDER', 'AI_AUDIO_URL', 'AI_AUDIO_KEY', 'AI_TRANSCRIBE_MODEL', 'AI_SPEECH_MODEL', 'AI_VOICE', 'AI_EMBED_URL', 'AI_EMBED_KEY', 'AI_EMBED_MODEL'])
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
