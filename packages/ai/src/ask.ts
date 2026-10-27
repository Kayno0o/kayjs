import type { TSchema } from 'kay/library'
import type { Offered, Ran } from './loop'
import type { AskOptions, FunctionTool, Message, Piece, Provider, ProviderMessage, ProviderRequest, Reply, ReplyOf, StructuredAskOptions, Timeouts, ToolAction } from './types'
import { logFrom } from 'kay'
import { actionTool, checkAnswer, configError, currentRequest, durationSeconds, jsonSchemaOf, refundRateLimit } from 'kay/library'
import { attachmentsOf, checkAccepted, DEFAULT_MAX_ATTACHMENT_BYTES, estimatedChars, mediaChars, readAttachments } from './attachments'
import { choose } from './config'
import { recorded } from './dev-log'
import { AiError } from './errors'
import { extraBody } from './extra'
import { isFunctionTool } from './function-tool'
import { keep, keptFor, markEnded, stopKept } from './kept'
import { guarded, visitorOf } from './limits'
import { clip, converse, MAX_RESULT } from './loop'
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

    const attachments = attachmentsOf(message.attachments)

    if (attachments.length > 0 && message.role !== 'user')
      throw new AiError('unsupported', 'only a user message holds attachments')

    return { role: message.role, content: message.content, ...attachments.length > 0 && { attachments } }
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
      next: async () => Promise.reject(tooManyChars(chars, max)),
    }),
  }
}

type Via = (signal: AbortSignal, make: (request: ProviderRequest) => AsyncIterable<Piece>) => AsyncIterable<Piece>

function tooManyChars(chars: number, max: number): AiError {
  return new AiError('too-long', `the messages hold ${chars} characters, past the ${max} that maxInputChars allows`)
}

// Runs a stream over a request whose attachments are read once it is first read, so `ask` itself stays synchronous; they are read at most once however many steps a tool loop takes.
// `priced` is told once what the files really cost beyond the guess made before they were read, which a reply reporting no usage is counted by.
function reading(request: ProviderRequest, messages: readonly Message[], maxBytes: number, maxChars: number, provider: Provider, priced: (extra: number) => void): Via {
  let ready: Promise<ProviderMessage[]> | undefined
  let counted = false

  return async function* (signal, make) {
    ready ??= readAttachments(messages, maxBytes, signal)

    const read = await ready

    if (!counted) {
      counted = true
      priced(read.reduce((sum, message) => sum + mediaChars(message), 0) - messages.reduce((sum, message) => sum + estimatedChars(message), 0))
    }

    const chars = read.reduce((sum, message) => sum + message.content.length + mediaChars(message), 0)

    if (chars > maxChars)
      throw tooManyChars(chars, maxChars)

    checkAccepted(read, provider.accepts, provider.name)

    yield* make({ ...request, messages: read })
  }
}

const log = logFrom('kayjs-ai')

// A function tool as the loop runs it: the input checked against its schema, the result as the text the model reads.
function plainTool(tool: FunctionTool): Offered {
  const plain = jsonSchemaOf(tool.input) as { type?: unknown }

  if (plain.type !== 'object')
    throw configError(`tool ${tool.name}'s input is an object schema, s.Object({ ... })`)

  const run = async (input: Record<string, unknown>, signal: AbortSignal): Promise<Ran> => {
    try {
      const checked = checkAnswer(tool.input, input)

      if (!('value' in checked))
        return { status: 'failed', result: `The arguments do not fit the tool: ${checked.issues.map(({ path, message }) => `${path === '' ? 'the arguments' : path} (${message})`).join(', ')}` }

      const value = await tool.run(checked.value as never, { signal })
      const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''

      return { status: 'done', result: clip(text, MAX_RESULT) }
    }
    catch (error) {
      log.error(`the ${tool.name} tool could not run`, error)

      return { status: 'failed', result: 'The tool could not run' }
    }
  }

  return { name: tool.name, description: tool.description, inputSchema: plain, plain: run }
}

function offer(actions: readonly (ToolAction | FunctionTool)[]): Offered[] {
  const taken = new Set<string>()
  const named = new Set<unknown>()
  const offered: Offered[] = []

  // A function tool keeps the name it was given, so an action of the same name is the one numbered.
  for (const [index, action] of actions.entries()) {
    if (!isFunctionTool(action) || named.has(action))
      continue

    if (taken.has(action.name))
      throw configError(`tools[${index}] is named ${action.name}, as another function tool of this ask is`)

    taken.add(action.name)
    named.add(action)
  }

  const done = new Set<unknown>()

  for (const [index, action] of actions.entries()) {
    if (done.has(action))
      continue

    done.add(action)

    if (isFunctionTool(action)) {
      offered.push(plainTool(action))

      continue
    }

    const tool = actionTool(action as Parameters<typeof actionTool>[0], taken)

    if (!tool)
      throw configError(`tools[${index}] cannot be a tool: an action taking a file, one of a page with params or one with \`tool: false\` is none; a function tool is made with tool()`)

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
  const call = replyCall()
  const text = resumed(call) ?? remembered(reply(prompt, options, schema, call), options, call)

  return schema === undefined ? text : structured(text, schema)
}

// A reply with nothing to say, over a provider no one asks.
function nothing(): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]: () => ({ next: async () => Promise.resolve({ done: true, value: undefined }) }),
  }
}

const asks = new WeakMap<Request, number>()

interface ReplyCall {
  op: 'start' | 'resume' | 'stop'
  // The id the Chat named and the place of this ask among the request's, so two asks of one action keep two replies.
  key: string | undefined
  // The action and the visitor the ask is for, which a resume or a stop must come from too: asked only when a reply is kept, resumed or stopped, so an ordinary ask never runs the `key` hook for it.
  owner: () => Promise<string | undefined>
  // Takes back the attempt the action's `rateLimit` counted for this call, once, for a resume or stop that found its owner's reply and so started no model call.
  refund: () => Promise<void>
}

