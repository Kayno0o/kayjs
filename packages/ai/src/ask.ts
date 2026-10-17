import type { AskOptions, Message, Reply } from './types'
import { currentRequest } from 'kay/library'
import { choose } from './config'
import { createReply } from './reply'

const DEFAULT_MAX_TOKENS = 4096
const ROLES = new Set(['user', 'assistant'])

function messagesOf(prompt: string | Message[]): Message[] {
  if (typeof prompt === 'string')
    return [{ role: 'user', content: prompt }]

  if (!Array.isArray(prompt) || prompt.length === 0)
    throw new TypeError('kayjs-ai: ask takes a prompt or at least one message')

  return prompt.map((message) => {
    if (typeof message !== 'object' || message === null || !ROLES.has(message.role) || typeof message.content !== 'string')
      throw new TypeError('kayjs-ai: a message is { role: \'user\' | \'assistant\', content: string }; the system prompt goes in options.system')

    return { role: message.role, content: message.content }
  })
}

// Asks the model and gives the reply back at once: `await ask(...)` is its text, `for await` its snapshots, and the request to the provider goes out when it is first read.
// The reply stops, and the provider request with it, when the request being answered is aborted, when `options.signal` is, or when a reader leaves early.
export function ask(prompt: string | Message[], options: AskOptions = {}): Reply {
  const messages = messagesOf(prompt)
  const { provider, model: configured } = options.provider === undefined ? choose() : { provider: options.provider, model: options.provider.model }
  const model = options.model ?? configured ?? options.provider?.model

  if (model === undefined)
    throw new Error('kayjs-ai: no model to ask; set AI_MODEL or pass { model }')

  return createReply(signal => provider.stream({ messages, system: options.system, model, maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS, temperature: options.temperature }, signal), [currentRequest()?.signal, options.signal])
}
