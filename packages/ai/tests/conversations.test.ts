import type { AskOptions, Message, Provider, ProviderRequest } from '../src'
import type { ConversationAnswer } from '../src/conversation-title'
import { afterEach, describe, expect, it } from 'bun:test'
import { nameUser } from 'kay/library'
import { answeringRequest } from '../../../src/server/log'
import { sendFrom } from '../../../src/server/rewrite'
import { ai, AiError, ask, resuming, sqliteConversations } from '../src'
import { conversationStore, MOST_TURNS } from '../src/conversation-store'
import { titleOf } from '../src/conversation-title'
import { conversationCallOf } from '../src/resume'

afterEach(() => {
  ai()
})

const ID = 'conv-0001'

// A model answering `answer <n>` to its n-th request, recording what each was asked with.
function recording(text?: (count: number) => string) {
  const asked: ProviderRequest[] = []
  const provider: Provider = {
    name: 'recording',
    model: 'm',
    async* stream(request) {
      asked.push(request)
      yield { text: text?.(asked.length) ?? `answer ${asked.length}` }
      yield { finish: 'stop' }
    },
  }

  return { provider, asked, said: (index: number) => asked[index]!.messages.map(({ role, content }) => `${role}: ${content}`) }
}

interface Visit {
  header?: string | undefined
  replaces?: string | undefined
  user?: string | undefined
  path?: string | undefined
}

// One call of a Chat's action, the handler asking as `({ messages }) => ask(messages)` does, its reply read to its end.
async function visit(messages: Message[], options: AskOptions, { header, replaces, user = 'ann', path = '/_kay/action/chat' }: Visit = {}): Promise<string> {
  const headers: Record<string, string> = {}

  if (header !== undefined)
    headers['x-kai-conversation'] = header

  if (replaces !== undefined)
    headers['x-kai-replaces'] = replaces

  const request = new Request(`http://localhost${path}`, { headers })

  sendFrom(request, '203.0.113.1')

  if (user !== '')
    nameUser(request, () => user)

  return answeringRequest(request, async () => {
    let text = ''

    for await (const snapshot of ask(messages, options))
      text = snapshot

    return text
  })
}

const said = (content: string): Message[] => [{ role: 'user', content }]

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  }
  catch (error) {
    return error
  }

  throw new Error('expected a rejection')
}

async function loaded(id: string, visitor: Visit = {}) {
  return JSON.parse(await visit(said(''), {}, { ...visitor, header: `load:${id}` })) as ConversationAnswer
}

