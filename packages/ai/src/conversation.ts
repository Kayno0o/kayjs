import type { ConversationKey, StoredCall, StoredTurn } from './conversation-store'
import type { ConversationAnswer } from './conversation-title'
import type { ConversationCall } from './resume'
import type { AskOptions, Message, ProviderMessage, Reply, ToolCall } from './types'
import { logFrom } from 'kay'
import { currentRequest, refundRateLimit } from 'kay/library'
import { estimatedChars, toolChars } from './attachments'
import { usableSources } from './chat-sources'
import { conversationStore } from './conversation-store'
import { renamedTitle, titleOf } from './conversation-title'
import { deferredReply } from './deferred'
import { AiError } from './errors'
import { namedVisitor } from './limits'
import { clip } from './loop'
import { createReply } from './reply'
import { conversationCallOf, replacesOf, replyCallOf } from './resume'

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

// A page opening shows a conversation and the list, two reads; a visitor's first ones in a window give back the attempt the action's `rateLimit` counted, so the handler's code before `ask` cannot be replayed through reads without limit.
const READ_REFUNDS = 10
const READ_WINDOW_MS = 10 * 60_000
// The readers counted, oldest first, at most this many, as the process holds them in memory.
const MOST_READERS = 10_000
const reads = new Map<string, { since: number, count: number }>()

// For tests, which each start with no read counted.
export function forgetReads(): void {
  reads.clear()
}

// Counts the read with no await between the check and the count, so parallel reads cannot pass the cap.
function mayRefund(reader: string, now: number): boolean {
  const counted = reads.get(reader)

  if (counted === undefined || now - counted.since > READ_WINDOW_MS) {
    reads.delete(reader)
    reads.set(reader, { since: now, count: 1 })

    if (reads.size > MOST_READERS)
      reads.delete(reads.keys().next().value!)

    return true
  }

  counted.count++

  return counted.count <= READ_REFUNDS
}

// A conversation belongs to the action that holds it, so two chats of one visitor keep apart.
const scopeOf = (request: Request) => new URL(request.url).pathname

// What a replayed result is shortened to once the conversation outgrows what the ask takes.
const LEFT_OUT = '(left out)'
// What stands for the answer of a reply that called tools and said nothing, as a provider needs an assistant turn after the results.
const NO_ANSWER = '(no answer was given)'

type Replayed = Message & Pick<ProviderMessage, 'calls' | 'results'>

// A turn as the model read it: the user's text, or for a reply each request's calls and their results, then its text.
// A turn of no text and no calls, a message of files alone, is kept so the turns line up with the Chat's, and left out of what the model reads, as a provider refuses an empty message.
// A call's id is told apart by the turn it is in, as a provider leaving ids out has them reissued as `call_1` in every turn and Anthropic refuses a repeated one.
function replayed({ role, content, steps }: StoredTurn, shortened: boolean, at: number): Replayed[] {
  if (role === 'user' || steps === undefined || steps.length === 0)
    return content === '' ? [] : [{ role, content }]

  return [
    ...steps.flatMap(calls => [
      { role: 'assistant' as const, content: '', calls: calls.map(({ id, name, arguments: input }) => ({ id: `t${at}_${id}`, name, arguments: input })) },
      { role: 'user' as const, content: '', results: calls.map(({ id, result, ok }) => ({ id: `t${at}_${id}`, content: shortened && result.length > LEFT_OUT.length ? LEFT_OUT : result, ok })) },
    ]),
    { role, content: content === '' ? NO_ANSWER : content },
  ]
}

const charsOf = (messages: readonly Replayed[]) => messages.reduce((sum, message) => sum + message.content.length + toolChars(message), 0)

