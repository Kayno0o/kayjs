import type { TSchema } from 'kay/library'
import type { Offered } from './loop'
import type { AskOptions, Message, Reply, ReplyOf, StructuredAskOptions, Timeouts, ToolAction } from './types'
import { actionTool, configError, currentRequest, durationSeconds, jsonSchemaOf } from 'kay/library'
import { choose } from './config'
import { recorded } from './dev-log'
import { AiError } from './errors'
import { keep, kept } from './kept'
import { guarded } from './limits'
import { converse } from './loop'
import { outputSchema } from './output-schema'
import { createReply } from './reply'
import { replyCallOf } from './resume'
import { structured } from './structured'

const DEFAULT_MAX_TOKENS = 4096
const DEFAULT_MAX_STEPS = 5
const DEFAULT_MAX_INPUT_CHARS = 50_000
const DEFAULT_CONNECT_TIMEOUT = '30s'
const DEFAULT_IDLE_TIMEOUT = '60s'
const ROLES = new Set(['user', 'assistant'])

function messagesOf(prompt: string | Message[]): Message[] {
  if (typeof prompt === 'string')
    return [{ role: 'user', content: prompt }]

  if (!Array.isArray(prompt) || prompt.length === 0)
    throw configError('ask takes a prompt or at least one message')

  return prompt.map((message) => {
    if (typeof message !== 'object' || message === null || !ROLES.has(message.role) || typeof message.content !== 'string')
      throw configError('a message is { role: \'user\' | \'assistant\', content: string }; the system prompt goes in options.system')

    return { role: message.role, content: message.content }
  })
}

// A timer takes at most 2^31 - 1 ms (about 24 days) and fires at once past it.
const MAX_TIMER_MS = 2 ** 31 - 1

function timeoutsOf(timeout: AskOptions['timeout']): Timeouts {
  const { connect = DEFAULT_CONNECT_TIMEOUT, idle = DEFAULT_IDLE_TIMEOUT } = timeout ?? {}

  return {
    connect: `${Math.min(MAX_TIMER_MS, Math.ceil(durationSeconds(connect, 'ask({ timeout }).connect') * 1000))}ms`,
    idle: `${Math.min(MAX_TIMER_MS, Math.ceil(durationSeconds(idle, 'ask({ timeout }).idle') * 1000))}ms`,
  }
}

// A reply that fails on its first read, as a refused ask does, so an action letting it out answers the visitor.
function tooLong(chars: number, max: number): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => Promise.reject(new AiError('too-long', `the messages hold ${chars} characters, past the ${max} that maxInputChars allows`)),
    }),
  }
}

function offer(actions: readonly ToolAction[]): Offered[] {
  const taken = new Set<string>()
  const seen = new Set<ToolAction>()
  const offered: Offered[] = []

  for (const [index, action] of actions.entries()) {
    if (seen.has(action))
      continue

    seen.add(action)

    const tool = actionTool(action as Parameters<typeof actionTool>[0], taken)

    if (!tool)
      throw configError(`tools[${index}] cannot be a tool: an action taking a file, one of a page with params or one with \`tool: false\` is none`)

    offered.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, tool })
  }

  return offered
}

const answers = new WeakMap<object, { plain: object, chars: number }>()

// The JSON Schema a provider is asked for, from a kay schema that must describe an object, and its length.
function answerSchema(schema: unknown): { plain: object, chars: number } {
  const known = typeof schema === 'object' && schema !== null ? answers.get(schema) : undefined

  if (known)
    return known

  const plain = typeof schema === 'object' && schema !== null ? jsonSchemaOf(schema) as { type?: unknown } : undefined

  if (plain?.type !== 'object')
    throw configError('schema is an object schema, s.Object({ ... })')

  // Refuses a shape no provider can be held to before anything is sent.
  outputSchema(plain)

  const answer = { plain, chars: JSON.stringify(plain).length }

  answers.set(schema as object, answer)

  return answer
}

