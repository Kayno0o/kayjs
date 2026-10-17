import type { Offered } from './loop'
import type { AskOptions, Message, Reply, ToolAction } from './types'
import { actionTool, currentRequest } from 'kay/library'
import { choose } from './config'
import { guarded } from './limits'
import { converse } from './loop'
import { createReply } from './reply'

const DEFAULT_MAX_TOKENS = 4096
const DEFAULT_MAX_STEPS = 5
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

function offer(actions: readonly ToolAction[]): Offered[] {
  const taken = new Set<string>()
  const seen = new Set<ToolAction>()
  const offered: Offered[] = []

  for (const action of actions) {
    if (seen.has(action))
      continue

    seen.add(action)

    const tool = actionTool(action as Parameters<typeof actionTool>[0], taken)

    if (!tool)
      throw new TypeError(`kayjs-ai: tools[${offered.length}] cannot be a tool: an action taking a file, one of a page with params or one with \`tool: false\` is none`)

    offered.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, tool })
  }

  return offered
}

// Asks the model and gives the reply back at once: `await ask(...)` is its text, `for await` its snapshots, and the request to the provider goes out when it is first read.
// The reply stops, and the provider request with it, when the request being answered is aborted, when `options.signal` is, or when a reader leaves early.
export function ask(prompt: string | Message[], options: AskOptions = {}): Reply {
  const messages = messagesOf(prompt)
  const { provider, model: configured } = options.provider === undefined ? choose() : { provider: options.provider, model: options.provider.model }
  const model = options.model ?? configured ?? options.provider?.model

  if (model === undefined)
    throw new Error('kayjs-ai: no model to ask; set AI_MODEL or pass { model }')

  const answering = currentRequest()
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
  const request = { messages, system: options.system, model, maxTokens, temperature: options.temperature }
  const asker = { request: answering, visitor: options.visitor, chars: messages.reduce((sum, message) => sum + message.content.length, options.system?.length ?? 0), maxTokens }
  const signals = [answering?.signal, options.signal]

  if (options.tools === undefined || options.tools.length === 0)
    return createReply(signal => guarded(() => provider.stream(request, signal), asker, signal), signals)

  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS

  if (!Number.isInteger(maxSteps) || maxSteps < 1)
    throw new TypeError('kayjs-ai: maxSteps is a whole number of 1 or more')

  const offered = offer(options.tools)

  if (!answering)
    throw new Error('kayjs-ai: tools run as the visitor, so ask() with tools needs the request being answered; call it from a page, an action or a handler kay is answering')

  // Every step may use `maxTokens`, which is what the budget holds for the reply while it runs.
  return createReply(signal => guarded(() => converse(provider, request, offered, maxSteps, answering, signal), { ...asker, maxTokens: maxTokens * maxSteps }, signal), signals)
}
