import type { ActionStream, CallOptions } from 'kay'
import type { ChatAction, ChatSessionOptions, TranscribeAction } from '../src/chat-session'
import type { ChatMessage, ChatTurn, Progress } from '../src/types'
import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { ActionError, flush, root, signal } from 'kay'
import { createAttachments } from '../src/chat-attachments'
import { createChatSession } from '../src/chat-session'
import { REPLACES_HEADER, REPLY_HEADER } from '../src/resume'

type Status = ReturnType<ActionStream<unknown>['status']>
type Answer = (signal: AbortSignal) => Promise<ActionStream<string | Progress>>

// A stream the test drives: what it sends and how it ends.
function fakeStream() {
  const status = signal<Status>('open')
  const listeners = new Set<(value: string | Progress) => void>()
  const waiting = new Set<() => void>()

  const settle = (state: Status) => {
    status.set(state)

    for (const then of waiting)
      then()
  }

  const stream: ActionStream<string | Progress> = {
    last: () => undefined,
    status,
    on: (listener) => {
      listeners.add(listener)

      return () => listeners.delete(listener)
    },
    close: () => settle('closed'),
    ended: async () => new Promise((resolve, reject) => {
      const then = () => status() === 'done' ? resolve(undefined) : reject(new Error(`the stream ended ${status()}`))

      if (status() === 'open')
        waiting.add(then)
      else
        then()
    }),
  }

  return {
    stream,
    send(value: string | Progress) {
      for (const listener of listeners)
        listener(value)
    },
    end(state: 'done' | 'failed') {
      settle(state)
    },
  }
}

const answer = (stream: ActionStream<string | Progress>): Answer => async () => stream
const refuse = (status: number, errors: Record<string, string> = {}): Answer => async () => Promise.reject(new ActionError(status, '', errors))
// A call that is still out until it is aborted, as one whose first word has not come.
const hang: Answer = async signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))

interface Posted {
  messages: ChatMessage[]
  headers: Record<string, string>
}

// A session over an action answering each call in turn, a stop's call answered by nothing.
function chat(answers: Answer[], options: Partial<ChatSessionOptions> & { initial?: ChatTurn[] } = {}) {
  const posts: Posted[] = []
  const stops: Posted[] = []
  let focused = 0
  let followed = 0

  const action = (async (input: { messages: ChatMessage[] }, call: CallOptions = {}) => {
    const headers = call.headers ?? {}
    const post = { messages: input.messages, headers }

    if (headers[REPLY_HEADER]?.startsWith('stop:')) {
      stops.push(post)

      return undefined
    }

    posts.push(post)

    const next = answers.shift()

    if (next === undefined)
      throw new Error('no answer left')

    return next(call.signal!)
  }) as unknown as ChatAction

  const attachments = createAttachments({ accepts: file => file.type === 'image/png', maxFiles: 2, maxFileSize: 100, tooBigLabel: 'too big', fullLabel: 'full', refusedLabel: 'refused' })
  const session = root(() => createChatSession({ action, initial: [], keep: 20, maxChars: 40_000, remember: undefined, errorMessage: 'The reply failed.', attachments, say: call => `${call.name}: ${call.status}`, focus: () => focused++, follow: () => followed++, ...options }))

  flush()

  return { session, attachments, posts, stops, focused: () => focused, followed: () => followed }
}

const turns = (session: ReturnType<typeof chat>['session']) => session.history().map(({ role, content }) => `${role}: ${content}`)

// A session storage of a map, as the tests run outside a browser.
function memoryStorage(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries))

  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => map.set(key, value),
    removeItem: (key: string) => map.delete(key),
  } })

  return map
}

// A failed call is logged, which these tests make on purpose.
beforeEach(() => {
  spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  mock.restore()
  Reflect.deleteProperty(globalThis, 'sessionStorage')
})

