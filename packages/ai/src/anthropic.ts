import type { Finish, Piece, Provider, ProviderMessage, ProviderRequest, Thinking } from './types'
import { AiError } from './errors'
import { extraBody } from './extra'
import { json, postEvents } from './http'
import { outputSchema } from './output-schema'
import { MAX_ARGUMENTS, MAX_NAME_LENGTH, MAX_STREAMED_CALLS } from './tool-limits'

export interface AnthropicOptions {
  apiKey: string
  // The API root, `https://api.anthropic.com` by default, for a proxy.
  baseUrl?: string | undefined
  model?: string | undefined
  // Fields added to the body of every request of this provider, such as `{ top_k: 40 }`; an ask's own `body` wins, and what kayjs-ai settles itself wins over both.
  body?: Record<string, unknown> | undefined
}

export const ANTHROPIC_URL = 'https://api.anthropic.com'
const VERSION = '2023-06-01'
const TRAILING_SLASHES = /\/+$/

const FINISHES: Record<string, Finish> = { max_tokens: 'length', refusal: 'filtered' }
// The share of `maxTokens` each level lets the model think with, and the least Anthropic accepts as a budget.
const THINKING_SHARE = { low: 0.25, medium: 0.5, high: 0.75 }
const MIN_THINKING = 1024
// The tokens the answer keeps beside the thinking budget.
const ANSWER_ROOM = 512

// Extended thinking for the level asked: `none` turns it off, the others give a budget with `ANSWER_ROOM` tokens left for the answer, and a `maxTokens` too small for that leaves thinking alone.
function thinkingOf({ reasoning, maxTokens }: ProviderRequest): { type: 'disabled' } | { type: 'enabled', budget_tokens: number } | undefined {
  if (reasoning === undefined)
    return undefined

  if (reasoning === 'none')
    return { type: 'disabled' }

  const budget = Math.max(MIN_THINKING, Math.floor(maxTokens * THINKING_SHARE[reasoning]))

  return budget + ANSWER_ROOM <= maxTokens ? { type: 'enabled', budget_tokens: budget } : undefined
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

// `input_tokens` leaves out what was read from or written to the cache, which come apart.
function usageOf(value: unknown): Piece[] {
  const { input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: written } = (value ?? {}) as Record<string, unknown>
  const inputTokens = count(input)
  const outputTokens = count(output)
  const cacheReadTokens = count(read)
  const cacheWriteTokens = count(written)

  return [{
    usage: {
      ...inputTokens === undefined ? {} : { inputTokens },
      ...outputTokens === undefined ? {} : { outputTokens },
      ...cacheReadTokens === undefined ? {} : { cacheReadTokens },
      ...cacheWriteTokens === undefined ? {} : { cacheWriteTokens },
    },
  }]
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
    return { role: 'user', content: message.results.map(({ id, content, ok }) => ({ type: 'tool_result', tool_use_id: id, content, ...ok ? {} : { is_error: true } })) }

  return {
    role: 'assistant',
    content: [
      ...(message.thinking ?? []).map(block => 'redacted' in block ? { type: 'redacted_thinking', data: block.redacted } : { type: 'thinking', thinking: block.text, signature: block.signature }),
      ...message.content.trim() === '' ? [] : [{ type: 'text', text: message.content }],
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
export function anthropic({ apiKey, baseUrl = ANTHROPIC_URL, model, body: fields }: AnthropicOptions): Provider {
  const extra = extraBody(fields, 'anthropic({ body })')
  const root = baseUrl.replace(TRAILING_SLASHES, '')

  return {
    name: 'anthropic',
    model,
    async* stream(request, signal) {
      const thinking = thinkingOf(request)
      const body = {
        ...extra,
        ...request.body,
        model: request.model,
        max_tokens: request.maxTokens,
        messages: request.messages.map(turnOf),
        stream: true,
        // Automatic caching: the API puts the breakpoint on the last cacheable block, so later turns and tool steps read the prefix; a prompt under the model's minimum is simply not cached.
        ...request.cache === false ? {} : { cache_control: request.cache === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' } },
        ...request.system === undefined ? {} : { system: request.system },
        ...request.tools === undefined || request.tools.length === 0 ? {} : { tools: request.tools.map(({ name, description, inputSchema }) => ({ name, description, input_schema: inputSchema })) },
        // Anthropic refuses a temperature other than 1 while the model thinks.
        ...request.temperature === undefined || thinking?.type === 'enabled' ? {} : { temperature: request.temperature },
        ...thinking === undefined ? {} : { thinking },
        // The model answers the JSON of the schema as its text, whatever the tools.
        ...request.schema === undefined ? {} : { output_config: { format: { type: 'json_schema', schema: outputSchema(request.schema) } } },
      }

      // Tool calls arrive as a block opened with the name, then the arguments in pieces.
      const calls = new Map<number, { id: string, name: string, arguments: string }>()
      // Thinking arrives as a block too: its text in pieces, then the signature that goes back with it.
      const thoughts = new Map<number, { text: string, signature: string } | { redacted: string }>()

      for await (const { data } of postEvents('anthropic', `${root}/v1/messages`, { 'x-api-key': apiKey, 'anthropic-version': VERSION }, body, request.timeouts, signal, apiKey)) {
        const event = json('anthropic', data)

        switch (event.type) {
          case 'message_start':
            yield* usageOf((event.message as { usage?: unknown } | undefined)?.usage)

            break
          case 'content_block_start': {
            const block = event.content_block as { type?: unknown, id?: unknown, name?: unknown, data?: unknown } | undefined

            if (typeof event.index === 'number' && block?.type === 'thinking' && thoughts.size < MAX_STREAMED_CALLS)
              thoughts.set(event.index, { text: '', signature: '' })

            if (typeof event.index === 'number' && block?.type === 'redacted_thinking' && typeof block.data === 'string' && thoughts.size < MAX_STREAMED_CALLS)
              thoughts.set(event.index, { redacted: block.data })

            if (block?.type === 'tool_use' && typeof event.index === 'number' && calls.size < MAX_STREAMED_CALLS)
              calls.set(event.index, { id: typeof block.id === 'string' ? block.id : '', name: typeof block.name === 'string' ? block.name.slice(0, MAX_NAME_LENGTH + 1) : '', arguments: '' })

            break
          }
          case 'content_block_delta': {
            const delta = event.delta as { type?: unknown, text?: unknown, partial_json?: unknown, thinking?: unknown, signature?: unknown } | undefined
            const thought = typeof event.index === 'number' ? thoughts.get(event.index) : undefined

            if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking !== '' && thought && 'text' in thought) {
              thought.text += delta.thinking

              yield { reasoning: delta.thinking }
            }

            if (delta?.type === 'signature_delta' && typeof delta.signature === 'string' && thought && 'signature' in thought)
              thought.signature += delta.signature

            if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text !== '')
              yield { text: delta.text }

            if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string' && typeof event.index === 'number') {
              const call = calls.get(event.index)

              // Past the cap the arguments stop growing, and the loop answers them as too long.
              if (call && call.arguments.length <= MAX_ARGUMENTS)
                call.arguments += delta.partial_json
            }

            break
          }
          case 'content_block_stop': {
            const call = typeof event.index === 'number' ? calls.get(event.index) : undefined
            const thought = typeof event.index === 'number' ? thoughts.get(event.index) : undefined

            if (thought) {
              thoughts.delete(event.index as number)

              // A block without its signature would be refused when sent back, so it is not kept.
              if ('redacted' in thought || thought.signature !== '')
                yield { thinking: thought satisfies Thinking }
            }

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
