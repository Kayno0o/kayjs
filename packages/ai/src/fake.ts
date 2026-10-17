import type { Piece, Provider, ProviderMessage, ProviderRequest, ToolSpec } from './types'
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
}

// A step of the model that calls tools, after the text it says first: a string `input` is sent as the arguments as they are, to see what a model garbling its JSON does.
export interface Calls {
  text?: string | string[] | undefined
  calls: { name: string, input?: unknown, id?: string | undefined }[]
}

type Scripted = string | string[] | Calls

export type Script = Scripted | ((asked: Asked) => Scripted)

export interface Fake extends Provider {
  // Every ask the fake answered, oldest first.
  readonly asked: readonly Asked[]
  last: () => Asked | undefined
  // The next ask read is answered with this (scripts go to asks in the order they are read, not made): a text, split into words, the pieces as they should come, or `{ text?, calls }` to call tools (a tool loop reads one script per step); a function reads what was asked. Scripts are used in order, then the default reply returns.
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
      const question: Asked = { ...request, messages: structuredClone(request.messages), tools: request.tools === undefined ? undefined : structuredClone(request.tools) }

      asked.push(question)

      const script = scripts.shift() ?? `Fake reply to: ${request.messages.findLast(message => message.role === 'user')?.content ?? ''}`

      if (script instanceof Error)
        throw script

      const chosen = typeof script === 'function' ? script(question) : script
      const calls = typeof chosen === 'object' && !Array.isArray(chosen) ? chosen.calls : []
      const said = typeof chosen === 'object' && !Array.isArray(chosen) ? chosen.text ?? [] : chosen
      const parts = typeof said === 'string' ? pieces(said) : said
      const pace = process.env.NODE_ENV === 'development' ? DEV_PACE_MS : 0
      const input = request.messages.reduce((sum, message) => sum + tokens(message.content) + (message.results ?? []).reduce((all, result) => all + tokens(result.content), 0), 0) + tokens(request.system ?? '')

      yield { usage: { inputTokens: input } }

      for (const text of parts) {
        await pause(pace, signal)
        signal.throwIfAborted()

        yield { text }
      }

      for (const [index, { name, input, id }] of calls.entries())
        yield { toolUse: { id: id ?? `fake_${index + 1}`, name, arguments: typeof input === 'string' ? input : JSON.stringify(input ?? {}) } }

      yield { usage: { outputTokens: tokens(parts.join('')) } }
      yield { finish: 'stop' }
    },
  }
}

// Answers `ask` in development and under `bun test` instead of a provider, and a test scripts it and reads what was asked, as it reads kayjs-mail's `outbox`.
// Without a script it answers `Fake reply to: <the last user message>`.
export const fakeAi: Fake = ((globalThis as { [FAKE]?: Fake })[FAKE] ??= createFake())
