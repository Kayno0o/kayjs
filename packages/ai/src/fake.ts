import type { Message, Piece, Provider, ProviderRequest } from './types'
import process from 'node:process'

// What a fake reply was asked: the request a provider would have been sent.
export interface Asked {
  messages: Message[]
  system: string | undefined
  model: string
  maxTokens: number
  temperature: number | undefined
}

export type Script = string | string[] | ((asked: Asked) => string | string[])

export interface Fake extends Provider {
  // Every ask the fake answered, oldest first.
  readonly asked: readonly Asked[]
  last: () => Asked | undefined
  // The next ask is answered with this: a text, split into words, or the pieces as they should come; a function reads what was asked. Scripts are used in order, then the default reply returns.
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
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)

    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
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
      const question: Asked = { ...request, messages: structuredClone(request.messages) }

      asked.push(question)

      const script = scripts.shift() ?? `Fake reply to: ${request.messages.findLast(message => message.role === 'user')?.content ?? ''}`

      if (script instanceof Error)
        throw script

      const chosen = typeof script === 'function' ? script(question) : script
      const parts = typeof chosen === 'string' ? pieces(chosen) : chosen
      const pace = process.env.NODE_ENV === 'development' ? DEV_PACE_MS : 0
      const input = request.messages.reduce((sum, message) => sum + tokens(message.content), 0) + tokens(request.system ?? '')

      yield { usage: { inputTokens: input } }

      for (const text of parts) {
        await pause(pace, signal)
        signal.throwIfAborted()

        yield { text }
      }

      yield { usage: { outputTokens: tokens(parts.join('')) } }
    },
  }
}

// Answers `ask` in development and under `bun test` instead of a provider, and a test scripts it and reads what was asked, as it reads kayjs-mail's `outbox`.
// Without a script it answers `Fake reply to: <the last user message>`.
export const fakeAi: Fake = ((globalThis as { [FAKE]?: Fake })[FAKE] ??= createFake())