test('a send posts the draft, shows the reply as it streams and adds it to the history once it ends', async () => {
  const reply = fakeStream()
  const { session, posts, focused, followed } = chat([answer(reply.stream)])

  session.draft.set(' hi ')
  await session.send()

  expect(turns(session)).toEqual(['user: hi'])
  expect(session.draft()).toBe('')
  expect(posts[0]!.messages).toEqual([{ role: 'user', content: 'hi' }])
  expect(posts[0]!.headers[REPLY_HEADER]).toStartWith('start:')
  expect(posts[0]!.headers[REPLACES_HEADER]).toBeUndefined()
  expect(followed()).toBe(1)
  expect(focused()).toBe(1)
  expect(session.busy()).toBe(true)

  reply.send({ text: 'Hel', calls: [{ id: 'c1', name: 'search', input: {}, status: 'running' }], reasoning: 'hmm' })
  expect(session.partial()).toBe('Hel')
  expect(session.thought()).toBe('hmm')
  expect(session.spoken().map(line => line.text)).toEqual(['search: running'])

  reply.send({ text: 'Hello', calls: [{ id: 'c1', name: 'search', input: {}, status: 'done' }], reasoning: 'hmm' })
  reply.end('done')
  flush()

  expect(session.busy()).toBe(false)
  expect(turns(session)).toEqual(['user: hi', 'assistant: Hello'])
  expect(session.history()[1]).toMatchObject({ reasoning: 'hmm', stopped: false })
  expect(session.partial()).toBe('')
  expect(session.calls()).toEqual([])
  expect(session.spoken().map(line => line.text)).toEqual(['search: running', 'search: done'])
})

test('a blank draft sends nothing, and a send while a reply is under way is ignored', async () => {
  const reply = fakeStream()
  const { session, posts } = chat([answer(reply.stream)])

  session.draft.set('  ')
  await session.send()
  expect(posts).toEqual([])

  await session.send('a suggestion')
  await session.send('another')
  expect(posts).toHaveLength(1)
  expect(turns(session)).toEqual(['user: a suggestion'])
})

test('a suggestion leaves the draft and the files as they were', async () => {
  const { session, attachments } = chat([answer(fakeStream().stream)])
  const file = new File(['x'], 'a.png', { type: 'image/png' })

  session.draft.set('typing')
  attachments.add([file])
  await session.send('a suggestion')

  expect(session.draft()).toBe('typing')
  expect(attachments.attached()).toEqual([file])
})

test('a stop before the first word takes the message back to the field with its files, and ends the reply on the server', async () => {
  const { session, attachments, posts, stops } = chat([hang])
  const file = new File(['x'], 'a.png', { type: 'image/png' })

  session.draft.set('hi')
  attachments.add([file])

  const sent = session.send()

  session.draft.set('more')
  session.stop()
  await sent

  expect(turns(session)).toEqual([])
  expect(session.draft()).toBe('hi\nmore')
  expect(attachments.attached()).toEqual([file])
  expect(session.takenBack()).toBe(true)
  expect(session.failure()).toBeUndefined()
  expect(stops).toHaveLength(1)
  expect(stops[0]!.headers[REPLY_HEADER]).toBe(posts[0]!.headers[REPLY_HEADER]!.replace('start:', 'stop:'))
})

test('a stop while the reply streams keeps what arrived, marked stopped, and leaves a reply that does not outlive alone on the server', async () => {
  const reply = fakeStream()
  const { session, stops } = chat([answer(reply.stream)])

  await session.send('hi')
  reply.send('Half')
  session.stop()
  flush()

  expect(turns(session)).toEqual(['user: hi', 'assistant: Half'])
  expect(session.history()[1]!.stopped).toBe(true)
  expect(stops).toEqual([])
})

test('a stop of a reply that outlives its request ends it on the server, whatever it showed', async () => {
  const reply = fakeStream()
  const { session, stops } = chat([answer(reply.stream)])

  await session.send('hi')
  reply.send({ text: 'Half', calls: [], outlives: true })
  session.stop()
  flush()

  expect(stops).toHaveLength(1)
  expect(stops[0]!.messages).toEqual([{ role: 'user', content: 'hi' }])
})

test('a stop with nothing under way only puts the cursor back', () => {
  const { session, stops, focused } = chat([])

  session.stop()

  expect(stops).toEqual([])
  expect(focused()).toBe(1)
})

test('a message the schema refuses goes back to the field and says why, with no Try again', async () => {
  const { session } = chat([refuse(422, { '': 'Too long.' })])

  session.draft.set('hi')
  await session.send()

  expect(turns(session)).toEqual([])
  expect(session.draft()).toBe('hi')
  expect(session.failure()).toBe('Too long.')
  expect(session.takenBack()).toBe(true)
})

