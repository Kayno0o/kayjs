import type { AskOptions, Provider } from '../src'
import { afterEach, describe, expect, it } from 'bun:test'
import { answeringRequest } from '../../../src/server/log'
import { ask, fakeAi } from '../src'
import { forgetKept } from '../src/kept'
import { untilHolds } from './until'

afterEach(() => {
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
async function answering(options: AskOptions, headers: Record<string, string> = {}) {
  const controller = new AbortController()
  const request = new Request('http://localhost/chat', { headers, signal: controller.signal })
  const { reply } = await answeringRequest(request, async () => ({ reply: ask('x', options) }))

  return { reply, leave: () => controller.abort() }
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
})