// Two turns of one role in a row, left once an empty turn between them is, are read as one, as a provider takes the roles in turn; a message of calls or results stands alone.
function fitted(kept: readonly StoredTurn[], posted: readonly Message[], maxInputChars: number): Replayed[] {
  const room = maxInputChars - posted.reduce((sum, message) => sum + message.content.length + estimatedChars(message), 0)
  const turns = kept.map((turn, at) => ({ turn, at })).filter(({ turn, at }) => replayed(turn, false, at).length > 0)
  const cost = ({ turn, at }: (typeof turns)[number], shortened: boolean) => charsOf(replayed(turn, shortened, at))
  let total = turns.reduce((sum, item) => sum + cost(item, false), 0)
  let shortened = 0
  let dropped = 0

  // The results of the oldest turns go first, but not those of the last two turns, the latest exchange: past them the oldest turns leave whole, so the newest are the ones kept when the conversation outgrows what the ask takes.
  while (total > room && shortened < turns.length - 2) {
    total += cost(turns[shortened]!, true) - cost(turns[shortened]!, false)
    shortened++
  }

  while (total > room && dropped < turns.length) {
    total -= cost(turns[dropped]!, dropped < shortened)
    dropped++
  }

  const earlier = turns.slice(dropped).map((item, index) => ({ ...item, short: dropped + index < shortened }))
  const first = earlier.findIndex(({ turn }) => turn.role === 'user')
  const messages: Replayed[] = []

  for (const message of [...first === -1 ? [] : earlier.slice(first).flatMap(({ turn, at, short }) => replayed(turn, short, at)), ...posted]) {
    const before = messages.at(-1)

    // The later one keeps its files, and the earlier text comes first.
    if (before?.role === message.role && before.calls === undefined && before.results === undefined)
      messages[messages.length - 1] = { ...message, content: message.content === '' ? before.content : `${before.content}\n\n${message.content}` }
    else
      messages.push(message)
  }

  return messages
}

// A write under way, of a reply asked at `revision`; one that outlives its request names the reply and the turns it stores ahead of it, so a load after a reload shows them and the Chat picks the reply back up.
interface Writing {
  done: Promise<void>
  revision: number
  replying?: { id: string, drop: number, message: StoredTurn } | undefined
}

// The writes under way, by conversation, which a send to it waits for: a Stop closes the stream before the stopped reply is stored, so a send right after it would read the revision before that write.
const writing = new Map<string, Writing>()
// How long a send waits for a write under way, past which it reads the conversation as stored; another tab's reply still running writes later, and this send then meets its 409.
const WRITE_WAIT_MS = 2000
// A reply never read never writes, and leaves its entry until a later send to its conversation replaces it: the oldest go past this many.
const MOST_WRITING = 10_000

const pendingKey = ({ owner, scope, id }: ConversationKey) => `${owner}\0${scope}\0${id}`

async function written(key: string): Promise<void> {
  const write = writing.get(key)?.done

  if (write === undefined)
    return

  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    await Promise.race([write, new Promise<void>((resolve) => {
      timer = setTimeout(resolve, WRITE_WAIT_MS)
    })])
  }
  finally {
    clearTimeout(timer)
  }
}

// Asks with the conversation the Chat posts to: its stored turns, less those a regenerate or an edit replaces, then the posted messages. Once the reply ends the posted messages and the reply are stored, before the reader is told it ended; a revision that moved since the Chat read it is refused with 409, nothing asked.
export function heldReply(call: HeldCall, prompt: Message[], options: AskOptions, maxInputChars: number, make: (messages: Message[]) => Reply): Reply {
  const store = conversationStore()
  let write: ((reply: Reply) => Promise<void>) | undefined

  const target = (async (): Promise<{ reply: Reply }> => {
    const owner = await namedVisitor(call.request, options.key)

    // A Chat that was told the visitor keeps conversations posts its last message alone; with no one named any more, a lapsed session, asking with it alone would drop the conversation, so the Chat is refused and reads that it holds its history again.
    if (owner === undefined || call.id === undefined)
      throw new AiError('conflict', 'the chat posted to a conversation kept on the server, and no visitor is named any more, as when a session lapsed')

    const key: ConversationKey = { owner, scope: scopeOf(call.request), id: call.id }
    const pending = pendingKey(key)

    await written(pending)

    const stored = await store.get(key)
    const revision = stored?.revision ?? 0

    if (revision !== call.revision)
      throw new AiError('conflict', `the conversation is at revision ${revision} and the chat posted to revision ${call.revision}, as another tab wrote to it`)

    const turns = stored?.turns ?? []
    const last = turns.at(-1)?.reply

    // Two tabs sending at once both count the revision the write that won reached: the reply that wrote the last turn tells the one whose write lost.
    if (call.after !== undefined && last !== undefined && last !== call.after)
      throw new AiError('conflict', 'the chat counted a reply whose write another tab won, as both sent at once')

    const drop = Math.min(replacesOf(call.request)?.turns ?? 0, turns.length)
    // The Chat posts its new message alone; anything posted before it is the server's to hold, not the client's to add.
    const posted = prompt.slice(-1)

    const reply = make(fitted(turns.slice(0, turns.length - drop), posted, maxInputChars))
    const done = Promise.withResolvers<void>()
    const started = replyCallOf(call.request)
    const writer = started?.op === 'start' ? started.id : undefined
    const message = posted[0]
    const replying = options.outlive === true && started?.op === 'start' && started.id !== undefined && message !== undefined ? { id: started.id, drop, message: { role: message.role, content: message.content } } : undefined

    writing.delete(pending)
    writing.set(pending, { done: done.promise, revision, replying })

    if (writing.size > MOST_WRITING)
      writing.delete(writing.keys().next().value!)

    write = async (ended) => {
      try {
        await kept(ended, key, revision, drop, posted, options, writer)
      }
      finally {
        done.resolve()

        if (writing.get(pending)?.done === done.promise)
          writing.delete(pending)
      }
    }

    return { reply }
  })()

  return deferredReply(target, { ended: async reply => write?.(reply) })
}

