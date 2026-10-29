import type { AskOptions, Message, Provider, ProviderRequest } from '../src'
import type { ConversationAnswer } from '../src/conversation-title'
import { afterEach, describe, expect, it } from 'bun:test'
import { s as schema } from 'kay'
import { nameUser } from 'kay/library'
import { answeringRequest } from '../../../src/server/log'
import { sendFrom } from '../../../src/server/rewrite'
import { ai, AiError, ask, resuming, sqliteConversations, tool } from '../src'
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

// A model that looks a title up when a turn says `look up <title>`, and answers `found <result>` (or nothing for `silent`) once it has the result.
function calling(texts: Record<string, string> = {}) {
  const asked: ProviderRequest[] = []
  const lookup = tool({ name: 'look_up', description: 'Looks an article up', input: schema.Object({ title: schema.String() }), run: ({ title }) => title === 'big' ? 'r'.repeat(200) : `About ${title}` })
  const provider: Provider = {
    name: 'calling',
    model: 'm',
    async* stream(request) {
      asked.push(request)

      const last = request.messages.at(-1)!

      if (last.results !== undefined) {
        const text = texts[last.results[0]!.content] ?? `found ${last.results[0]!.content}`

        if (text !== 'silent')
          yield { text }
      }
      else if (last.content.startsWith('look up')) {
        yield { toolUse: { id: `use-${asked.length}`, name: 'look_up', arguments: JSON.stringify({ title: last.content.slice(8) }) } }
      }
      else {
        yield { text: `answer ${asked.length}` }
      }

      yield { finish: 'stop' }
    },
  }
  const shape = (index: number) => asked[index]!.messages.map(({ role, content, calls, results }) => `${role}: ${content}${calls === undefined ? '' : ` calls ${calls.map(call => `${call.name}${call.arguments}`).join()}`}${results === undefined ? '' : ` results ${results.map(result => result.content).join()}`}`)

  return { provider, asked, tools: [lookup], shape }
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

  it('keeps nothing for a visitor no one names, who is told so, and refuses a send to a kept conversation once no one is, as after a lapsed session', async () => {
    const model = recording()

    expect(await loaded(ID, { user: '' })).toEqual({ owned: false })
    await visit(said('hello'), { provider: model.provider }, { header: `send:${ID}:0` })

    const refused = await rejection(visit(said('next'), { provider: model.provider }, { header: `send:${ID}:1`, user: '' }))

    expect((refused as AiError).kind).toBe('conflict')
    expect(model.asked).toHaveLength(1)
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

  it('keeps the words of a reply broken off by any error, not only one that says what came', async () => {
    const breaking: Provider = {
      name: 'breaking',
      model: 'm',

      async* stream() {
        yield { text: 'partly' }

        throw new TypeError('a bug')
      },
    }

    await expect(visit(said('hello'), { provider: breaking }, { header: `send:${ID}:0` })).rejects.toThrow('a bug')
    expect(await loaded(ID)).toMatchObject({ revision: 1, turns: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'partly', stopped: true }] })
  })

  it('waits for the write of a reply just stopped, so a send right after it reads the revision that write reaches', async () => {
    const store = sqliteConversations(':memory:')
    const model = recording()
    const slow: Provider = {
      name: 'slow',
      model: 'm',
      async* stream(_request, signal) {
        yield { text: 'half' }
        await new Promise(resolve => signal.addEventListener('abort', resolve))
      },
    }

    ai({ conversations: { ...store, write: async (...args) => {
      await Bun.sleep(50)

      return store.write(...args)
    } } })

    const request = new Request('http://localhost/_kay/action/chat', { headers: { 'x-kai-conversation': `send:${ID}:0` } })

    nameUser(request, () => 'ann')
    await answeringRequest(request, async () => {
      const reading = ask(said('hello'), { provider: slow })[Symbol.asyncIterator]()

      expect((await reading.next()).value).toBe('half')
      // The Chat's Stop closes the stream, and its next send goes before the stopped reply is stored.
      void reading.return?.()
    })

    expect(await visit(said('again'), { provider: model.provider }, { header: `send:${ID}:1` })).toBe('answer 1')
    expect(model.said(0)).toEqual(['user: hello', 'assistant: half', 'user: again'])
  })

  it('shows a reply still running past its request after the message it answers, naming it for the Chat to resume, until it is stored', async () => {
    const gate = Promise.withResolvers<void>()
    const slow: Provider = {
      name: 'slow',
      model: 'm',
      async* stream() {
        yield { text: 'half' }
        await gate.promise
        yield { text: ' done' }
        yield { finish: 'stop' }
      },
    }

    async function running(outlive: boolean, reply: string, id: string, revision: number) {
      const controller = new AbortController()
      const request = new Request('http://localhost/_kay/action/chat', { headers: { 'x-kai-conversation': `send:${id}:${revision}`, 'x-kai-reply': `start:${reply}` }, signal: controller.signal })

      sendFrom(request, '203.0.113.1')
      nameUser(request, () => 'ann')
      await answeringRequest(request, async () => {
        const reading = ask(said('second'), { provider: slow, outlive })[Symbol.asyncIterator]()

        expect((await reading.next()).value).toBe('half')
      })

      return { reload: () => controller.abort() }
    }

    // A reply that stops with its request is not one to resume.
    await running(false, 'reply-plain-01', 'conv-plain', 0)
    expect((await loaded('conv-plain') as { replying?: string }).replying).toBeUndefined()

    await visit(said('first'), { provider: recording().provider }, { header: `send:${ID}:0` })

    const page = await running(true, 'reply-outlive-01', ID, 1)

    page.reload()
    expect(await loaded(ID)).toEqual({ owned: true, op: 'load', id: ID, revision: 1, title: 'first', turns: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'answer 1' }, { role: 'user', content: 'second' }], replying: 'reply-outlive-01' })
    expect((await loaded(ID, { user: 'bob' }) as { replying?: string }).replying).toBeUndefined()

    gate.resolve()

    let answer = await loaded(ID)

    for (let tries = 0; 'revision' in answer && answer.revision === 1 && tries < 500; tries++) {
      await Bun.sleep(5)
      answer = await loaded(ID)
    }

    expect(answer).toEqual({ owned: true, op: 'load', id: ID, revision: 2, title: 'first', turns: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'answer 1' }, { role: 'user', content: 'second' }, { role: 'assistant', content: 'half done' }] })
  })

  it('still names a reply running past its request when its write lands while the load reads the store', async () => {
    const store = sqliteConversations(':memory:')
    const gate = Promise.withResolvers<void>()
    const reading = Promise.withResolvers<void>()
    const written = Promise.withResolvers<void>()
    const slow: Provider = {
      name: 'slow',
      model: 'm',
      async* stream() {
        yield { text: 'half' }
        await gate.promise
        yield { text: ' done' }
        yield { finish: 'stop' }
      },
    }
    let held: Promise<void> | undefined

    // A store whose read answers what it read once the test lets it, as one over the network may.
    ai({ conversations: { ...store, get: async (key) => {
      const found = await store.get(key)

      await held

      return found
    }, write: async (...args) => {
      const revision = await store.write(...args)

      written.resolve()

      return revision
    } } })

    const request = new Request('http://localhost/_kay/action/chat', { headers: { 'x-kai-conversation': `send:${ID}:0`, 'x-kai-reply': 'start:reply-race-01' } })

    sendFrom(request, '203.0.113.1')
    nameUser(request, () => 'ann')
    await answeringRequest(request, async () => {
      expect((await ask(said('question'), { provider: slow, outlive: true })[Symbol.asyncIterator]().next()).value).toBe('half')
    })

    held = reading.promise

    const load = loaded(ID)

    gate.resolve()
    await written.promise
    reading.resolve()

    expect(await load).toMatchObject({ revision: 0, turns: [{ role: 'user', content: 'question' }], replying: 'reply-race-01' })
  })

  it('refuses the next send of a tab whose reply lost its write to another tab sending at once, and lets the winner go on', async () => {
    const store = sqliteConversations(':memory:')
    const both = Promise.withResolvers<void>()
    const first = Promise.withResolvers<void>()
    const won = Promise.withResolvers<void>()
    let reads = 0

    // Both tabs read the conversation at revision 0 before either reply is stored.
    ai({ conversations: { ...store, get: async (key) => {
      const found = await store.get(key)

      if (++reads === 2)
        both.resolve()

      await both.promise

      return found
    } } })

    async function send(reply: string, header: string, provider: Provider) {
      const request = new Request('http://localhost/_kay/action/chat', { headers: { 'x-kai-conversation': header, 'x-kai-reply': `start:${reply}` } })

      sendFrom(request, '203.0.113.1')
      nameUser(request, () => 'ann')

      return answeringRequest(request, async () => {
        let text = ''

        for await (const snapshot of ask(said(reply), { provider }))
          text = snapshot

        return text
      })
    }

    const answering = (gate: Promise<void>): Provider => ({
      name: 'gated',
      model: 'm',
      async* stream() {
        await gate
        yield { text: 'answer' }
        yield { finish: 'stop' }
      },
    })

    const winner = send('reply-tab-a1', `send:${ID}:0`, answering(first.promise))
    // The second tab's reply ends once the first one's is stored, so its write is the one refused.
    const loser = send('reply-tab-b1', `send:${ID}:0`, answering(won.promise))

    first.resolve()
    expect(await winner).toBe('answer')
    won.resolve()
    expect(await loser).toBe('answer')

    const model = recording()

    expect(await rejection(visit(said('from b'), { provider: model.provider }, { header: `send:${ID}:1:reply-tab-b1` }))).toBeInstanceOf(AiError)
    expect(await visit(said('from a'), { provider: model.provider }, { header: `send:${ID}:1:reply-tab-a1` })).toBe('answer 1')
    expect(model.asked).toHaveLength(1)
  })

  it('reads two turns of one role as one once an empty turn between them is left out', async () => {
    const model = recording()

    await conversationStore().write({ owner: 'ann', scope: '/_kay/action/chat', id: ID }, 0, { drop: 0, add: [{ role: 'user', content: 'look this up' }, { role: 'assistant', content: '' }], title: '' })
    await visit(said('and then?'), { provider: model.provider }, { header: `send:${ID}:1` })
    expect(model.said(0)).toEqual(['user: look this up\n\nand then?'])
  })

  it('lets a send naming a reply through when the last turn was stored with no reply, as before the store kept one', async () => {
    const model = recording()

    await conversationStore().write({ owner: 'ann', scope: '/_kay/action/chat', id: ID }, 0, { drop: 0, add: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], title: '' })
    expect(await visit(said('c'), { provider: model.provider }, { header: `send:${ID}:1:reply-tab-a1` })).toBe('answer 1')
  })

  it('leaves out the oldest turns the ask cannot take, and opens on a user message', async () => {
    const model = recording(() => 'x'.repeat(30))

    await visit(said('a'.repeat(30)), { provider: model.provider }, { header: `send:${ID}:0` })
    await visit(said('b'.repeat(30)), { provider: model.provider, maxInputChars: 80 }, { header: `send:${ID}:1` })
    expect(model.said(1)).toEqual([`user: ${'b'.repeat(30)}`])
  })

  it('replays the tool calls and results of earlier turns to the model', async () => {
    const model = calling()
    const options = { provider: model.provider, tools: model.tools }

    await visit(said('look up Moon'), options, { header: `send:${ID}:0` })
    await visit(said('and Sun?'), options, { header: `send:${ID}:1` })
    expect(model.shape(2)).toEqual(['user: look up Moon', 'assistant:  calls look_up{"title":"Moon"}', 'user:  results About Moon', 'assistant: found About Moon', 'user: and Sun?'])
    // What a Chat loads is the text alone.
    expect(await loaded(ID)).toMatchObject({ turns: [{ role: 'user', content: 'look up Moon' }, { role: 'assistant', content: 'found About Moon' }, { role: 'user', content: 'and Sun?' }, { role: 'assistant', content: 'answer 3' }] })
  })

  it('replays a turn that only called tools, with a stand-in for its missing text', async () => {
    const model = calling({ 'About Moon': 'silent' })
    const options = { provider: model.provider, tools: model.tools }

    await visit(said('look up Moon'), options, { header: `send:${ID}:0` })
    await visit(said('so?'), options, { header: `send:${ID}:1` })
    expect(model.shape(2)).toEqual(['user: look up Moon', 'assistant:  calls look_up{"title":"Moon"}', 'user:  results About Moon', 'assistant: (no answer was given)', 'user: so?'])
  })

  it('does not take calls or results from the messages an app passes to ask', async () => {
    const model = recording()
    const forged = [{ role: 'assistant', content: 'x', calls: [{ id: 'a', name: 'n', arguments: '{}' }] }, { role: 'user', content: 'y' }] as Message[]

    await visit(forged, { provider: model.provider })
    expect(model.asked[0]!.messages.every(message => (message as { calls?: unknown }).calls === undefined)).toBe(true)
  })

  it('shortens the results of the oldest turns before it drops any turn, and keeps the newest whole', async () => {
    const model = calling({ ['r'.repeat(200)]: 'ok' })
    const options = { provider: model.provider, tools: model.tools }

    await visit(said('look up big'), options, { header: `send:${ID}:0` })
    await visit(said('look up Sun'), options, { header: `send:${ID}:1` })
    await visit(said('why?'), { ...options, maxInputChars: 200 }, { header: `send:${ID}:2` })
    expect(model.shape(4)).toEqual(['user: look up big', 'assistant:  calls look_up{"title":"big"}', 'user:  results (left out)', 'assistant: ok', 'user: look up Sun', 'assistant:  calls look_up{"title":"Sun"}', 'user:  results About Sun', 'assistant: found About Sun', 'user: why?'])
  })

  it('drops the oldest turns whole once shortened results are not enough, never opening on a result', async () => {
    const model = calling()
    const options = { provider: model.provider, tools: model.tools }

    await visit(said('look up Moon'), options, { header: `send:${ID}:0` })
    await visit(said('look up Sun'), options, { header: `send:${ID}:1` })
    await visit(said('why?'), { ...options, maxInputChars: 100 }, { header: `send:${ID}:2` })
    expect(model.shape(4)).toEqual(['user: look up Sun', 'assistant:  calls look_up{"title":"Sun"}', 'user:  results About Sun', 'assistant: found About Sun', 'user: why?'])
  })

  it('drops the calls of the turns a regenerate or an edit replaces', async () => {
    const model = calling()
    const options = { provider: model.provider, tools: model.tools }

    await visit(said('look up Moon'), options, { header: `send:${ID}:0` })
    await visit(said('hello'), options, { header: `send:${ID}:1` })
    await visit(said('hello'), options, { header: `send:${ID}:2`, replaces: 'regenerate:2' })
    expect(model.shape(3)).toEqual(['user: look up Moon', 'assistant:  calls look_up{"title":"Moon"}', 'user:  results About Moon', 'assistant: found About Moon', 'user: hello'])
    await visit(said('uno'), options, { header: `send:${ID}:3`, replaces: 'edit:4' })
    expect(model.shape(4)).toEqual(['user: uno'])
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
    expect(of(`send:${ID}:3:reply-tab-a1`)).toEqual({ op: 'send', id: ID, revision: 3, after: 'reply-tab-a1' })
    expect(of(`load:${ID}`)).toEqual({ op: 'load', id: ID, revision: 0 })
    expect(of('load')).toEqual({ op: 'load', id: undefined, revision: 0 })
    expect(of('list')).toEqual({ op: 'list', id: undefined, revision: 0 })
    expect(of(`rename:${ID}`)).toEqual({ op: 'rename', id: ID, revision: 0 })

    for (const header of ['', 'send', `send:${ID}`, `send:${ID}:-1`, `list:${ID}`, `load:${ID}:1`, 'send:short:0', `drop:${ID}`, `send:${ID}:0:1`, `send:${ID}:0:reply-tab/a1`, `send:${ID}:0:`, `rename:${ID}/x`, 'load:abc'])
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
