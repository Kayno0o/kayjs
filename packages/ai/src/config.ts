import type { AnthropicOptions } from './anthropic'
import type { Provider } from './types'
import process from 'node:process'
import { s } from 'kay'
import { configError } from 'kay/library'
import { defineEnv } from 'kay/server'
import { anthropic } from './anthropic'
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
