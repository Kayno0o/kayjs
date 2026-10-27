import type { AskOptions, Provider } from '../src'
import { afterEach, describe, expect, it } from 'bun:test'
import { nameUser } from 'kay/library'
import { answeringRequest } from '../../../src/server/log'
import { sendFrom } from '../../../src/server/rewrite'
import { ai, ask, fakeAi } from '../src'
import { forgetKept } from '../src/kept'
import { untilHolds } from './until'

afterEach(() => {
  ai()
  fakeAi.clear()
  forgetKept()
})

// A model that says `one `, waits for `release`, then says `two`; an abort ends it where it stands.
function gated() {
  const gate = Promise.withResolvers<void>()
  const state = { asked: 0, aborted: false }

  const provider: Provider = {
    name: 'gated',
    model: 'm',
    async* stream(_request, signal) {
      state.asked++
      yield { text: 'one ' }

      if (!signal.aborted)
        await Promise.race([gate.promise, new Promise(resolve => signal.addEventListener('abort', resolve))])

      if (signal.aborted) {
        state.aborted = true

        return
      }

      yield { text: 'two' }
      yield { finish: 'stop' }
    },
  }

  return { provider, state, release: gate.resolve }
}

// An ask made while answering a request the test can abort, as an action's handler makes it.
async function answering(options: AskOptions, headers: Record<string, string> = {}, where: { path?: string, visitor?: string, address?: string | null } = {}) {
  const controller = new AbortController()
  const request = new Request(`http://localhost${where.path ?? '/chat'}`, { headers, signal: controller.signal })

  // The address a socket gives; a request with neither it nor a user is told apart from no other.
  if (where.address !== null)
    sendFrom(request, where.address ?? '203.0.113.1')

  if (where.visitor !== undefined)
    nameUser(request, () => where.visitor)

  const { reply } = await answeringRequest(request, async () => ({ reply: ask('x', options) }))

  return { reply, leave: () => controller.abort() }
}

// An action asking twice, as one that moderates a message before it answers does.
async function answeringTwice(first: AskOptions, second: AskOptions, headers: Record<string, string>) {
  const request = new Request('http://localhost/chat', { headers })

  sendFrom(request, '203.0.113.1')

  return answeringRequest(request, async () => ({ first: ask('a', first), second: ask('b', second) }))
}

async function readers(reply: AsyncIterable<string>): Promise<{ seen: string[], ended: Promise<void> }> {
  const seen: string[] = []
  const ended = (async () => {
    for await (const text of reply)
      seen.push(text)
  })()

  await untilHolds(() => seen.length > 0)

  return { seen, ended }
}

describe('a reply that outlives the request being answered', () => {
  it('stops with the request without the option, as before', async () => {
    const model = gated()
    const { reply, leave } = await answering({ provider: model.provider })
    const { seen, ended } = await readers(reply)

    leave()
    model.release()
    await ended

    expect(seen.at(-1)).toBe('one ')
    expect(model.state.aborted).toBe(true)
  })

  it('finishes for a server reader and for the text when the request aborts', async () => {
    const model = gated()
    const { reply, leave } = await answering({ provider: model.provider, outlive: true })
    const { seen, ended } = await readers(reply)

    leave()
    model.release()
    await ended

    expect(seen.at(-1)).toBe('one two')
    expect(await reply).toBe('one two')
    expect(await reply.finish).toBe('stop')
    expect(model.state.aborted).toBe(false)
  })

  it('answers a request that left before the first read', async () => {
    const model = gated()
    const { reply, leave } = await answering({ provider: model.provider, outlive: true })

    leave()
    model.release()

    expect(await reply).toBe('one two')
  })

  it('goes on when a reader leaves early, and reply.stop() still ends it', async () => {
    const model = gated()
    const { reply } = await answering({ provider: model.provider, outlive: true })
    const reading = reply[Symbol.asyncIterator]()

    await reading.next()
    await reading.return?.()
    expect(model.state.aborted).toBe(false)

    reply.stop()
    expect(await reply).toBe('one ')
    expect(model.state.aborted).toBe(true)
  })

  it('still stops with options.signal, also once the request left', async () => {
    const model = gated()
    const controller = new AbortController()
    const { reply, leave } = await answering({ provider: model.provider, outlive: true, signal: controller.signal })

    await readers(reply)
    leave()
    controller.abort()

    expect(await reply).toBe('one ')
    expect(model.state.aborted).toBe(true)
  })
})

