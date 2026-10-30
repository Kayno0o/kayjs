import type { ServerEvent } from './http'
import type { Finish, Piece, Provider, ProviderMessage, ProviderRequest, Thinking } from './types'
import { AiError } from './errors'
import { extraBody } from './extra'
import { json, postEvents } from './http'
import { outputSchema } from './output-schema'
import { checkedRoot } from './root'
import { MAX_ARGUMENTS, MAX_NAME_LENGTH, MAX_STREAMED_CALLS } from './tool-limits'

export interface AnthropicOptions {
  apiKey: string
  // Lets the key go over plain http to a host that is not loopback, for a network you trust; `AI_INSECURE=true` sets it from the environment.
  insecure?: boolean | undefined
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

// The parts of what `reasoning: 'none'` sends that a model refused, by API root and model: `none` is asked without them from then on.
type Part = 'disabled' | 'effort'

const refusedParts = new Map<string, ReadonlySet<Part>>()

// Forgets what the models refused, for a test.
export function forgetRefusals(): void {
  refusedParts.clear()
}

interface Fields {
  thinking?: { type: string, display?: string }
  effort?: string
}

const ABOUT_EFFORT = /effort/i
const ABOUT_THINKING = /thinking|disabled/i
const NO_FIELDS: Fields = {}

// The part of the settings a refusal is about, from the server's words.
function refusedPart(message: string): Part | undefined {
  if (ABOUT_EFFORT.test(message))
    return 'effort'

  return ABOUT_THINKING.test(message) ? 'disabled' : undefined
}

// What `reasoning` sets: adaptive thinking at the effort asked, its text summarized so it streams (the models since 4.7 omit it otherwise), and for `none` the lowest effort with thinking disabled, each left out where the model refused it.
// A `thinking` of the body replaces all of it, for a model that still wants a budget.
function reasoningOf({ reasoning }: ProviderRequest, refused: ReadonlySet<Part>): Fields {
  if (reasoning === undefined)
    return NO_FIELDS

  if (reasoning === 'none')
    return { ...refused.has('disabled') ? {} : { thinking: { type: 'disabled' } }, ...refused.has('effort') ? {} : { effort: 'low' } }

  return { thinking: { type: 'adaptive', display: 'summarized' }, effort: reasoning }
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
// The message's thinking, which goes first in its content.
function thinkingBlocks(message: ProviderMessage): unknown[] {
  return (message.thinking ?? []).map(block => 'redacted' in block ? { type: 'redacted_thinking', data: block.redacted } : { type: 'thinking', thinking: block.text, signature: block.signature })
}

function turnOf(message: ProviderMessage): { role: string, content: unknown } {
  // Files go before the text, as the API advises.
  if (message.attachments !== undefined && message.attachments.length > 0) {
    return {
      role: message.role,
      content: [
        ...thinkingBlocks(message),
        ...message.attachments.map(media => ({ type: media.kind === 'pdf' ? 'document' : 'image', source: { type: 'base64', media_type: media.type, data: Buffer.from(media.data).toString('base64') } })),
        ...message.content.trim() === '' ? [] : [{ type: 'text', text: message.content }],
      ],
    }
  }

  if (message.calls === undefined && message.results === undefined)
    return { role: message.role, content: message.content }

  if (message.results !== undefined)
    return { role: 'user', content: message.results.map(({ id, content, ok }) => ({ type: 'tool_result', tool_use_id: id, content, ...ok ? {} : { is_error: true } })) }

  return {
    role: 'assistant',
    content: [
      ...thinkingBlocks(message),
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
export function anthropic(options: AnthropicOptions): Provider {
  return anthropicAt(options, 'anthropic({ baseUrl })')
}

// `anthropic()` with the root's name a refused one is reported under: the environment variable when the root comes from it.
export function anthropicAt({ apiKey, baseUrl = ANTHROPIC_URL, insecure, model, body: fields }: AnthropicOptions, rootName: string): Provider {
  const extra = extraBody(fields, 'anthropic({ body })')
  const root = checkedRoot(baseUrl, rootName, apiKey, insecure).replace(TRAILING_SLASHES, '')

  return {
    name: 'anthropic',
    model,
    accepts: ['image', 'pdf'],
    async* stream(request, signal) {
      const key = `${root}\0${request.model}`
      const own = { ...extra, ...request.body }
      const build = (refused: ReadonlySet<Part>) => {
        const { thinking, effort } = 'thinking' in own ? NO_FIELDS : reasoningOf(request, refused)
        const config = { ...typeof own.output_config === 'object' && own.output_config !== null ? own.output_config : {}, ...effort === undefined ? {} : { effort }, ...request.schema === undefined ? {} : { format: { type: 'json_schema', schema: outputSchema(request.schema) } } }

        return {
          ...own,
          model: request.model,
          max_tokens: request.maxTokens,
          messages: request.messages.map(turnOf),
          stream: true,
          // Automatic caching: the API puts the breakpoint on the last cacheable block, so later turns and tool steps read the prefix; a prompt under the model's minimum is simply not cached.
          ...request.cache === false ? {} : { cache_control: request.cache === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' } },
          ...request.system === undefined ? {} : { system: request.system },
          ...request.tools === undefined || request.tools.length === 0 ? {} : { tools: request.tools.map(({ name, description, inputSchema }) => ({ name, description, input_schema: inputSchema })) },
          // Anthropic refuses a temperature other than 1 while the model thinks, so the app's one is left out then (documented on `AskOptions.temperature`).
          ...request.temperature === undefined || thinking?.type === 'adaptive' ? {} : { temperature: request.temperature },
          ...thinking === undefined ? {} : { thinking },
          // The model answers the JSON of the schema as its text, whatever the tools.
          ...Object.keys(config).length === 0 ? {} : { output_config: config },
        }
      }
      const open = (refused: ReadonlySet<Part>) => postEvents('anthropic', `${root}/v1/messages`, { 'x-api-key': apiKey, 'anthropic-version': VERSION }, build(refused), request.timeouts, signal, apiKey)

      // Tool calls arrive as a block opened with the name, then the arguments in pieces.
      const calls = new Map<number, { id: string, name: string, arguments: string }>()
      // Thinking arrives as a block too: its text in pieces, then the signature that goes back with it.
      const thoughts = new Map<number, { text: string, signature: string } | { redacted: string }>()
      // Whether a thinking block already streamed its text, so the next one starts after a blank line in `reasoning`.
      let reasoned = false

      // A model that refuses `disabled` or the effort of `none` is asked again without the part its error names, and remembered once that gets through; a level that is refused fails naming `reasoning`.
      const known = refusedParts.get(key) ?? new Set<Part>()
      let refused: ReadonlySet<Part> = known
      let events = open(refused)
      let first: IteratorResult<ServerEvent>

      for (;;) {
        try {
          first = await events.next()

          break
        }
        catch (error) {
          if (!(error instanceof AiError) || (error.status !== 400 && error.status !== 422) || request.reasoning === undefined || 'thinking' in own)
            throw error

          const part = refusedPart(error.message)

          if (part === undefined)
            throw error

          if (request.reasoning !== 'none' || refused.has(part))
            throw new AiError('invalid', `${error.message.replace('kayjs-ai: ', '')}; this model may not take the thinking settings \`reasoning\` sends, so leave \`reasoning\` out and set \`body: { thinking }\` yourself`, { status: error.status, cause: error })

          refused = new Set([...refused, part])
          events = open(refused)
        }
      }

      if (refused.size > known.size)
        refusedParts.set(key, refused)

      const received = (async function* () {
        if (!first.done)
          yield first.value

        yield* events
      })()

      for await (const { data } of received) {
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
              // The blank line is for the reader only: the block sent back keeps the text as the model wrote it.
              yield { reasoning: reasoned && thought.text === '' ? `\n\n${delta.thinking}` : delta.thinking }

              thought.text += delta.thinking
              reasoned = true
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
