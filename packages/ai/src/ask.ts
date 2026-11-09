import type { TSchema } from 'kay/library'
import type { HeldCall } from './conversation'
import type { Offered } from './loop'
import type { Replaces } from './resume'
import type { AiMessage, AiReply, AskOptions, FunctionTool, Piece, Provider, ProviderMessage, ProviderRequest, ReplyOf, StructuredAskOptions, Timeouts, ToolAction } from './types'
import { actionTool, byteSize, configError, currentRequest, durationSeconds, hookContext, jsonSchemaOf, refundRateLimit } from 'kay/library'
import { attachmentsOf, checkAccepted, DEFAULT_MAX_ATTACHMENT_BYTES, estimatedChars, mediaChars, readAttachments, toolChars } from './attachments'
import { choose, given } from './config'
import { conversationReply, heldCall, heldReply } from './conversation'
import { recorded } from './dev-log'
import { AiError } from './errors'
import { extraBody } from './extra'
import { isFunctionTool, plainTool } from './function-tool'
import { hooksFor, requested } from './hooks'
import { keep, keptFor, markEnded, stopKept } from './kept'
import { guarded, visitorOf } from './limits'
import { converse, single } from './loop'
import { defaultNamed, named } from './models'
import { outputSchema } from './output-schema'
import { createReply } from './reply'
import { conversationCallOf, replacesOf, replyCallOf } from './resume'
import { planFor, resilient } from './retry'
import { structured } from './structured'

const DEFAULT_MAX_TOKENS = 4096
const DEFAULT_MAX_STEPS = 5
const DEFAULT_MAX_INPUT_CHARS = 50_000
const DEFAULT_CONNECT_TIMEOUT = '30s'
const DEFAULT_IDLE_TIMEOUT = '60s'
const ROLES = new Set(['user', 'assistant'])

