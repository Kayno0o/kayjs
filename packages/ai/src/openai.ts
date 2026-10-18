import type { ServerEvent } from './http'
import type { Finish, Piece, Provider, ProviderMessage, ProviderRequest } from './types'
import { AiError } from './errors'
import { json, postEvents } from './http'
import { MAX_ARGUMENTS, MAX_STREAMED_CALLS } from './tool-limits'

export interface OpenAiOptions {
  // The server's API root, `https://api.openai.com/v1` by default; Ollama is `http://localhost:11434/v1`.
  baseUrl?: string | undefined
  // Sent as a bearer token; a local server wanting none leaves it out.
  apiKey?: string | undefined
  model?: string | undefined
}

export const OPENAI_URL = 'https://api.openai.com/v1'
const TRAILING_SLASHES = /\/+$/

// The parameters a server may refuse, which the request is sent again without: `stream_options` to count tokens, `prompt_cache_key` to raise cache hits.
type Optional = 'stream_options' | 'prompt_cache_key'

// Those a server refused once, by API root, so only the first ask of a process pays the retry.
const refused = new Map<string, Set<Optional>>()

const FINISHES: Record<string, Finish> = { length: 'length', content_filter: 'filtered' }

const RATE_LIMITED = new Set(['rate_limit_exceeded', 'rate_limit_error', 'requests', 'tokens'])
const UNAVAILABLE = new Set(['server_error', 'service_unavailable', 'service_unavailable_error', 'overloaded', 'overloaded_error', 'engine_overloaded'])
const REFUSED_KEY = new Set(['authentication_error', 'invalid_api_key', 'incorrect_api_key', 'invalid_authentication'])

// A mid-stream error by what OpenAI calls it, so an app retrying `unavailable` never loops on one that will not pass; the type and the code are matched whole, never by a part of them.
function failureOf(failure: { message?: unknown, type?: unknown, code?: unknown }): AiError {
  const said = typeof failure.message === 'string' ? `: ${failure.message.slice(0, 200)}` : ''
  const names = [failure.type, failure.code].filter((name): name is string => typeof name === 'string')

  if (names.some(name => RATE_LIMITED.has(name)))
    return new AiError('rate-limited', `openai is rate limiting${said}`)

  if (names.some(name => UNAVAILABLE.has(name)))
    return new AiError('unavailable', `openai failed mid-reply${said}`)

  if (names.some(name => REFUSED_KEY.has(name)))
    return new AiError('auth', `openai refused the key${said}`)

  return new AiError('invalid', `openai refused the request mid-reply${said}`)
}

// The text of a delta's content: a string, or on Mistral an array of chunks of which only the `text` ones are the reply.
function textOf(content: unknown): string {
  if (typeof content === 'string')
    return content

  if (!Array.isArray(content))
    return ''

  return content.map(part => typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '').join('')
}

function usageOf(value: unknown): Piece[] {
  if (typeof value !== 'object' || value === null)
    return []

  const { prompt_tokens: input, completion_tokens: output, prompt_tokens_details: details } = value as { prompt_tokens?: unknown, completion_tokens?: unknown, prompt_tokens_details?: { cached_tokens?: unknown } | null }
  const cached = typeof details?.cached_tokens === 'number' ? details.cached_tokens : undefined

  // `prompt_tokens` holds the cached tokens, which come apart here as Anthropic's do.
  return [{ usage: { ...typeof input === 'number' ? { inputTokens: cached === undefined ? input : Math.max(0, input - cached) } : {}, ...typeof output === 'number' ? { outputTokens: output } : {}, ...cached === undefined ? {} : { cacheReadTokens: cached } } }]
}

// One key for a whole conversation, derived from its system prompt and first message so the app sets nothing: every turn and tool step shares it, which sends them to the machine holding their cache, while conversations differ so no key takes more than a server routes to one machine.
function cacheKeyOf(request: ProviderRequest): string {
  const hasher = new Bun.CryptoHasher('sha256')

  hasher.update(`${request.system ?? ''}\0${request.messages[0]?.content ?? ''}`)

  return `kay-${hasher.digest('hex').slice(0, 32)}`
}

// A turn as the API takes it: the calls an assistant made ride on its message, and each result is a message of its own.
function turnsOf(message: ProviderMessage): object[] {
  if (message.results !== undefined)
    return message.results.map(({ id, content }) => ({ role: 'tool', tool_call_id: id, content }))

  if (message.calls === undefined)
    return [{ role: message.role, content: message.content }]

  return [{
    role: 'assistant',
    content: message.content === '' ? null : message.content,
    tool_calls: message.calls.map(({ id, name, arguments: raw }) => ({ id, type: 'function', function: { name, arguments: raw } })),
  }]
}