// A call still running when the reply ended has no result to replay.
const isAnswered = (call: ToolCall) => call.status !== 'running' && call.result !== undefined

// A result is kept to this many characters, as the replay of an older one is shortened anyway.
const MOST_STORED_RESULT = 4000

const storedCall = ({ id, name, input, result, status }: ToolCall): StoredCall => ({ id, name, arguments: JSON.stringify(input), result: clip(result ?? '', MOST_STORED_RESULT), ok: status === 'done' })

// The calls a reply made, request by request, and how it finished, none for one that broke off before telling.
async function ending(reply: Reply): Promise<[calls: readonly unknown[], finish: unknown, steps: StoredCall[][]]> {
  try {
    const [calls, finish, steps] = await Promise.all([reply.calls, reply.finish, reply.steps])

    return [calls, finish, steps.map(step => step.calls.filter(isAnswered).map(storedCall)).filter(step => step.length > 0)]
  }
  catch {
    return [[], undefined, []]
  }
}

// Stores the exchange as the Chat shows it: the posted message, and the reply when it said or called anything, a reply cut off by a failure as one stopped. A reply that failed or was stopped before its first word, which the Chat takes back, stores nothing.
// Each turn it adds names the reply that wrote it, which the next send of that Chat names back.
async function kept(reply: Reply, key: ConversationKey, revision: number, drop: number, prompt: readonly Message[], options: AskOptions, writer: string | undefined): Promise<void> {
  let text = ''
  let failed = false

  // Read as it streams, so a reply that broke off keeps the words the Chat showed, whatever the error says of them.
  try {
    for await (const snapshot of reply.stream())
      text = snapshot
  }
  catch {
    failed = true
  }

  const [calls, finish, steps] = await ending(reply)

  if (text === '' && calls.length === 0 && (failed || finish === undefined))
    return

  const sources = text === '' ? [] : usableSources(options.sources)
  const answer: StoredTurn[] = text === '' && calls.length === 0 ? [] : [{ role: 'assistant', content: text, ...steps.length > 0 && { steps }, ...sources.length > 0 && { sources }, ...(failed || finish === undefined) && { stopped: true } }]
  const add: StoredTurn[] = [...prompt.map(({ role, content }) => ({ role, content })), ...answer].map(turn => writer === undefined ? turn : { ...turn, reply: writer })

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
  if ((call.op === 'load' || call.op === 'list') && mayRefund(`${owner}\0${scope}`, Date.now()))
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

  // Read before the store, so a write landing during the read shows as the revision it moved, not as no reply running.
  const under = writing.get(pendingKey(key))
  const stored = await store.get(key)
  const revision = stored?.revision ?? 0
  const turns = (stored?.turns ?? []).map(({ role, content, sources, stopped }) => ({ role, content, ...sources !== undefined && sources.length > 0 && { sources }, ...stopped === true && { stopped } }))

  // A reply still running past its request shows after the turns it stores ahead of it, until its write moves the revision on.
  if (under?.replying !== undefined && under.revision === revision)
    return { owned: true, op: 'load', id: call.id, revision, title: stored?.title ?? '', turns: [...turns.slice(0, turns.length - under.replying.drop), under.replying.message], replying: under.replying.id }

  return { owned: true, op: 'load', id: call.id, revision, title: stored?.title ?? '', turns }
}