test('a failed call keeps the message for Try again, which posts the same history', async () => {
  const reply = fakeStream()
  const { session, posts } = chat([refuse(500), answer(reply.stream)])

  await session.send('hi')

  expect(session.failure()).toBe('The reply failed.')
  expect(turns(session)).toEqual(['user: hi'])
  expect(session.takenBack()).toBe(false)

  await session.retry()
  reply.send('Hello')
  reply.end('done')
  flush()

  expect(posts[1]!.messages).toEqual(posts[0]!.messages)
  expect(session.failure()).toBeUndefined()
  expect(turns(session)).toEqual(['user: hi', 'assistant: Hello'])
})

test('a stream that breaks off says so and keeps what arrived', async () => {
  const reply = fakeStream()
  const { session } = chat([answer(reply.stream)])

  await session.send('hi')
  reply.send('Hal')
  reply.end('failed')
  flush()

  expect(turns(session)).toEqual(['user: hi', 'assistant: Hal'])
  expect(session.failure()).toBe('The reply failed.')
})

test('a 413 posts the history again with fewer turns until the action takes it', async () => {
  const initial: ChatTurn[] = [{ role: 'user', content: 'a'.repeat(200) }, { role: 'assistant', content: 'b'.repeat(200) }]
  const { session, posts } = chat([refuse(413), answer(fakeStream().stream)], { initial })

  await session.send('c')

  expect(posts).toHaveLength(2)
  expect(posts[0]!.messages).toHaveLength(3)
  expect(posts[1]!.messages.length).toBeLessThan(3)
  expect(posts[1]!.messages.at(-1)).toEqual({ role: 'user', content: 'c' })
  expect(session.failure()).toBeUndefined()
})

test('a regenerate drops the last reply and posts what replaces it, and a stop before its first word puts the history back', async () => {
  const initial: ChatTurn[] = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }]
  const { session, posts } = chat([hang], { initial })

  session.regenerate()

  expect(turns(session)).toEqual(['user: q'])
  expect(posts[0]!.headers[REPLACES_HEADER]).toBe('regenerate:2')

  session.stop()
  await Bun.sleep(0)

  expect(turns(session)).toEqual(['user: q', 'assistant: a'])
  expect(session.draft()).toBe('')
})

test('Try again after a failed regenerate posts the same replacement', async () => {
  const initial: ChatTurn[] = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }]
  const { session, posts } = chat([refuse(500), answer(fakeStream().stream)], { initial })

  session.regenerate()
  await Bun.sleep(0)
  await session.retry()

  expect(posts[1]!.headers[REPLACES_HEADER]).toBe('regenerate:2')
})

test('an edit replaces the message and every turn after it, and a stop before the first word puts them back and its text in the field', async () => {
  const initial: ChatTurn[] = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'r' }, { role: 'assistant', content: 'b' }]
  const { session, posts, focused } = chat([hang], { initial })
  const first = session.history()[0]!.id

  expect(session.edit(first, '  q2 ')).toBe('sent')
  expect(focused()).toBe(1)
  expect(turns(session)).toEqual(['user: q2'])
  expect(posts[0]!.headers[REPLACES_HEADER]).toBe('edit:4')
  expect(session.edit(first, 'q3')).toBe('busy')

  session.stop()
  await Bun.sleep(0)

  expect(turns(session)).toEqual(['user: q', 'assistant: a', 'user: r', 'assistant: b'])
  expect(session.draft()).toBe('q2')
})

test('an edit to nothing, or of a message no longer in the history, sends nothing', () => {
  const { session, posts } = chat([], { initial: [{ role: 'user', content: 'q' }] })

  expect(session.edit(session.history()[0]!.id, '  ')).toBe('empty')
  expect(session.edit(99, 'x')).toBe('missing')
  expect(session.edit(undefined, 'x')).toBe('missing')
  expect(posts).toEqual([])
})

test('a reply ending with text forgets what it replaced, so a later take-back keeps the history', async () => {
  const initial: ChatTurn[] = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }]
  const reply = fakeStream()
  const { session } = chat([answer(reply.stream), hang], { initial })

  session.regenerate()
  await Bun.sleep(0)
  reply.send('a2')
  reply.end('done')
  flush()

  const sent = session.send('next')

  session.stop()
  await sent

  expect(turns(session)).toEqual(['user: q', 'assistant: a2'])
  expect(session.draft()).toBe('next')
})

