import type { Piece, Provider } from './types'
import { AiError } from './errors'
import { json, postEvents } from './http'

export interface AnthropicOptions {
  apiKey: string
  // The API root, `https://api.anthropic.com` by default, for a proxy.
  baseUrl?: string | undefined
  model?: string | undefined
}

export const ANTHROPIC_URL = 'https://api.anthropic.com'
const VERSION = '2023-06-01'
const TRAILING_SLASHES = /\/+$/

function count(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function usageOf(value: unknown): Piece[] {
  const { input_tokens: input, output_tokens: output } = (value ?? {}) as { input_tokens?: unknown, output_tokens?: unknown }
  const inputTokens = count(input)
  const outputTokens = count(output)

  return [{ usage: { ...inputTokens === undefined ? {} : { inputTokens }, ...outputTokens === undefined ? {} : { outputTokens } } }]
}

function failureOf(event: Record<string, unknown>): AiError {
  const { type, message } = (event.error ?? {}) as { type?: unknown, message?: unknown }
  const said = typeof message === 'string' ? `: ${message.slice(0, 200)}` : ''

  if (type === 'rate_limit_error')
    return new AiError('rate-limited', `anthropic is rate limiting${said}`)

  if (type === 'authentication_error' || type === 'permission_error')
    return new AiError('auth', `anthropic refused the key${said}`)

  if (type === 'overloaded_error' || type === 'api_error' || type === 'timeout_error')
    return new AiError('unavailable', `anthropic failed mid-reply (${String(type)})${said}`)

  return new AiError('invalid', `anthropic refused the request (${String(type)})${said}`)
}

// Anthropic's Messages API.
export function anthropic({ apiKey, baseUrl = ANTHROPIC_URL, model }: AnthropicOptions): Provider {
  const root = baseUrl.replace(TRAILING_SLASHES, '')

  return {
    name: 'anthropic',
    model,
    async* stream(request, signal) {
      const body = {
        model: request.model,
        max_tokens: request.maxTokens,
        messages: request.messages,
        stream: true,
        ...request.system === undefined ? {} : { system: request.system },
        ...request.temperature === undefined ? {} : { temperature: request.temperature },
      }

      for await (const { data } of postEvents('anthropic', `${root}/v1/messages`, { 'x-api-key': apiKey, 'anthropic-version': VERSION }, body, signal)) {
        const event = json('anthropic', data)

        switch (event.type) {
          case 'message_start':
            yield* usageOf((event.message as { usage?: unknown } | undefined)?.usage)

            break
          case 'content_block_delta': {
            const delta = event.delta as { type?: unknown, text?: unknown } | undefined

            if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text !== '')
              yield { text: delta.text }

            break
          }
          case 'message_delta':
            yield* usageOf(event.usage)

            break
          case 'message_stop':
            return
          case 'error':
            throw failureOf(event)
          default:
        }
      }

      throw new AiError('cut', 'anthropic ended the stream before the reply was done')
    },
  }
}
