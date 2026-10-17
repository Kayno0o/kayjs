import type { Piece, Provider } from './types'
import { AiError } from './errors'
import { json, postEvents } from './http'

export interface OpenAiOptions {
  // The server's API root, `https://api.openai.com/v1` by default; Ollama is `http://localhost:11434/v1`.
  baseUrl?: string | undefined
  // Sent as a bearer token; a local server wanting none leaves it out.
  apiKey?: string | undefined
  model?: string | undefined
}

export const OPENAI_URL = 'https://api.openai.com/v1'
const TRAILING_SLASHES = /\/+$/

function usageOf(value: unknown): Piece[] {
  if (typeof value !== 'object' || value === null)
    return []

  const { prompt_tokens: input, completion_tokens: output } = value as { prompt_tokens?: unknown, completion_tokens?: unknown }

  return [{ usage: { ...typeof input === 'number' ? { inputTokens: input } : {}, ...typeof output === 'number' ? { outputTokens: output } : {} } }]
}

// An OpenAI chat completions server: OpenAI itself, Ollama, and the many that speak its API.
export function openai({ baseUrl = OPENAI_URL, apiKey, model }: OpenAiOptions = {}): Provider {
  const root = baseUrl.replace(TRAILING_SLASHES, '')
  const official = root === OPENAI_URL

  return {
    name: 'openai',
    model,
    async* stream(request, signal) {
      const messages = [...request.system === undefined ? [] : [{ role: 'system', content: request.system }], ...request.messages]
      const body = {
        model: request.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        // OpenAI's reasoning models refuse the older name, and the servers imitating it know no other.
        [official ? 'max_completion_tokens' : 'max_tokens']: request.maxTokens,
        ...request.temperature === undefined ? {} : { temperature: request.temperature },
      }
      let finished = false

      for await (const { data } of postEvents('openai', `${root}/chat/completions`, apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }, body, signal)) {
        if (data === '[DONE]')
          return

        const chunk = json('openai', data)
        const failure = chunk.error as { message?: unknown } | undefined

        if (failure !== undefined && failure !== null)
          throw new AiError('unavailable', `openai failed mid-reply${typeof failure.message === 'string' ? `: ${failure.message.slice(0, 200)}` : ''}`)

        const choice = (chunk.choices as { delta?: { content?: unknown }, finish_reason?: unknown }[] | undefined)?.[0]
        const text = choice?.delta?.content

        if (typeof text === 'string' && text !== '')
          yield { text }

        if (typeof choice?.finish_reason === 'string')
          finished = true

        yield* usageOf(chunk.usage)
      }

      if (!finished)
        throw new AiError('cut', 'openai ended the stream before the reply was done')
    },
  }
}
