import type { ActionStream, CallOptions } from 'kay'
import type { ChatAction, ChatSessionOptions } from '../src/chat-session'
import type { ConversationAnswer } from '../src/conversation-title'
import type { ChatMessage, Progress } from '../src/types'
import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { ActionError, flush, root, signal } from 'kay'
import { createAttachments } from '../src/chat-attachments'
import { createChatSession } from '../src/chat-session'
import { CONVERSATION_HEADER, REPLACES_HEADER, REPLY_HEADER } from '../src/resume'
import { untilHolds } from './until'

type Status = ReturnType<ActionStream<unknown>['status']>

// A stream the test drives: what it sends and how it ends.
function fakeStream() {
  const status = signal<Status>('open')
  const listeners = new Set<(value: string | Progress) => void>()
  let last: string | Progress | undefined
  const stream: ActionStream<string | Progress> = {
    last: () => last,
    status,
    on: (listener) => {
      listeners.add(listener)

      return () => listeners.delete(listener)
    },
    close: () => status.set('closed'),
  }

  return {
    stream,
    send(value: string | Progress) {
      last = value

      for (const listener of listeners)
        listener(value)
    },
    end(state: 'done' | 'failed') {
      status.set(state)
    },
  }
}

interface Posted {
  messages: ChatMessage[]
  headers: Record<string, string>
}

const SHOWN = 'conv-0001'

// A session holding its conversation on the server: `reads` answers each load, list, rename and remove in turn, `replies` each send.
function chat(reads: ConversationAnswer[], replies: (() => Promise<ActionStream<string | Progress>>)[], options: Partial<ChatSessionOptions> & { shown?: string | undefined } = {}) {
  const posts: Posted[] = []
  const consulted: Posted[] = []
  const conversation = signal<string | undefined>(options.shown)

  const action = (async (input: { messages: ChatMessage[] }, call: CallOptions = {}) => {
    const headers = call.headers ?? {}
    const header = headers[CONVERSATION_HEADER]

    if (header !== undefined && !header.startsWith('send:')) {
      consulted.push({ messages: input.messages, headers })

      const answer = reads.shift()

      if (answer === undefined)
        throw new Error(`no answer left for ${header}`)

      const stream = fakeStream()

      queueMicrotask(() => {
        stream.send(JSON.stringify(answer))
        stream.end('done')
      })

      return stream.stream
    }

    posts.push({ messages: input.messages, headers })

    const next = replies.shift()

    if (next === undefined)
      throw new Error('no reply left')

    return next()
  }) as unknown as ChatAction

  const attachments = createAttachments({ accepts: () => true, maxFiles: 2, maxFileSize: 100, tooBigLabel: '', fullLabel: '', refusedLabel: '' })
  const session = root(() => createChatSession({ action, initial: [], keep: 20, maxChars: 40_000, remember: undefined, errorMessage: 'The reply failed.', attachments, say: call => call.name, focus: () => undefined, follow: () => undefined, conversation, listed: false, conflictMessage: 'Changed elsewhere.', loadFailedMessage: 'Could not load.', ...options }))

  flush()

  return { session, posts, consulted, conversation }
}

const turns = (session: ReturnType<typeof chat>['session']) => session.history().map(({ role, content }) => `${role}: ${content}`)
const loaded = (id: string | undefined, revision: number, stored: [string, string][] = []): ConversationAnswer => ({ owned: true, op: 'load', id, revision, title: '', turns: stored.map(([role, content]) => ({ role: role as 'user' | 'assistant', content })) })

async function replied(text: string) {
  const stream = fakeStream()

  return { stream, answer: async () => stream.stream, finish: () => {
    stream.send(text)
    stream.end('done')
    flush()
  } }
}

beforeEach(() => {
  spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  mock.restore()
})

test('shows the conversation the address names, posts the new message alone and the revision it read, and counts the stored reply', async () => {
  const first = await replied('second answer')
  const second = await replied('third answer')
  const { session, posts, consulted } = chat([loaded(SHOWN, 2, [['user', 'hi'], ['assistant', 'hello']])], [first.answer, second.answer], { shown: SHOWN })

  expect(consulted[0]!.headers[CONVERSATION_HEADER]).toBe(`load:${SHOWN}`)
  await untilHolds(() => !session.loading())
  expect(turns(session)).toEqual(['user: hi', 'assistant: hello'])

  session.draft.set('more')
  await session.send()
  expect(posts[0]!.messages).toEqual([{ role: 'user', content: 'more' }])
  expect(posts[0]!.headers[CONVERSATION_HEADER]).toBe(`send:${SHOWN}:2`)
  first.finish()

  // A regenerate posts the message before the reply alone, replacing both on the server.
  session.regenerate()
  await untilHolds(() => posts.length === 2)
  await Bun.sleep(0)
  expect(posts[1]!.messages).toEqual([{ role: 'user', content: 'more' }])
  expect(posts[1]!.headers[CONVERSATION_HEADER]).toBe(`send:${SHOWN}:3`)
  expect(posts[1]!.headers[REPLACES_HEADER]).toBe('regenerate:2')
  second.finish()
  expect(turns(session)).toEqual(['user: hi', 'assistant: hello', 'user: more', 'assistant: third answer'])
})