test('a Chat that remembers asks again for the reply a reload cut, and takes the message back when the server kept nothing', async () => {
  const storage = memoryStorage({ 'k': JSON.stringify([{ role: 'user', content: 'q' }]), 'k:reply': 'r1234567' })
  const reply = fakeStream()
  const { session, posts } = chat([answer(reply.stream)], { remember: 'k' })

  await Bun.sleep(0)

  expect(posts[0]!.headers[REPLY_HEADER]).toBe('resume:r1234567')
  expect(posts[0]!.headers[REPLACES_HEADER]).toBeUndefined()

  reply.end('done')
  flush()

  expect(turns(session)).toEqual([])
  expect(session.draft()).toBe('q')
  expect(storage.has('k:reply')).toBe(false)
  expect(storage.get('k')).toBe('[]')
})

test('a Chat that remembers keeps the reply under way until it ends, and drops a pending reply with no message to answer', async () => {
  const storage = memoryStorage({ 'k:reply': 'r1234567' })
  const reply = fakeStream()
  const { session } = chat([answer(reply.stream)], { remember: 'k' })

  expect(storage.has('k:reply')).toBe(false)

  await session.send('hi')
  expect(storage.get('k:reply')).toBeString()

  reply.send('Hello')
  reply.end('done')
  flush()

  expect(storage.has('k:reply')).toBe(false)
  expect(JSON.parse(storage.get('k')!)).toEqual([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hello' }])
})

test('a stream closed while the page is left is settled only once the page stayed', async () => {
  const reply = fakeStream()
  const { session } = chat([answer(reply.stream)])

  await session.send('hi')
  reply.send('Half')
  session.leave()
  reply.stream.close()
  flush()

  expect(session.busy()).toBe(true)
  expect(turns(session)).toEqual(['user: hi'])

  session.back()

  expect(session.busy()).toBe(false)
  expect(turns(session)).toEqual(['user: hi', 'assistant: Half'])
})

test('a reset stops the reply and clears the log, the field, the files and the status', async () => {
  const reply = fakeStream()
  const { session, attachments } = chat([answer(reply.stream)])

  await session.send('hi')
  reply.send({ text: 'Half', calls: [{ id: 'c1', name: 'search', input: {}, status: 'running' }] })
  session.draft.set('typing')
  attachments.add([new File(['x'], 'a.png', { type: 'image/png' })])
  session.reset()
  flush()

  expect(turns(session)).toEqual([])
  expect(session.draft()).toBe('')
  expect(attachments.attached()).toEqual([])
  expect(session.partial()).toBe('')
  expect(session.spoken()).toEqual([])
  expect(session.busy()).toBe(false)
})

// A transcribe reading the recording's bytes as what was said, `refuse` refused as a provider's error would be, and one held until `release` lets it answer.
function transcriber() {
  const { promise: held, resolve: release } = Promise.withResolvers<void>()
  const transcribe = (async ({ audio }: { audio: File }) => {
    const text = await audio.text()

    if (text === 'refuse')
      throw new ActionError(422, '', { '': 'Too noisy.' })

    if (text.startsWith('held '))
      await held

    return text.startsWith('held ') ? text.slice(5) : { text }
  }) as unknown as TranscribeAction

  return { voice: { transcribe, unheardLabel: 'unheard', failedLabel: 'failed' }, release }
}

const said = (text: string) => new File([text], 'recording.webm', { type: 'audio/webm' })

test('what transcribe wrote down joins the field and is sent, and why nothing was sent is answered', async () => {
  const reply = fakeStream()
  const { voice } = transcriber()
  const { session, posts } = chat([answer(reply.stream)], { voice })

  session.draft.set('Say ')

  expect(await session.hear(said('Hello'))).toBeUndefined()

  await Bun.sleep(0)
  expect(posts[0]!.messages).toEqual([{ role: 'user', content: 'Say Hello' }])

  expect([await session.hear(said('  ')), await session.hear(said('refuse'))]).toEqual(['unheard', 'Too noisy.'])
})

test('a transcription finishing after the conversation started over sends nothing and says nothing', async () => {
  const { voice, release } = transcriber()
  const { session, posts } = chat([], { voice })
  const heard = session.hear(said('held Late words'))

  session.reset()
  release()

  expect(await heard).toBeUndefined()
  expect([session.draft(), posts.length]).toEqual(['', 0])
})
