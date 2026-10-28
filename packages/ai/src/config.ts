import type { Duration } from 'kay'
import type { AnthropicOptions } from './anthropic'
import type { Provider } from './types'
import process from 'node:process'
import { s } from 'kay'
import { configError, currentRequest, durationSeconds } from 'kay/library'
import { defineEnv } from 'kay/server'
import { anthropic } from './anthropic'
import { AiError } from './errors'
import { fakeAi } from './fake'
import { openai, OPENAI_URL } from './openai'

// The variables, shared by what `ai()` lists for `kay env` and what `ask` reads: `listed` marks the model as the one production needs.
export function aiEnv(listed = false) {
  return s.Object({
    ANTHROPIC_API_KEY: s.Optional(s.String({ description: 'the key of Anthropic\'s Messages API' })),
    OPENAI_API_KEY: s.Optional(s.String({ description: 'the key of OpenAI, or of an OpenAI-compatible server that wants one' })),
    AI_BASE_URL: s.Optional(s.String({ description: 'an OpenAI-compatible server\'s API root, such as http://localhost:11434/v1 for Ollama' })),
    AI_MODEL: s.Optional(s.String(listed ? { description: 'the model asked unless `ask` names one', requiredInProduction: true } : {})),
    AI_PROVIDER: s.Optional(s.String({ pattern: '^(?:anthropic|openai)$', description: 'anthropic or openai: only needed when both keys are set' })),
    AI_AUDIO_URL: s.Optional(s.String({ description: 'the API root of an OpenAI-compatible server for transcribe() and speak(), when it is not the one ask() uses' })),
    AI_AUDIO_KEY: s.Optional(s.String({ description: 'the key of the AI_AUDIO_URL server, when it wants one other than OPENAI_API_KEY' })),
    AI_TRANSCRIBE_MODEL: s.Optional(s.String({ description: 'the model transcribe() writes a recording down with, such as whisper-1' })),
    AI_SPEECH_MODEL: s.Optional(s.String({ description: 'the model speak() reads a text aloud with, such as gpt-4o-mini-tts' })),
    AI_VOICE: s.Optional(s.String({ description: 'the voice speak() reads in unless it names one' })),
    AI_EMBED_URL: s.Optional(s.String({ description: 'the API root of an OpenAI-compatible server for embed(), when it is not the one ask() uses' })),
    AI_EMBED_KEY: s.Optional(s.String({ description: 'the key of the AI_EMBED_URL server, when it wants one other than OPENAI_API_KEY' })),
    AI_EMBED_MODEL: s.Optional(s.String({ description: 'the model embed() turns texts into vectors with, such as nomic-embed-text' })),
  })
}

const READ = aiEnv()

export interface Chosen {
  provider: Provider
  model: string | undefined
}

// The provider the keys and the base URL imply, undefined when two keys leave it open.
function implied(base: string | undefined, anthropicKey: string | undefined, openaiKey: string | undefined): 'anthropic' | 'openai' | 'none' | undefined {
  if (base !== undefined)
    return 'openai'

  if (anthropicKey !== undefined && openaiKey !== undefined)
    return undefined

  if (anthropicKey !== undefined)
    return 'anthropic'

  return openaiKey === undefined ? 'none' : 'openai'
}

// The provider an ask given its own is sent to: under `bun test` the fake, answering under that provider's name and model so the code path building it is tested, unless `KAYJS_AI_REAL_PROVIDERS=1` is set, which a library's tests of a provider itself set.
export function given(provider: Provider): Provider {
  if (process.env.NODE_ENV !== 'test' || process.env.KAYJS_AI_REAL_PROVIDERS === '1' || provider === fakeAi)
    return provider

  return fakeAi.standIn(provider)
}