// What the request being answered says of the reply this ask is for, or nothing for an ordinary call.
function replyCall(): ReplyCall | undefined {
  const request = currentRequest()
  const call = replyCallOf(request)

  if (request === undefined || call === undefined)
    return undefined

  const place = asks.get(request) ?? 0

  asks.set(request, place + 1)

  return { op: call.op, key: call.id === undefined ? undefined : `${call.id}.${place}`, owner: async () => ownerOf(request), refund: async () => refundRateLimit(request) }
}

// Undefined for a visitor no one can tell apart from the next, or when the `key` hook fails: such a visitor keeps no reply and resumes none.
async function ownerOf(request: Request): Promise<string | undefined> {
  try {
    const visitor = await visitorOf(request)

    return visitor === undefined ? undefined : `${new URL(request.url).pathname}\n${visitor}`
  }
  catch {
    return undefined
  }
}

// The reply a Chat resumes or stops by the id it sent, or an empty one when none is kept for it: such a call never asks a provider, nor counts against `ai({ budget, rateLimit })`, and one that finds the reply its visitor kept gives back the attempt the action's own `protect.rateLimit` counted.
function resumed(call: ReplyCall | undefined): Reply | undefined {
  if (call === undefined || call.op === 'start')
    return undefined

  const empty = createReply(nothing, [])

  if (call.key === undefined)
    return empty

  if (call.op === 'stop') {
    stopKept(call.key, call.owner(), call.refund)

    return empty
  }

  return keptFor(call.key, call.owner(), empty, call.refund) ?? empty
}

// A reply that outlives its request is kept under the id its Chat named, for the Chat to find after a reload.
function remembered(made: Reply, options: AskOptions, call: ReplyCall | undefined): Reply {
  if (options.outlive === true && call?.op === 'start' && call.key !== undefined)
    keep(call.key, made, call.owner())

  return made
}

function reply(prompt: string | Message[], options: AskOptions, answer: TSchema | undefined, call: ReplyCall | undefined): Reply {
  const messages = messagesOf(prompt)
  const { provider, model: configured } = options.provider === undefined ? choose() : { provider: options.provider, model: options.provider.model }
  const model = options.model ?? configured ?? options.provider?.model

  if (model === undefined)
    throw configError('no model to ask; set AI_MODEL or pass { model }')

  const answering = currentRequest()
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
  const described = answer === undefined ? undefined : answerSchema(answer)
  const schema = described?.plain
  const attached = messages.some(message => message.attachments !== undefined)
  // Without attachments the messages are a provider's as they are; with them the request is completed once they are read.
  const request: ProviderRequest = { messages: attached ? [] : messages as ProviderMessage[], system: options.system, model, maxTokens, temperature: options.temperature, reasoning: options.reasoning, cache: options.cache, body: extraBody(options.body, 'ask({ body })'), timeouts: timeoutsOf(options.timeout), schema }
  const messageChars = messages.reduce((sum, message) => sum + message.content.length + estimatedChars(message), 0)
  const maxInputChars = options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS
  const maxAttachmentBytes = options.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES

  if (typeof maxInputChars !== 'number' || !(maxInputChars >= 1))
    throw configError('maxInputChars is a number of characters of 1 or more')

  if (typeof maxAttachmentBytes !== 'number' || !(maxAttachmentBytes >= 1))
    throw configError('maxAttachmentBytes is a number of bytes of 1 or more')

  const asker = { request: answering, visitor: options.key, chars: messageChars + (options.system?.length ?? 0) + (described?.chars ?? 0), maxTokens }
  // Every step may use `maxTokens`, which is what the budget holds for a tool loop while it runs.
  const looping = { ...asker, maxTokens: maxTokens * (options.maxSteps ?? DEFAULT_MAX_STEPS) }
  const via: Via = attached
    ? reading(request, messages, maxAttachmentBytes, maxInputChars, provider, (extra) => {
      asker.chars += extra
      looping.chars += extra
    })
    : (_signal, make) => make(request)
  const outlive = options.outlive === true
  const kept = call?.key
  const ended = outlive && kept !== undefined ? () => markEnded(kept) : undefined
  // A reply that outlives its request is not stopped by it.
  const signals = [outlive ? undefined : answering?.signal, options.signal]
  const about = { provider: provider.name, model, prompt: messages.findLast(message => message.role === 'user')?.content ?? '', chars: asker.chars }

  if (messageChars > maxInputChars)
    return createReply(() => tooLong(messageChars, maxInputChars), signals, undefined, outlive, ended)

  if (options.tools === undefined || options.tools.length === 0)
    return createReply(signal => recorded(guarded(() => via(signal, request => provider.stream(request, signal)), asker, signal), about, signal), signals, undefined, outlive, ended)

  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS

  if (!Number.isInteger(maxSteps) || maxSteps < 1)
    throw configError('maxSteps is a whole number of 1 or more')

  const offered = offer(options.tools)

  if (!answering && offered.some(item => item.tool))
    throw configError('an action runs as the visitor, so ask() with one needs the request being answered; call it from a page, an action or a handler kay is answering, or offer tool({ ... }) functions, which run with no visitor')

  looping.maxTokens = maxTokens * maxSteps

  return createReply(signal => recorded(guarded(() => via(signal, request => converse(provider, request, offered, maxSteps, answering, signal, options.confirm)), looping, signal), about, signal), signals, undefined, outlive, ended)
}