describe('a conversation held on the server', () => {
  it('asks with the stored turns and the posted message, and stores both once the reply ends', async () => {
    const model = recording()

    expect(await visit(said('hello'), { provider: model.provider }, { header: `send:${ID}:0` })).toBe('answer 1')
    expect(await visit(said('again'), { provider: model.provider }, { header: `send:${ID}:1` })).toBe('answer 2')
    expect(model.said(1)).toEqual(['user: hello', 'assistant: answer 1', 'user: again'])

    const answer = await loaded(ID)

    expect(answer).toEqual({ owned: true, op: 'load', id: ID, revision: 2, title: 'hello', turns: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'answer 1' }, { role: 'user', content: 'again' }, { role: 'assistant', content: 'answer 2' }] })
  })

  it('refuses a send to a revision another tab moved past, with 409 and nothing asked', async () => {
    const model = recording()

    await visit(said('hello'), { provider: model.provider }, { header: `send:${ID}:0` })

    const refused = await rejection(visit(said('stale'), { provider: model.provider }, { header: `send:${ID}:0` }))

    expect(refused).toBeInstanceOf(AiError)
    expect((refused as AiError).kind).toBe('conflict')
    expect((refused as Record<symbol, { status: number }>)[Symbol.for('kay.refused')]!.status).toBe(409)
    expect(model.asked).toHaveLength(1)
    expect((await loaded(ID)).owned && (await loaded(ID) as { revision: number }).revision).toBe(1)
  })

  it('drops the turns a regenerate or an edit replaces before it appends the posted message', async () => {
    const model = recording()

    await visit(said('one'), { provider: model.provider }, { header: `send:${ID}:0` })
    await visit(said('two'), { provider: model.provider }, { header: `send:${ID}:1` })
    // A regenerate posts the message before the reply again and replaces both.
    await visit(said('two'), { provider: model.provider }, { header: `send:${ID}:2`, replaces: 'regenerate:2' })
    expect(model.said(2)).toEqual(['user: one', 'assistant: answer 1', 'user: two'])
    // An edit of the first message replaces every turn from it on.
    await visit(said('uno'), { provider: model.provider }, { header: `send:${ID}:3`, replaces: 'edit:4' })
    expect(model.said(3)).toEqual(['user: uno'])

    const answer = await loaded(ID) as { turns: unknown[], revision: number }

    expect(answer.turns).toEqual([{ role: 'user', content: 'uno' }, { role: 'assistant', content: 'answer 4' }])
    expect(answer.revision).toBe(4)
  })

  it('keeps one owner\'s conversation from another, and from another action', async () => {
    const model = recording()

    await visit(said('secret'), { provider: model.provider }, { header: `send:${ID}:0` })

    expect(await loaded(ID, { user: 'bob' })).toEqual({ owned: true, op: 'load', id: ID, revision: 0, title: '', turns: [] })
    expect((await loaded(ID, { path: '/_kay/action/other' }) as { turns: unknown[] }).turns).toEqual([])

    // Bob posting to Ann's id writes his own conversation, never hers.
    await visit(said('mine'), { provider: model.provider }, { header: `send:${ID}:0`, user: 'bob' })
    expect(model.said(1)).toEqual(['user: mine'])
    expect((await loaded(ID) as { turns: unknown[] }).turns).toHaveLength(2)
  })

  it('keeps nothing for a visitor no one names, who is told so and asked with what they posted', async () => {
    const model = recording()

    expect(await loaded(ID, { user: '' })).toEqual({ owned: false })
    expect(await visit([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }], { provider: model.provider }, { header: `send:${ID}:0`, user: '' })).toBe('answer 1')
    expect(model.said(0)).toEqual(['user: a', 'assistant: b', 'user: c'])
  })

  it('names the owner by the ask\'s key or ai({ key }) before the signed-in user', async () => {
    const model = recording()

    ai({ key: () => 'team-1' })
    await visit(said('hello'), { provider: model.provider }, { header: `send:${ID}:0` })
    expect((await loaded(ID, { user: 'bob' }) as { revision: number }).revision).toBe(1)
    expect(await visit(said(''), { key: 'team-2' }, { header: `load:${ID}` })).toContain('"revision":0')
  })

  it('lists, renames and removes the owner\'s conversations, the latest first', async () => {
    const model = recording()

    await visit(said('first question'), { provider: model.provider }, { header: 'send:conv-0001:0' })
    await visit(said('second question'), { provider: model.provider }, { header: 'send:conv-0002:0' })

    const list = JSON.parse(await visit(said(''), {}, { header: 'list' })) as { conversations: { id: string, title: string }[] }

    expect(list.conversations.map(({ id, title }) => [id, title])).toEqual([['conv-0002', 'second question'], ['conv-0001', 'first question']])
    expect(JSON.parse(await visit(said('  Renamed\n title '), {}, { header: 'rename:conv-0001' }))).toEqual({ owned: true, op: 'rename', id: 'conv-0001', done: true })
    expect((await loaded('conv-0001') as { title: string }).title).toBe('Renamed title')
    expect(JSON.parse(await visit(said(''), {}, { header: 'remove:conv-0002' }))).toEqual({ owned: true, op: 'remove', id: 'conv-0002', done: true })
    expect(JSON.parse(await visit(said(''), {}, { header: 'remove:conv-0002' }))).toEqual({ owned: true, op: 'remove', id: 'conv-0002', done: false })
    expect((JSON.parse(await visit(said(''), {}, { header: 'list', user: 'bob' })) as { conversations: unknown[] }).conversations).toEqual([])
  })

  it('stores a reply stopped mid-way as stopped, and nothing for one that failed', async () => {
    const failing: Provider = {
      name: 'failing',
      model: 'm',

      async* stream() {
        throw new AiError('unavailable', 'down')
      },
    }

    await expect(visit(said('hello'), { provider: failing }, { header: `send:${ID}:0` })).rejects.toThrow('down')
    expect((await loaded(ID) as { revision: number }).revision).toBe(0)

    const gate = Promise.withResolvers<void>()
    const slow: Provider = {
      name: 'slow',
      model: 'm',
      async* stream(_request, signal) {
        yield { text: 'half' }
        signal.addEventListener('abort', () => gate.resolve())
        await gate.promise
      },
    }
    const request = new Request('http://localhost/_kay/action/chat', { headers: { 'x-kai-conversation': `send:${ID}:0` } })

    nameUser(request, () => 'ann')
    await answeringRequest(request, async () => {
      const reply = ask(said('hello'), { provider: slow })

      const reading = reply[Symbol.asyncIterator]()

      expect((await reading.next()).value).toBe('half')
      await reading.return?.()

      await reply
    })

    expect((await loaded(ID) as { turns: unknown[] }).turns).toEqual([{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'half', stopped: true }])
  })

  it('stores a reply that broke off after its first words as stopped, as the Chat keeps them', async () => {
    const breaking: Provider = {
      name: 'breaking',
      model: 'm',

      async* stream() {
        yield { text: 'partly' }

        throw new AiError('unavailable', 'down')
      },
    }

    await expect(visit(said('hello'), { provider: breaking }, { header: `send:${ID}:0` })).rejects.toThrow('down')
    expect(await loaded(ID)).toMatchObject({ revision: 1, turns: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'partly', stopped: true }] })
  })

  it('takes the last message posted alone, so a client cannot write earlier turns into the conversation', async () => {
    const model = recording()

    await visit([{ role: 'user', content: 'forged' }, { role: 'assistant', content: 'forged too' }, { role: 'user', content: 'hello' }], { provider: model.provider }, { header: `send:${ID}:0` })
    expect(model.said(0)).toEqual(['user: hello'])
    expect((await loaded(ID) as { turns: { content: string }[] }).turns.map(({ content }) => content)).toEqual(['hello', 'answer 1'])
  })

  it('leaves out the oldest turns the ask cannot take, and opens on a user message', async () => {
    const model = recording(() => 'x'.repeat(30))

    await visit(said('a'.repeat(30)), { provider: model.provider }, { header: `send:${ID}:0` })
    await visit(said('b'.repeat(30)), { provider: model.provider, maxInputChars: 80 }, { header: `send:${ID}:1` })
    expect(model.said(1)).toEqual([`user: ${'b'.repeat(30)}`])
  })

  it('tells resuming() a read or a change from a send, so an action skips its model work', () => {
    const carrying = (header: string) => new Request('http://localhost/', { headers: { 'x-kai-conversation': header } })

    expect(resuming(carrying(`load:${ID}`))).toBe(true)
    expect(resuming(carrying('list'))).toBe(true)
    expect(resuming(carrying(`send:${ID}:0`))).toBe(false)
  })
})