// The provider the environment names, and the model it asks for. Under `bun test` always the fake, a key left in a test environment never billed; in development the fake until a provider is configured.
export function choose(): Chosen {
  if (process.env.NODE_ENV === 'test')
    return { provider: fakeAi, model: fakeAi.model }

  const env = defineEnv(READ)
  const anthropicKey = env.ANTHROPIC_API_KEY
  const openaiKey = env.OPENAI_API_KEY
  const base = env.AI_BASE_URL
  const kind = env.AI_PROVIDER ?? implied(base, anthropicKey, openaiKey)

  if (kind === undefined)
    throw configError('ANTHROPIC_API_KEY and OPENAI_API_KEY are both set; set AI_PROVIDER to anthropic or openai, or unset one')

  if (kind === 'none') {
    if (process.env.NODE_ENV === 'development')
      return { provider: fakeAi, model: fakeAi.model }

    throw configError('no provider is configured; set ANTHROPIC_API_KEY, OPENAI_API_KEY, or AI_BASE_URL for an OpenAI-compatible server such as Ollama')
  }

  if (kind === 'anthropic') {
    if (anthropicKey === undefined)
      throw configError('AI_PROVIDER is anthropic and ANTHROPIC_API_KEY is not set')

    const options: AnthropicOptions = { apiKey: anthropicKey, ...base === undefined ? {} : { baseUrl: base } }

    return { provider: anthropic(options), model: env.AI_MODEL }
  }

  return { provider: openai({ baseUrl: base ?? OPENAI_URL, apiKey: openaiKey }), model: env.AI_MODEL }
}

const CALLS = {
  transcribe: { url: 'AI_AUDIO_URL', key: 'AI_AUDIO_KEY', model: 'AI_TRANSCRIBE_MODEL', what: 'speech to text' },
  speak: { url: 'AI_AUDIO_URL', key: 'AI_AUDIO_KEY', model: 'AI_SPEECH_MODEL', what: 'text to speech' },
  embed: { url: 'AI_EMBED_URL', key: 'AI_EMBED_KEY', model: 'AI_EMBED_MODEL', what: 'embeddings' },
} as const

const DEFAULT_CALL_TIMEOUT = '2m'
const MAX_TIMER_MS = 2 ** 31 - 1

export type Call = keyof typeof CALLS

export interface CallOptions {
  model?: string | undefined
  provider?: Provider | undefined
  signal?: AbortSignal | undefined
  timeout?: Duration | undefined
}

function sameOrigin(a: string, b: string): boolean {
  return URL.canParse(a) && URL.canParse(b) && new URL(a).origin === new URL(b).origin
}

// The provider a call other than an ask goes to: the server its own variable names, else the one `ask` uses when it has the call; under `bun test` the fake.
function chooseFor(call: Call): Chosen & { voice: string | undefined } {
  if (process.env.NODE_ENV === 'test')
    return { provider: fakeAi, model: fakeAi.model, voice: undefined }

  const env = defineEnv(READ)
  const { url, key, model, what } = CALLS[call]
  const root = env[url]

  // `OPENAI_API_KEY` belongs to the server `ask` uses, so it goes to another only when that server shares its origin.
  if (root !== undefined)
    return { provider: openai({ baseUrl: root, apiKey: env[key] ?? (sameOrigin(root, env.AI_BASE_URL ?? OPENAI_URL) ? env.OPENAI_API_KEY : undefined) }), model: env[model], voice: env.AI_VOICE }

  if (process.env.NODE_ENV !== 'development' && env.ANTHROPIC_API_KEY === undefined && env.OPENAI_API_KEY === undefined && env.AI_BASE_URL === undefined)
    throw configError(`no server for ${call}(); set ${url} to an OpenAI-compatible server, or OPENAI_API_KEY or AI_BASE_URL for the one ask() uses`)

  const { provider } = choose()

  if (provider[call] === undefined)
    throw configError(`${provider.name} has no ${what}; set ${url} to an OpenAI-compatible server`)

  return { provider, model: provider === fakeAi ? fakeAi.model : env[model], voice: env.AI_VOICE }
}

// What a `transcribe`, `speak` or `embed` call is sent with: the provider and its method, the model, the voice the environment names, how long it may take and what stops it.
export function setUp<C extends Call>(call: C, options: CallOptions) {
  const chosen = options.provider === undefined ? chooseFor(call) : { provider: given(options.provider), model: undefined, voice: undefined }
  const model = options.model ?? chosen.model
  const method = chosen.provider[call]

  if (model === undefined)
    throw configError(`no model for ${call}(); set ${CALLS[call].model} or pass { model }`)

  if (method === undefined)
    throw new AiError('unsupported', `${chosen.provider.name} has no ${CALLS[call].what}`)

  const timeout = Math.min(MAX_TIMER_MS, Math.ceil(durationSeconds(options.timeout ?? DEFAULT_CALL_TIMEOUT, `${call}({ timeout })`) * 1000))
  const signals = [currentRequest()?.signal, options.signal].filter(signal => signal !== undefined)

  return { send: method as NonNullable<Provider[C]>, model, voice: chosen.voice, timeout, signal: AbortSignal.any(signals) }
}
