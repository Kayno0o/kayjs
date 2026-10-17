import type { Finish, Piece, Provider, ProviderMessage } from './types'
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

const FINISHES: Record<string, Finish> = { length: 'length', content_filter: 'filtered' }

// A mid-stream error by what OpenAI calls it, so an app retrying `unavailable` never loops on one that will not pass.
function failureOf(failure: { message?: unknown, type?: unknown, code?: unknown }): AiError {
  const said = typeof failure.message === 'string' ? `: ${failure.message.slice(0, 200)}` : ''
  const kind = `${String(failure.type)} ${String(failure.code)}`

  if (kind.includes('rate_limit'))
    return new AiError('rate-limited', `openai is rate limiting${said}`)

  if (kind.includes('server_error') || kind.includes('overloaded') || kind.includes('unavailable'))
    return new AiError('unavailable', `openai failed mid-reply${said}`)

  if (kind.includes('auth') || kind.includes('invalid_api_key'))
    return new AiError('auth', `openai refused the key${said}`)

  return new AiError('invalid', `openai refused the request mid-reply${said}`)
}

function usageOf(value: unknown): Piece[] {
  if (typeof value !== 'object' || value === null)
    return []

  const { prompt_tokens: input, completion_tokens: output } = value as { prompt_tokens?: unknown, completion_tokens?: unknown }

  return [{ usage: { ...typeof input === 'number' ? { inputTokens: input } : {}, ...typeof output === 'number' ? { outputTokens: output } : {} } }]
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
        stream_options: { include_usage: true },
        // OpenAI's reasoning models refuse the older name, and the servers imitating it know no other.
        [official ? 'max_completion_tokens' : 'max_tokens']: request.maxTokens,
        ...request.tools === undefined || request.tools.length === 0 ? {} : { tools: request.tools.map(({ name, description, inputSchema }) => ({ type: 'function', function: { name, description, parameters: inputSchema } })) },
        ...request.temperature === undefined ? {} : { temperature: request.temperature },
      }
      let finished = false
      // Tool calls arrive in pieces keyed by their index, the id and name first and the arguments after; some servers send one whole, and one that reuses an index for another id starts another call.
      const calls = new Map<number, { index: number, id: string, name: string, arguments: string }>()
      const byIndex = new Map<number, number>()

      for await (const { data } of postEvents('openai', `${root}/chat/completions`, apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }, body, signal, apiKey)) {
        if (data === '[DONE]')
          return

        const chunk = json('openai', data)
        const failure = chunk.error as { message?: unknown, type?: unknown, code?: unknown } | undefined

        if (failure !== undefined && failure !== null)
          throw failureOf(failure)

        const choice = (chunk.choices as { delta?: { content?: unknown, tool_calls?: unknown }, finish_reason?: unknown }[] | undefined)?.[0]
        const text = choice?.delta?.content

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

        if (typeof text === 'string' && text !== '')
          yield { text }

        if (typeof choice?.finish_reason === 'string') {
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
