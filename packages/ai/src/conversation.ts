import type { ConversationKey, StoredTurn } from './conversation-store'
import type { ConversationAnswer } from './conversation-title'
import type { ConversationCall } from './resume'
import type { AskOptions, Message, Reply } from './types'
import { logFrom } from 'kay'
import { currentRequest, refundRateLimit } from 'kay/library'
import { estimatedChars } from './attachments'
import { usableSources } from './chat-sources'
import { conversationStore } from './conversation-store'
import { renamedTitle, titleOf } from './conversation-title'
import { deferredReply } from './deferred'
import { AiError } from './errors'
import { namedVisitor } from './limits'
import { createReply } from './reply'
import { conversationCallOf, replacesOf } from './resume'

const log = logFrom('kayjs-ai')
// The conversations a list shows, the most recently updated first.
const LISTED = 100

export interface HeldCall extends ConversationCall {
  request: Request
}

// Requests whose conversation an ask has taken: a second ask of the action leaves it alone.
const taken = new WeakSet<Request>()

// The conversation call of the request being answered, for the first ask that reads it.
export function heldCall(): HeldCall | undefined {
  const request = currentRequest()
  const call = conversationCallOf(request)

  if (request === undefined || call === undefined || taken.has(request))
    return undefined

  taken.add(request)

  return { ...call, request }
}

// A conversation belongs to the action that holds it, so two chats of one visitor keep apart.
const scopeOf = (request: Request) => new URL(request.url).pathname

// A text-only turn of no text, a reply that only called tools or a message of files alone, is kept so the turns line up with the Chat's, and left out of what the model reads, as a provider refuses an empty message.
function fitted(kept: readonly StoredTurn[], posted: readonly Message[], maxInputChars: number): Message[] {
  let room = maxInputChars - posted.reduce((sum, message) => sum + message.content.length + estimatedChars(message), 0)
  const earlier: Message[] = []

  // The newest turns are the ones kept when the conversation outgrows what the ask takes.
  for (const { role, content } of kept.toReversed()) {
    if (content === '')
      continue

    room -= content.length

    if (room < 0)
      break

    earlier.unshift({ role, content })
  }

  const first = earlier.findIndex(({ role }) => role === 'user')

  return [...first === -1 ? [] : earlier.slice(first), ...posted]
}

// Asks with the conversation the Chat posts to: its stored turns, less those a regenerate or an edit replaces, then the posted messages. Once the reply ends the posted messages and the reply are stored, before the reader is told it ended; a revision that moved since the Chat read it is refused with 409, nothing asked.
export function heldReply(call: HeldCall, prompt: Message[], options: AskOptions, maxInputChars: number, make: (messages: Message[]) => Reply): Reply {
  const store = conversationStore()
  let write: ((reply: Reply) => Promise<void>) | undefined

  const target = (async (): Promise<{ reply: Reply }> => {
    const owner = await namedVisitor(call.request, options.key)

    // A visitor no one names keeps no conversation, and their Chat posts its history itself.
    if (owner === undefined || call.id === undefined)
      return { reply: make(prompt) }

    const key: ConversationKey = { owner, scope: scopeOf(call.request), id: call.id }
    const stored = await store.get(key)
    const revision = stored?.revision ?? 0

    if (revision !== call.revision)
      throw new AiError('conflict', `the conversation is at revision ${revision} and the chat posted to revision ${call.revision}, as another tab wrote to it`)

    const turns = stored?.turns ?? []
    const drop = Math.min(replacesOf(call.request)?.turns ?? 0, turns.length)

    write = async reply => kept(reply, key, revision, drop, prompt, options)

    return { reply: make(fitted(turns.slice(0, turns.length - drop), prompt, maxInputChars)) }
  })()

  return deferredReply(target, { ended: async reply => write?.(reply) })
}

// Stores the exchange as the Chat shows it: the posted messages, and the reply when it said or called anything. A reply that failed, or that was stopped before its first word, which the Chat takes back, stores nothing.
async function kept(reply: Reply, key: ConversationKey, revision: number, drop: number, prompt: readonly Message[], options: AskOptions): Promise<void> {
  let text: string

  try {
    text = await reply
  }
  catch {
    return
  }

  const [calls, finish] = await Promise.all([reply.calls, reply.finish])

  if (text === '' && calls.length === 0 && finish === undefined)
    return

  const sources = text === '' ? [] : usableSources(options.sources)
  const answer: StoredTurn[] = text === '' && calls.length === 0 ? [] : [{ role: 'assistant', content: text, ...sources.length > 0 && { sources }, ...finish === undefined && { stopped: true } }]
  const add: StoredTurn[] = [...prompt.map(({ role, content }) => ({ role, content })), ...answer]

  try {
    if (await conversationStore().write(key, revision, { drop, add, title: titleOf(prompt.find(({ role }) => role === 'user')?.content ?? '') }) === undefined)
      log.warn('another tab wrote to the conversation while this reply ran, so the reply is not kept')
  }
  catch (error) {
    log.warn('the conversation could not be stored', error)
  }
}

// The answer of a load, a list, a rename or a remove, as one snapshot holding its JSON, which asks no provider and counts nothing in `ai()`'s limits.
export function conversationReply(call: HeldCall, prompt: readonly Message[], named: string | undefined): Reply {
  return createReply(async function* answering() {
    yield { text: JSON.stringify(await answerOf(call, prompt, named)) }
    yield { finish: 'stop' }
  }, [], () => async () => Promise.resolve([]), false, undefined, { resumed: true })
}

async function answerOf(call: HeldCall, prompt: readonly Message[], named: string | undefined): Promise<ConversationAnswer> {
  const owner = await namedVisitor(call.request, named)

  if (owner === undefined)
    return { owned: false }

  const store = conversationStore()
  const scope = scopeOf(call.request)

  // A read is a page showing the conversation, not a question, so it gives back the attempt the action's `protect.rateLimit` counted.
  if (call.op === 'load' || call.op === 'list')
    await refundRateLimit(call.request)

  if (call.op === 'list')
    return { owned: true, op: 'list', conversations: await store.list(owner, scope, LISTED) }

  if (call.id === undefined)
    return { owned: true, op: 'load', id: undefined, revision: 0, title: '', turns: [] }

  const key: ConversationKey = { owner, scope, id: call.id }

  if (call.op === 'rename')
    return { owned: true, op: 'rename', id: call.id, done: await store.rename(key, renamedTitle(prompt.at(-1)?.content ?? '')) }

  if (call.op === 'remove')
    return { owned: true, op: 'remove', id: call.id, done: await store.remove(key) }

  const stored = await store.get(key)

  return { owned: true, op: 'load', id: call.id, revision: stored?.revision ?? 0, title: stored?.title ?? '', turns: (stored?.turns ?? []).map(({ role, content, sources, stopped }) => ({ role, content, ...sources !== undefined && sources.length > 0 && { sources }, ...stopped === true && { stopped } })) }
}
