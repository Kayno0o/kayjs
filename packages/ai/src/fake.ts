import type { Finish, Piece, Provider, ProviderMessage, ProviderRequest, ToolSpec } from './types'
import process from 'node:process'

// What a fake reply was asked: the request a provider would have been sent.
export interface Asked {
  messages: ProviderMessage[]
  // The tools the model was offered, absent when it was offered none.
  tools?: ToolSpec[] | undefined
  system: string | undefined
  model: string
  maxTokens: number
  temperature: number | undefined
  // The JSON Schema of the object the ask wants, absent when it asked for text.
  schema?: object | undefined
}

// A step of the model that calls tools, after the text it says first: a string `input` is sent as the arguments as they are, to see what a model garbling its JSON does.
export interface Calls {
  text?: string | string[] | undefined
  // The object answering an ask with a `schema`, sent as its JSON text in pieces; any value, so a test can script one the schema refuses.
  data?: unknown
  calls?: { name: string, input?: unknown, id?: string | undefined }[] | undefined
  // Input tokens the step reports as read from the provider's prompt cache and written to it, on top of the ones it counts itself.
  cache?: { read?: number | undefined, written?: number | undefined } | undefined
  // Why the step ended, `stop` unless given, such as `length` for a reply cut by the token cap.
  finish?: Finish | undefined
}

type Scripted = string | string[] | Calls

export type Script = Scripted | ((asked: Asked) => Scripted)

export interface Fake extends Provider {
  // Every ask the fake answered, oldest first.
  readonly asked: readonly Asked[]
  last: () => Asked | undefined
  // The next ask read is answered with this (scripts go to asks in the order they are read, not made): a text, split into words, the pieces as they should come, or `{ text?, calls?, cache? }` to call tools or report cache reads and writes (a tool loop reads one script per step); a function reads what was asked. Scripts are used in order, then the default reply returns.
  reply: (script: Script) => void
  // The next ask fails with this error.
  fail: (error: Error) => void
  // Forgets what was asked and scripted.
  clear: () => void
}

const FAKE = Symbol.for('kayjs-ai.fake')
const WORDS = /\S+\s*|\s+/g
const CHARS_PER_TOKEN = 4
const DEV_PACE_MS = 20

function pieces(text: string): string[] {
  return text.match(WORDS) ?? []
}

const SAMPLE_STRINGS: Record<string, string> = {
  'date-time': '2000-01-01T00:00:00.000Z',
  'date': '2000-01-01',
  'time': '00:00:00',
  'email': 'fake@example.com',
  'uri': 'https://example.com',
  'url': 'https://example.com',
  'uuid': '00000000-0000-4000-8000-000000000000',
}

type Node = Record<string, unknown>

// A value that fits a JSON Schema as far as it can be built from it, what an ask for an object gets from the fake when nothing is scripted: strings say `fake`, numbers sit at their minimum, a list has as many items as it needs.
function sampleOf(schema: unknown): unknown {
  if (typeof schema !== 'object' || schema === null)
    return null

  const node = schema as Node

  if ('const' in node)
    return node.const

  if (Array.isArray(node.enum))
    return node.enum[0]

  if (Array.isArray(node.anyOf))
    return sampleOf(node.anyOf.find(member => (member as Node).type !== 'null') ?? node.anyOf[0])

  switch (Array.isArray(node.type) ? node.type[0] : node.type) {
    case 'object': {
      const properties = (node.properties ?? {}) as Record<string, unknown>
      const required = Array.isArray(node.required) ? node.required as string[] : []

      return Object.fromEntries(required.filter(name => name in properties).map(name => [name, sampleOf(properties[name])]))
    }
    case 'array':
      return Array.from({ length: typeof node.minItems === 'number' ? node.minItems : 0 }, () => sampleOf(node.items))
    case 'string': {
      const sample = typeof node.format === 'string' ? SAMPLE_STRINGS[node.format] : undefined
      const text = sample ?? 'fake'

      return typeof node.minLength === 'number' ? text.padEnd(node.minLength, '.') : text
    }
    case 'integer':
    case 'number': {
      const exclusive = typeof node.exclusiveMinimum === 'number' ? node.exclusiveMinimum + 1 : 0
      const low = typeof node.minimum === 'number' ? node.minimum : exclusive
      const high = typeof node.maximum === 'number' ? node.maximum : Infinity

      return Math.min(low, high)
    }
    case 'boolean':
      return false
    default:
      return null
  }
}

async function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted)
    return Promise.resolve()

  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined

    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }

    timer = setTimeout(done, ms)
    signal.addEventListener('abort', done)
  })
}

function tokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

// What a script has the model say: its text, or its data as JSON.
function saidBy(script: Scripted): string | string[] {
  if (typeof script !== 'object' || Array.isArray(script))
    return script

  return script.data === undefined ? script.text ?? [] : JSON.stringify(script.data, null, 2)
}

function createFake(): Fake {
  const asked: Asked[] = []
  const scripts: (Script | Error)[] = []

  return {
    name: 'fake',
    model: 'fake',
    asked,
    last: () => asked.at(-1),
    reply: script => void scripts.push(script),
    fail: error => void scripts.push(error),
    clear: () => {
      asked.length = 0
      scripts.length = 0
    },
    async* stream(request: ProviderRequest, signal): AsyncGenerator<Piece> {
      const question: Asked = { ...request, messages: structuredClone(request.messages), tools: request.tools === undefined ? undefined : structuredClone(request.tools), schema: request.schema === undefined ? undefined : structuredClone(request.schema) }

      asked.push(question)

      const script = scripts.shift() ?? (request.schema === undefined ? `Fake reply to: ${request.messages.findLast(message => message.role === 'user')?.content ?? ''}` : { data: sampleOf(request.schema) })

      if (script instanceof Error)
        throw script

      const chosen = typeof script === 'function' ? script(question) : script
      const calls = typeof chosen === 'object' && !Array.isArray(chosen) ? chosen.calls ?? [] : []
      const cache = typeof chosen === 'object' && !Array.isArray(chosen) ? chosen.cache : undefined
      const said = saidBy(chosen)
      const parts = typeof said === 'string' ? pieces(said) : said
      const pace = process.env.NODE_ENV === 'development' ? DEV_PACE_MS : 0
      const input = request.messages.reduce((sum, message) => sum + tokens(message.content) + (message.results ?? []).reduce((all, result) => all + tokens(result.content), 0), 0) + tokens(request.system ?? '')

      yield { usage: { inputTokens: input, ...cache?.read === undefined ? {} : { cacheReadTokens: cache.read }, ...cache?.written === undefined ? {} : { cacheWriteTokens: cache.written } } }

      for (const text of parts) {
        await pause(pace, signal)
        signal.throwIfAborted()

        yield { text }
      }

      for (const [index, { name, input, id }] of calls.entries())
        yield { toolUse: { id: id ?? `fake_${index + 1}`, name, arguments: typeof input === 'string' ? input : JSON.stringify(input ?? {}) } }

      yield { usage: { outputTokens: tokens(parts.join('')) } }
      yield { finish: typeof chosen === 'object' && !Array.isArray(chosen) ? chosen.finish ?? 'stop' : 'stop' }
    },
  }
}

// Answers `ask` in development and under `bun test` instead of a provider, and a test scripts it and reads what was asked, as it reads kayjs-mail's `outbox`.
// Without a script it answers `Fake reply to: <the last user message>`.
export const fakeAi: Fake = ((globalThis as { [FAKE]?: Fake })[FAKE] ??= createFake())