// An OpenAI chat completions server: OpenAI itself, Ollama, and the many that speak its API.
export function openai({ baseUrl = OPENAI_URL, apiKey, model }: OpenAiOptions = {}): Provider {
  const root = baseUrl.replace(TRAILING_SLASHES, '')
  const official = root === OPENAI_URL

  return {
    name: 'openai',
    model,
    async* stream(request, signal) {
      const messages = [...request.system === undefined ? [] : [{ role: 'system', content: request.system }], ...request.messages.flatMap(turnsOf)]
      const body = {
        model: request.model,
        messages,
        stream: true,
        // OpenAI's reasoning models refuse the older name, and the servers imitating it know no other.
        [official ? 'max_completion_tokens' : 'max_tokens']: request.maxTokens,
        ...request.tools === undefined || request.tools.length === 0 ? {} : { tools: request.tools.map(({ name, description, inputSchema }) => ({ type: 'function', function: { name, description, parameters: inputSchema } })) },
        ...request.temperature === undefined ? {} : { temperature: request.temperature },
      }
      const headers = apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }
      const url = `${root}/chat/completions`
      let finished = false
      // Tool calls arrive in pieces keyed by their index, the id and name first and the arguments after; some servers send one whole, and one that reuses an index for another id starts another call.
      const calls = new Map<number, { index: number, id: string, name: string, arguments: string }>()
      const byIndex = new Map<number, number>()

      // OpenAI and Ollama count tokens only when asked; Mistral refuses the parameter and sends usage unasked. Both optional parameters go first, and on a 400 or 422 the request goes again without the one the error names (else without both), the root remembered once that works.
      const known = refused.get(root) ?? new Set<Optional>()
      const optional = (['stream_options', 'prompt_cache_key'] as const).filter(name => !known.has(name) && (name === 'stream_options' || request.cache !== false))
      const open = (sent: readonly Optional[]) => postEvents('openai', url, headers, { ...body, ...sent.includes('stream_options') ? { stream_options: { include_usage: true } } : {}, ...sent.includes('prompt_cache_key') ? { prompt_cache_key: cacheKeyOf(request) } : {} }, request.timeouts, signal, apiKey)
      let sent: readonly Optional[] = optional
      let events = open(sent)
      let first: IteratorResult<ServerEvent>

      for (;;) {
        try {
          first = await events.next()

          break
        }
        catch (error) {
          if (sent.length === 0 || !(error instanceof AiError) || (error.status !== 400 && error.status !== 422))
            throw error

          const named = sent.filter(name => error.message.includes(name))

          sent = named.length === 0 ? [] : sent.filter(name => !named.includes(name))
          events = open(sent)
        }
      }

      if (sent.length < optional.length)
        refused.set(root, new Set([...known, ...optional.filter(name => !sent.includes(name))]))

      const received = (async function* () {
        if (!first.done)
          yield first.value

        yield* events
      })()

      for await (const { data } of received) {
        if (data === '[DONE]')
          return

        const chunk = json('openai', data)
        const failure = chunk.error as { message?: unknown, type?: unknown, code?: unknown } | undefined

        if (failure !== undefined && failure !== null)
          throw failureOf(failure)

        const choice = (chunk.choices as { delta?: { content?: unknown, tool_calls?: unknown }, finish_reason?: unknown }[] | undefined)?.[0]
        const text = textOf(choice?.delta?.content)

        if (Array.isArray(choice?.delta?.tool_calls)) {
          for (const piece of choice.delta.tool_calls as { index?: unknown, id?: unknown, function?: { name?: unknown, arguments?: unknown } }[]) {
            if (typeof piece !== 'object' || piece === null)
              continue

            const known = typeof piece.index === 'number' ? byIndex.get(piece.index) : undefined
            let call = known === undefined ? undefined : calls.get(known)

            if (call && typeof piece.id === 'string' && piece.id !== '' && call.id !== '' && call.id !== piece.id)
              call = undefined

            if (!call) {
              if (calls.size >= MAX_STREAMED_CALLS)
                continue

              call = { index: typeof piece.index === 'number' ? piece.index : calls.size, id: '', name: '', arguments: '' }
              calls.set(calls.size, call)

              if (typeof piece.index === 'number')
                byIndex.set(piece.index, calls.size - 1)
            }

            if (typeof piece.id === 'string' && piece.id !== '')
              call.id = piece.id

            if (typeof piece.function?.name === 'string')
              call.name += piece.function.name

            // Past the cap the arguments stop growing, and the loop answers them as too long.
            if (typeof piece.function?.arguments === 'string' && call.arguments.length <= MAX_ARGUMENTS)
              call.arguments += piece.function.arguments
          }
        }

        if (text !== '')
          yield { text }

        if (typeof choice?.finish_reason === 'string') {
          // Mistral ends a stream that failed on `error`.
          if (choice.finish_reason === 'error')
            throw new AiError('unavailable', 'openai failed mid-reply')

          finished = true

          yield* [...calls.values()].sort((a, b) => a.index - b.index).map(({ id, name, arguments: raw }) => ({ toolUse: { id, name, arguments: raw } }))

          calls.clear()
          byIndex.clear()

          yield { finish: FINISHES[choice.finish_reason] ?? 'stop' }
        }

        yield* usageOf(chunk.usage)
      }

      if (!finished)
        throw new AiError('cut', 'openai ended the stream before the reply was done')
    },
  }
}