// `replayed` keeps the calls, results and thinking of messages the library built from a stored conversation; a prompt the app gives holds none.
function messagesOf(prompt: string | AiMessage[], replayed = false): AiMessage[] {
  if (typeof prompt === 'string')
    return [{ role: 'user', content: prompt }]

  if (!Array.isArray(prompt) || prompt.length === 0)
    throw configError('ai', 'messages', 'ask takes a prompt or at least one message')

  return prompt.map((message) => {
    if (typeof message !== 'object' || message === null || !ROLES.has(message.role) || typeof message.content !== 'string')
      throw configError('ai', 'messages', 'a message is { role: \'user\' | \'assistant\', content: string }; the system prompt goes in options.system')

    const attachments = attachmentsOf(message.attachments)

    if (attachments.length > 0 && message.role !== 'user')
      throw new AiError('unsupported', 'only a user message holds attachments')

    const { calls, results, thinking, thinkingBy } = message as ProviderMessage

    return { role: message.role, content: message.content, ...attachments.length > 0 && { attachments }, ...replayed && calls !== undefined && { calls }, ...replayed && results !== undefined && { results }, ...replayed && thinking !== undefined && { thinking, thinkingBy } }
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
function reading(request: ProviderRequest, messages: readonly AiMessage[], maxBytes: number, maxChars: number, provider: Provider, priced: (extra: number) => void): Via {
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

function offer(actions: readonly (ToolAction | FunctionTool)[]): Offered[] {
  const taken = new Set<string>()
  const named = new Set<unknown>()
  const offered: Offered[] = []

  // A function tool keeps the name it was given, so an action of the same name is the one numbered.
  for (const [index, action] of actions.entries()) {
    if (!isFunctionTool(action) || named.has(action))
      continue

    if (taken.has(action.name))
      throw configError('ai', 'tools', `tools[${index}] is named ${action.name}, as another function tool of this ask is`)

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
      throw configError('ai', 'tools', `tools[${index}] cannot be a tool: an action taking a file, one of a page with params or one with \`tool: false\` is none; a function tool is made with tool()`)

    offered.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, ...tool.label !== undefined && { label: tool.label }, tool })
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
    throw configError('ai', 'schema', 'schema is an object schema, s.Object({ ... })')

  // Refuses a shape no provider can be held to before anything is sent.
  outputSchema(plain)

  const answer = { plain, chars: JSON.stringify(plain).length }

  answers.set(schema as object, answer)

  return answer
}

// What the post being answered replaces when it comes from a Chat with `regenerate` or `editable`, or nothing for a fresh send: drop that many stored turns, append the last posted message, answer.
export function replaces(request: Request | undefined = currentRequest()): Replaces | undefined {
  return replacesOf(request)
}

// Asks the model and gives the reply back at once: `await ask(...)` is its text, `for await` its snapshots, and the request to the provider goes out when it is first read.
// The reply stops, and the provider request with it, when the request being answered is aborted, when `options.signal` is, or when a reader leaves early; with `outlive` only `options.signal` and `reply.stop()` stop it.
// A call a Chat sends to resume or stop a reply that outlived its page gets that reply, or an empty one, and asks no provider.
// With a `schema` the reply is the object it describes instead: `await` gives it checked and typed, `for await` the object so far.
export function ask<const Schema extends TSchema>(prompt: string | AiMessage[], options: StructuredAskOptions<Schema>): ReplyOf<Schema>
export function ask(prompt: string | AiMessage[], options?: AskOptions): AiReply
export function ask(prompt: string | AiMessage[], options: AskOptions | StructuredAskOptions = {}): AiReply | ReplyOf<TSchema> {
  const schema = 'schema' in options ? options.schema : undefined
  const call = replyCall()
  const held = heldCall()
  const text = resumed(call) ?? (held === undefined || held.op === 'send' ? remembered(asked(prompt, options, schema, call, held), options, call) : conversationReply(held, messagesOf(prompt), options.key))

  return schema === undefined ? text : structured(text, schema)
}

// A Chat with `keepOnServer` posts its new message alone, and the conversation it holds on the server is asked with it.
function asked(prompt: string | AiMessage[], options: AskOptions, schema: TSchema | undefined, call: ReplyCall | undefined, held: HeldCall | undefined): AiReply {
  if (held === undefined)
    return reply(prompt, options, schema, call)

  return heldReply(held, messagesOf(prompt), options, options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS, messages => reply(messages, options, schema, call, true))
}

// True when the request being answered is a Chat's resume or stop of a reply that outlived its page, or its read or change of a conversation it keeps on the server, which runs the action again: an action skips what only a start needs, such as loading context for a model call that will not be made.
// False for a start, a send and an ordinary call, and outside a request.
export function resuming(request: Request | undefined = currentRequest()): boolean {
  const call = replyCallOf(request)
  const held = conversationCallOf(request)

  return (call !== undefined && call.op !== 'start') || (held !== undefined && held.op !== 'send')
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
function resumed(call: ReplyCall | undefined): AiReply | undefined {
  if (call === undefined || call.op === 'start')
    return undefined

  const empty = createReply(nothing, [], undefined, false, undefined, { resumed: true })

  if (call.key === undefined)
    return empty

  if (call.op === 'stop') {
    stopKept(call.key, call.owner(), call.refund)

    return empty
  }

  return keptFor(call.key, call.owner(), empty, call.refund) ?? empty
}

// A reply that outlives its request is kept under the id its Chat named, for the Chat to find after a reload.
function remembered(made: AiReply, options: AskOptions, call: ReplyCall | undefined): AiReply {
  if (options.outlive === true && call?.op === 'start' && call.key !== undefined)
    keep(call.key, made, call.owner())

  return made
}

function reply(prompt: string | AiMessage[], options: AskOptions, answer: TSchema | undefined, call: ReplyCall | undefined, replayed = false): AiReply {
  const messages = messagesOf(prompt, replayed)
  const fallbackName = options.provider === undefined ? defaultNamed() : undefined
  const chosen = options.model === undefined ? fallbackName : named(options.model)
  const handmade = options.provider ?? chosen?.provider
  const { provider, model: configured } = handmade === undefined ? choose() : { provider: given(handmade), model: handmade.model }
  const model = chosen?.model ?? options.model ?? configured ?? handmade?.model

  if (model === undefined)
    throw configError('ai', 'model', 'no model to ask; set AI_MODEL or pass { model }')

  const hooks = hooksFor(options, provider)
  // The provider the requests go through, which asks again or elsewhere after a failure before the first piece.
  const sturdy = resilient(provider, model, planFor(options, provider), hooks)
  const answering = currentRequest()
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
  const described = answer === undefined ? undefined : answerSchema(answer)
  const schema = described?.plain
  const maxInputChars = options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS
  const attachmentSize = options.maxSize ?? DEFAULT_MAX_ATTACHMENT_BYTES
  // `Infinity` lifts the limit, as it does `maxInputChars`.
  const maxAttachmentBytes = attachmentSize === Infinity ? Infinity : byteSize(attachmentSize, 'the maxSize of ask')

  if (typeof maxInputChars !== 'number' || !(maxInputChars >= 1))
    throw configError('ai', 'maxInputChars', 'maxInputChars is a number of characters of 1 or more')

  const outlive = options.outlive === true
  const kept = call?.key
  const ended = outlive && kept !== undefined ? () => markEnded(kept) : undefined
  // A reply that outlives its request is not stopped by it.
  const signals = [outlive ? undefined : answering?.signal, options.signal]
  const extras = { sources: options.sources, hooks }
  const tools = options.tools !== undefined && options.tools.length > 0
  let offered: Offered[] = []
  let maxSteps = DEFAULT_MAX_STEPS

  // What goes to the provider for these messages and this system prompt; `beforeRequest` may change both, so it is built again for what it returns.
  const plan = (current: AiMessage[], system: string | undefined) => {
    const attached = current.some(message => message.attachments !== undefined)
    // Without attachments the messages are a provider's as they are; with them the request is completed once they are read.
    const request: ProviderRequest = { messages: attached ? [] : current as ProviderMessage[], system, model, maxTokens, temperature: options.temperature, reasoning: options.reasoning, cache: options.cache, body: extraBody(options.body, 'ask({ body })'), timeouts: timeoutsOf(options.timeout), schema }
    const messageChars = current.reduce((sum, message) => sum + message.content.length + estimatedChars(message) + toolChars(message as ProviderMessage), 0)
    const asker = { request: answering, visitor: options.key, chars: messageChars + (system?.length ?? 0) + (described?.chars ?? 0), maxTokens }
    // Every step may use `maxTokens`, which is what the budget holds for a tool loop while it runs.
    const looping = { ...asker, maxTokens: maxTokens * (options.maxSteps ?? DEFAULT_MAX_STEPS) }
    const via: Via = attached
      ? reading(request, current, maxAttachmentBytes, maxInputChars, provider, (extra) => {
        asker.chars += extra
        looping.chars += extra
      })
      : (_signal, make) => make(request)

    return {
      messageChars,
      about: { provider: provider.name, model, prompt: current.findLast(message => message.role === 'user')?.content ?? '', chars: asker.chars },
      open: (signal: AbortSignal): AsyncIterable<Piece> => {
        if (!tools)
          return guarded(() => via(signal, request => single(sturdy.stream(request, signal), { provider: provider.name, model, attempt: 1 })), asker, signal)

        looping.maxTokens = maxTokens * maxSteps

        return guarded(() => via(signal, request => converse(sturdy, request, offered, maxSteps, answering, signal, options.confirm)), looping, signal)
      },
    }
  }

  const first = plan(messages, options.system)

  if (first.messageChars > maxInputChars)
    return createReply(() => tooLong(first.messageChars, maxInputChars), signals, undefined, outlive, ended, extras)

  if (tools) {
    maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS

    if (!Number.isInteger(maxSteps) || maxSteps < 1)
      throw configError('ai', 'maxSteps', 'maxSteps is a whole number of 1 or more')

    offered = offer(options.tools!)

    if (!answering && offered.some(item => item.tool))
      throw configError('ai', 'tools', 'an action runs as the visitor, so ask() with one needs the request being answered; call it from a page, an action or a handler kay is answering, or offer tool({ ... }) functions, which run with no visitor')
  }

  const about = { ...first.about }
  const before = hooks.beforeRequest

  // `beforeRequest` runs before the limits count the ask, so what they and the dev tool see is the request it left, once.
  async function* changed(signal: AbortSignal): AsyncGenerator<Piece> {
    const change = await requested(before, { messages: messages.map(message => ({ ...message })), system: options.system, model: first.about.model, options }, await hooks.context ?? await hookContext())
    let used = first

    if (signal.aborted)
      return

    if (change !== undefined && (change.messages !== undefined || 'system' in change)) {
      used = plan(change.messages === undefined ? messages : messagesOf(change.messages, replayed), 'system' in change ? change.system : options.system)

      if (used.messageChars > maxInputChars)
        throw tooManyChars(used.messageChars, maxInputChars)

      Object.assign(about, used.about)
    }

    yield* used.open(signal)
  }

  return createReply(signal => recorded(before.length === 0 ? first.open(signal) : changed(signal), about, signal), signals, undefined, outlive, ended, extras)
}