test('names a new conversation by its first send, and writes the name to the address', async () => {
  const reply = await replied('answer')
  const { session, posts, conversation } = chat([loaded(undefined, 0)], [reply.answer])

  await untilHolds(() => !session.loading())
  session.draft.set('hi')
  await session.send()

  const id = conversation()

  expect(id).toMatch(/^[\da-f]{32}$/)
  expect(posts[0]!.headers[CONVERSATION_HEADER]).toBe(`send:${id}:0`)
  reply.finish()

  // New conversation leaves the stored one and the address names none.
  session.reset()
  expect(conversation()).toBeUndefined()
  expect(session.history()).toEqual([])
})

test('a send another tab got ahead of puts the message back, reads the conversation again and says why', async () => {
  const { session, posts } = chat([loaded(SHOWN, 1, [['user', 'hi'], ['assistant', 'hello']]), loaded(SHOWN, 3, [['user', 'hi'], ['assistant', 'hello'], ['user', 'elsewhere'], ['assistant', 'there']])], [async () => Promise.reject(new ActionError(409, '', {}))], { shown: SHOWN })

  await untilHolds(() => !session.loading())
  session.draft.set('stale')
  await session.send()
  expect(posts).toHaveLength(1)
  await untilHolds(() => session.history().length === 4)
  expect(turns(session)).toEqual(['user: hi', 'assistant: hello', 'user: elsewhere', 'assistant: there'])
  expect(session.draft()).toBe('stale')
  expect(session.failure()).toBe('Changed elsewhere.')
  expect(session.takenBack()).toBe(true)
})

test('a visitor the server keeps no conversation for posts the whole history, as without keepOnServer', async () => {
  const one = await replied('a1')
  const two = await replied('a2')
  const { session, posts } = chat([{ owned: false }], [one.answer, two.answer])

  await untilHolds(() => session.owned() === false)
  session.draft.set('q1')
  await session.send()
  one.finish()
  session.draft.set('q2')
  await session.send()
  expect(posts[1]!.messages.map(({ content }) => content)).toEqual(['q1', 'a1', 'q2'])
  expect(posts[1]!.headers[CONVERSATION_HEADER]).toBeUndefined()
  expect(posts[1]!.headers[REPLY_HEADER]).toStartWith('start:')
})

test('follows the address to another conversation, as a link of the list or Back takes it', async () => {
  const { session, conversation, consulted } = chat([loaded(SHOWN, 1, [['user', 'a'], ['assistant', 'b']]), loaded('conv-0002', 1, [['user', 'c'], ['assistant', 'd']])], [], { shown: SHOWN })

  await untilHolds(() => session.history().length === 2)
  conversation.set('conv-0002')
  flush()
  expect(consulted[1]!.headers[CONVERSATION_HEADER]).toBe('load:conv-0002')
  await untilHolds(() => turns(session)[0] === 'user: c')

  conversation.set(undefined)
  flush()
  expect(session.history()).toEqual([])
  expect(consulted).toHaveLength(2)
})

test('lists the conversations, moves the one a reply landed in to the top, and renames and deletes them', async () => {
  const reply = await replied('answer')
  const list: ConversationAnswer = { owned: true, op: 'list', conversations: [{ id: 'conv-0002', title: 'older', updatedAt: 1 }, { id: SHOWN, title: 'shown', updatedAt: 0 }] }
  const { session, consulted, conversation } = chat([loaded(SHOWN, 1, [['user', 'a'], ['assistant', 'b']]), list, { owned: true, op: 'rename', id: 'conv-0002', done: true }, { owned: true, op: 'remove', id: SHOWN, done: true }], [reply.answer], { shown: SHOWN, listed: true })

  await untilHolds(() => session.conversations().length === 2)
  session.draft.set('again')
  await session.send()
  reply.finish()
  expect(session.conversations().map(({ id }) => id)).toEqual([SHOWN, 'conv-0002'])

  expect(await session.rename('conv-0002', '  Trip  plans ')).toBe(true)
  expect(consulted[2]!.messages).toEqual([{ role: 'user', content: '  Trip  plans ' }])
  expect(session.conversations()[1]!.title).toBe('Trip plans')

  expect(await session.remove(SHOWN)).toBe(true)
  expect(consulted[3]!.headers[CONVERSATION_HEADER]).toBe(`remove:${SHOWN}`)
  expect(session.conversations().map(({ id }) => id)).toEqual(['conv-0002'])
  expect(conversation()).toBeUndefined()
  expect(session.history()).toEqual([])
})

test('says the conversation could not be loaded when the action answers none', async () => {
  const { session } = chat([], [], { shown: SHOWN })

  await untilHolds(() => !session.loading())
  expect(session.failure()).toBe('Could not load.')
})