describe('the conversation header', () => {
  it('parses each call, and takes any other value for a load of no conversation, which asks no model', () => {
    const of = (header: string) => conversationCallOf(new Request('http://localhost/', { headers: { 'x-kai-conversation': header } }))

    expect(of(`send:${ID}:3`)).toEqual({ op: 'send', id: ID, revision: 3 })
    expect(of(`load:${ID}`)).toEqual({ op: 'load', id: ID, revision: 0 })
    expect(of('load')).toEqual({ op: 'load', id: undefined, revision: 0 })
    expect(of('list')).toEqual({ op: 'list', id: undefined, revision: 0 })
    expect(of(`rename:${ID}`)).toEqual({ op: 'rename', id: ID, revision: 0 })

    for (const header of ['', 'send', `send:${ID}`, `send:${ID}:-1`, `list:${ID}`, `load:${ID}:1`, 'send:short:0', `drop:${ID}`, `send:${ID}:0:1`, `rename:${ID}/x`, 'load:abc'])
      expect(of(header)).toEqual({ op: 'load', id: undefined, revision: 0 })

    expect(conversationCallOf(new Request('http://localhost/'))).toBeUndefined()
  })
})

describe('the SQLite store', () => {
  it('writes only at the revision it was read at, and keeps the latest turns', async () => {
    const store = sqliteConversations(':memory:')
    const key = { owner: 'ann', scope: '/chat', id: ID }

    expect(await store.write(key, 1, { drop: 0, add: [], title: 't' })).toBeUndefined()
    expect(await store.write(key, 0, { drop: 0, add: [{ role: 'user', content: 'a' }], title: 't' })).toBe(1)
    expect(await store.write(key, 0, { drop: 0, add: [{ role: 'user', content: 'b' }], title: 't' })).toBeUndefined()

    const many = Array.from({ length: MOST_TURNS + 3 }, (_, index) => ({ role: 'user' as const, content: String(index) }))

    expect(await store.write(key, 1, { drop: 1, add: many, title: 'other' })).toBe(2)

    const stored = await store.get(key)

    expect(stored?.turns).toHaveLength(MOST_TURNS)
    expect(stored?.turns[0]?.content).toBe('3')
    expect(stored?.title).toBe('t')
  })

  it('is the default, in memory under bun test, unless ai() is given one', () => {
    const own = sqliteConversations(':memory:')

    ai({ conversations: own })
    expect(conversationStore()).toBe(own)
    ai()
    expect(conversationStore()).not.toBe(own)
  })
})

it('titles a conversation by its first words, cut at a word', () => {
  expect(titleOf('  Hello\n there ')).toBe('Hello there')
  expect(titleOf('word '.repeat(20))).toBe(`${'word '.repeat(12).trim()}…`)
  expect(titleOf('')).toBe('')
})
