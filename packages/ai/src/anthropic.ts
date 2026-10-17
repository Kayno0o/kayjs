import type { Finish, Piece, Provider, ProviderMessage } from './types'
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

const FINISHES: Record<string, Finish> = { max_tokens: 'length', refusal: 'filtered' }

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

// A turn as the API takes it: plain text, or blocks when it called tools or answers them.
function turnOf(message: ProviderMessage): { role: string, content: unknown } {
  if (message.calls === undefined && message.results === undefined)
    return { role: message.role, content: message.content }

  if (message.results !== undefined)
    return { role: 'user', content: message.results.map(({ id, content, failed }) => ({ type: 'tool_result', tool_use_id: id, content, ...failed ? { is_error: true } : {} })) }

  return {
    role: 'assistant',
    content: [
      ...message.content === '' ? [] : [{ type: 'text', text: message.content }],
      ...(message.calls ?? []).map(({ id, name, arguments: raw }) => ({ type: 'tool_use', id, name, input: inputOf(raw) })),
    ],
  }
}

// The arguments as the model wrote them, or nothing when they were not an object, which the API refuses as a tool_use input.
function inputOf(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw)

    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
  }
  catch {
    return {}
  }
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
        messages: request.messages.map(turnOf),
        stream: true,
        ...request.system === undefined ? {} : { system: request.system },
        ...request.tools === undefined || request.tools.length === 0 ? {} : { tools: request.tools.map(({ name, description, inputSchema }) => ({ name, description, input_schema: inputSchema })) },
        ...request.temperature === undefined ? {} : { temperature: request.temperature },
      }

      // Tool calls arrive as a block opened with the name, then the arguments in pieces.
      const calls = new Map<number, { id: string, name: string, arguments: string }>()

      for await (const { data } of postEvents('anthropic', `${root}/v1/messages`, { 'x-api-key': apiKey, 'anthropic-version': VERSION }, body, signal, apiKey)) {
        const event = json('anthropic', data)

        switch (event.type) {
          case 'message_start':
            yield* usageOf((event.message as { usage?: unknown } | undefined)?.usage)

            break
          case 'content_block_start': {
            const block = event.content_block as { type?: unknown, id?: unknown, name?: unknown } | undefined

            if (block?.type === 'tool_use' && typeof event.index === 'number')
              calls.set(event.index, { id: typeof block.id === 'string' ? block.id : '', name: typeof block.name === 'string' ? block.name : '', arguments: '' })

            break
          }
          case 'content_block_delta': {
            const delta = event.delta as { type?: unknown, text?: unknown, partial_json?: unknown } | undefined

            if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text !== '')
              yield { text: delta.text }

            if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string' && typeof event.index === 'number') {
              const call = calls.get(event.index)

              if (call)
                call.arguments += delta.partial_json
            }

            break
          }
          case 'content_block_stop': {
            const call = typeof event.index === 'number' ? calls.get(event.index) : undefined

            if (call) {
              calls.delete(event.index as number)

              yield { toolUse: call }
            }

            break
          }
          case 'message_delta': {
            const reason = (event.delta as { stop_reason?: unknown } | undefined)?.stop_reason

            yield* usageOf(event.usage)

            if (typeof reason === 'string')
              yield { finish: FINISHES[reason] ?? 'stop' }

            break
          }
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