describe('resuming a reply by the header a Chat sends', () => {
  const id = 'abcdef12-3456'

  it('hands the reply under way to a later request, asking no provider again', async () => {
    const model = gated()
    const first = await answering({ provider: model.provider, outlive: true }, { 'x-kai-reply': `start:${id}` })
    const { ended } = await readers(first.reply)

    first.leave()

    const second = await answering({ provider: model.provider, outlive: true }, { 'x-kai-reply': `resume:${id}` })
    const resumed = await readers(second.reply)

    model.release()
    await Promise.all([ended, resumed.ended])

    expect(resumed.seen).toEqual(['one ', 'one two'])
    expect(model.state.asked).toBe(1)
  })

  it('hands over the whole text of a reply that finished while nobody read', async () => {
    const model = gated()
    const first = await answering({ provider: model.provider, outlive: true }, { 'x-kai-reply': `start:${id}` })

    await readers(first.reply)
    first.leave()
    model.release()
    await first.reply

    const second = await answering({ provider: model.provider, outlive: true }, { 'x-kai-reply': `resume:${id}` })

    expect(await second.reply).toBe('one two')
    expect(model.state.asked).toBe(1)
  })

  it('ends the reply on a stop, and a later resume finds what came', async () => {
    const model = gated()
    const first = await answering({ provider: model.provider, outlive: true }, { 'x-kai-reply': `start:${id}` })

    await readers(first.reply)
    first.leave()

    expect(await (await answering({ provider: model.provider }, { 'x-kai-reply': `stop:${id}` })).reply).toBe('')
    expect(model.state.aborted).toBe(true)
    expect(await (await answering({ provider: model.provider }, { 'x-kai-reply': `resume:${id}` })).reply).toBe('one ')
  })

  it('ends a reply that is kept after the stop for its id came first', async () => {
    const model = gated()

    expect(await (await answering({ provider: model.provider }, { 'x-kai-reply': `stop:${id}` })).reply).toBe('')

    const first = await answering({ provider: model.provider, outlive: true }, { 'x-kai-reply': `start:${id}` })

    expect(await first.reply).toBe('one ')
    expect(model.state.aborted).toBe(true)
  })

  it('answers nothing, and asks no provider, for an unknown id, a malformed one or an ask that did not outlive', async () => {
    const model = gated()
    const plain = await answering({ provider: model.provider }, { 'x-kai-reply': `start:${id}` })

    await readers(plain.reply)
    plain.leave()
    model.release()
    await plain.reply

    const asked = model.state.asked

    for (const header of [`resume:${id}`, 'resume:nope', 'resume:', `resume:${'a'.repeat(200)}`, 'stop:../etc', 'resume'])
      expect(await (await answering({ provider: model.provider, outlive: true }, { 'x-kai-reply': header })).reply).toBe('')

    expect(model.state.asked).toBe(asked)
  })

  it('ignores a start with a malformed id, so the ask is an ordinary one', async () => {
    const model = gated()
    const { reply, leave } = await answering({ provider: model.provider, outlive: true }, { 'x-kai-reply': 'start:!!' })

    await readers(reply)
    leave()
    model.release()

    expect(await reply).toBe('one two')
  })

  it('keeps the replies of two asks in one action apart, so a resume and a stop reach the right one', async () => {
    const one = gated()
    const two = gated()
    const started = await answeringTwice({ provider: one.provider, outlive: true }, { provider: two.provider, outlive: true }, { 'x-kai-reply': `start:${id}` })

    await Promise.all([readers(started.first), readers(started.second)])

    const again = await answeringTwice({ provider: one.provider, outlive: true }, { provider: two.provider, outlive: true }, { 'x-kai-reply': `resume:${id}` })

    one.release()
    two.release()

    expect(await again.first).toBe('one two')
    expect(await again.second).toBe('one two')
    expect(one.state.asked).toBe(1)
    expect(two.state.asked).toBe(1)

    const stopping = await answeringTwice({ provider: one.provider }, { provider: two.provider }, { 'x-kai-reply': `stop:${id}` })

    expect([await stopping.first, await stopping.second]).toEqual(['', ''])
  })

  it('stops only the ask a stop is for, as each ask has its own key', async () => {
    const one = gated()
    const two = gated()
    const started = await answeringTwice({ provider: one.provider, outlive: true }, { provider: two.provider, outlive: true }, { 'x-kai-reply': `start:${id}` })

    await Promise.all([readers(started.first), readers(started.second)])
    // Only the first ask of the stopping request is made, so only the first reply is stopped.
    await (await answering({ provider: one.provider }, { 'x-kai-reply': `stop:${id}` })).reply
    await untilHolds(() => one.state.aborted)
    two.release()

    expect(await started.second).toBe('one two')
    expect(one.state.aborted).toBe(true)
    expect(two.state.aborted).toBe(false)
  })

  it('gives the empty reply to an id replayed against another action or by another visitor, and does not let them stop it', async () => {
    const model = gated()
    const first = await answering({ provider: model.provider, outlive: true }, { 'x-kai-reply': `start:${id}` }, { path: '/_kay/action/a', visitor: 'ann' })

    await readers(first.reply)
    first.leave()

    for (const where of [{ path: '/_kay/action/b', visitor: 'ann' }, { path: '/_kay/action/a', visitor: 'bob' }]) {
      expect(await (await answering({ provider: model.provider }, { 'x-kai-reply': `resume:${id}` }, where)).reply).toBe('')
      await (await answering({ provider: model.provider }, { 'x-kai-reply': `stop:${id}` }, where)).reply
    }

    await Bun.sleep(20)
    expect(model.state.aborted).toBe(false)
    model.release()

    const own = await answering({ provider: model.provider }, { 'x-kai-reply': `resume:${id}` }, { path: '/_kay/action/a', visitor: 'ann' })

    expect(await own.reply).toBe('one two')
  })

  it('stops by its owner only when the stop came first', async () => {
    const model = gated()

    await (await answering({ provider: model.provider }, { 'x-kai-reply': `stop:${id}` }, { visitor: 'bob' })).reply

    const first = await answering({ provider: model.provider, outlive: true }, { 'x-kai-reply': `start:${id}` }, { visitor: 'ann' })

    await readers(first.reply)
    model.release()

    expect(await first.reply).toBe('one two')
  })

  it('drops finished replies before any still under way when more than 200 are kept', async () => {
    const running = gated()
    const first = await answering({ provider: running.provider, outlive: true }, { 'x-kai-reply': `start:${id}` })

    await readers(first.reply)

    for (let index = 0; index < 205; index++) {
      const done = await answering({ outlive: true }, { 'x-kai-reply': `start:done-${String(index).padStart(4, '0')}` })

      await done.reply
    }

    const again = await answering({ provider: running.provider, outlive: true }, { 'x-kai-reply': `resume:${id}` })
    const seen = await readers(again.reply)

    running.release()
    await seen.ended
    expect(seen.seen.at(-1)).toBe('one two')
    // The oldest finished ones went.
    expect(await (await answering({}, { 'x-kai-reply': 'resume:done-0000' })).reply).toBe('')
    expect(await (await answering({}, { 'x-kai-reply': 'resume:done-0204' })).reply).toBe('Fake reply to: x')
  })

  it('computes no owner for an ordinary ask, so a failing key hook gives no unhandled rejection', async () => {
    const seen: unknown[] = []
    const listener = (reason: unknown) => void seen.push(reason)

    process.on('unhandledRejection', listener)
    ai({ key: async () => Promise.reject(new Error('key hook failed')) })

    try {
      const model = gated()
      const { reply } = await answering({ provider: model.provider }, { 'x-kai-reply': `start:${id}` })

      model.release()
      expect(await reply).toBe('one two')

      // An ask that outlives, and a resume of it, need the owner: a failing hook keeps and finds nothing, still without a rejection.
      const kept = gated()
      const started = await answering({ provider: kept.provider, outlive: true }, { 'x-kai-reply': `start:${id}` })

      kept.release()
      expect(await started.reply).toBe('one two')
      expect(await (await answering({ provider: kept.provider }, { 'x-kai-reply': `resume:${id}` })).reply).toBe('')
      await Bun.sleep(20)
      expect(seen).toEqual([])
    }
    finally {
      process.off('unhandledRejection', listener)
    }
  })

  it('keeps no reply for a visitor with neither a user nor an address', async () => {
    const model = gated()
    const first = await answering({ provider: model.provider, outlive: true }, { 'x-kai-reply': `start:${id}` }, { address: null })

    await readers(first.reply)
    first.leave()

    // Another such visitor, and the same one, find nothing; a visitor with an address does not find it either.
    for (const address of [null, '203.0.113.1']) {
      expect(await (await answering({ provider: model.provider }, { 'x-kai-reply': `resume:${id}` }, { address })).reply).toBe('')
      await (await answering({ provider: model.provider }, { 'x-kai-reply': `stop:${id}` }, { address })).reply
    }

    await Bun.sleep(20)
    expect(model.state.aborted).toBe(false)
  })

  it('keeps no reply for a user the visitor hook does not name nor an address, and still serves a named one', async () => {
    const model = gated()
    const first = await answering({ provider: model.provider, outlive: true }, { 'x-kai-reply': `start:${id}` }, { address: null, visitor: 'ann' })

    await readers(first.reply)
    first.leave()
    model.release()

    expect(await (await answering({ provider: model.provider }, { 'x-kai-reply': `resume:${id}` }, { address: null, visitor: 'ann' })).reply).toBe('one two')
  })
})