// Asks the model and gives the reply back at once: `await ask(...)` is its text, `for await` its snapshots, and the request to the provider goes out when it is first read.
// The reply stops, and the provider request with it, when the request being answered is aborted, when `options.signal` is, or when a reader leaves early; with `outlive` only `options.signal` and `reply.stop()` stop it.
// A call a Chat sends to resume or stop a reply that outlived its page gets that reply, or an empty one, and asks no provider.
// With a `schema` the reply is the object it describes instead: `await` gives it checked and typed, `for await` the object so far.
export function ask<const Schema extends TSchema>(prompt: string | Message[], options: StructuredAskOptions<Schema>): ReplyOf<Schema>
export function ask(prompt: string | Message[], options?: AskOptions): Reply
export function ask(prompt: string | Message[], options: AskOptions | StructuredAskOptions = {}): Reply | ReplyOf<TSchema> {
  const schema = 'schema' in options ? options.schema : undefined
  const text = resumed() ?? remembered(reply(prompt, options, schema), options)

  return schema === undefined ? text : structured(text, schema)
}

// A reply with nothing to say, over a provider no one asks.
function nothing(): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]: () => ({ next: async () => Promise.resolve({ done: true, value: undefined }) }),
  }
}

// The reply a Chat resumes or stops by the id it sent, or an empty one when none is kept: such a call never asks a provider.
function resumed(): Reply | undefined {
  const call = replyCallOf(currentRequest())

  if (call === undefined || call.op === 'start')
    return undefined

  const found = kept(call.id)

  if (call.op === 'stop') {
    found?.stop()

    return createReply(nothing, [])
  }

  return found ?? createReply(nothing, [])
}

// A reply that outlives its request is kept under the id its Chat named, for the Chat to find after a reload.
function remembered(made: Reply, options: AskOptions): Reply {
  const call = replyCallOf(currentRequest())

  if (options.outlive === true && call?.op === 'start' && call.id !== undefined)
    keep(call.id, made)

  return made
}

function reply(prompt: string | Message[], options: AskOptions, answer: TSchema | undefined): Reply {
  const messages = messagesOf(prompt)
  const { provider, model: configured } = options.provider === undefined ? choose() : { provider: options.provider, model: options.provider.model }
  const model = options.model ?? configured ?? options.provider?.model

  if (model === undefined)
    throw configError('no model to ask; set AI_MODEL or pass { model }')

  const answering = currentRequest()
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
  const described = answer === undefined ? undefined : answerSchema(answer)
  const schema = described?.plain
  const request = { messages, system: options.system, model, maxTokens, temperature: options.temperature, reasoning: options.reasoning, cache: options.cache, timeouts: timeoutsOf(options.timeout), schema }
  const messageChars = messages.reduce((sum, message) => sum + message.content.length, 0)
  const maxInputChars = options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS

  if (typeof maxInputChars !== 'number' || !(maxInputChars >= 1))
    throw configError('maxInputChars is a number of characters of 1 or more')

  const asker = { request: answering, visitor: options.key, chars: messageChars + (options.system?.length ?? 0) + (described?.chars ?? 0), maxTokens }
  const outlive = options.outlive === true
  // A reply that outlives its request is not stopped by it.
  const signals = [outlive ? undefined : answering?.signal, options.signal]
  const about = { provider: provider.name, model, prompt: messages.findLast(message => message.role === 'user')?.content ?? '', chars: asker.chars }

  if (messageChars > maxInputChars)
    return createReply(() => tooLong(messageChars, maxInputChars), signals, undefined, outlive)

  if (options.tools === undefined || options.tools.length === 0)
    return createReply(signal => recorded(guarded(() => provider.stream(request, signal), asker, signal), about, signal), signals, undefined, outlive)

  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS

  if (!Number.isInteger(maxSteps) || maxSteps < 1)
    throw configError('maxSteps is a whole number of 1 or more')

  const offered = offer(options.tools)

  if (!answering)
    throw configError('tools run as the visitor, so ask() with tools needs the request being answered; call it from a page, an action or a handler kay is answering')

  // Every step may use `maxTokens`, which is what the budget holds for the reply while it runs.
  return createReply(signal => recorded(guarded(() => converse(provider, request, offered, maxSteps, answering, signal, options.confirm), { ...asker, maxTokens: maxTokens * maxSteps }, signal), about, signal), signals, undefined, outlive)
}
