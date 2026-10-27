import type { Piece, Provider } from '../src'
import { afterEach, describe, expect, it } from 'bun:test'
import { s } from 'kay'
import { ask, fakeAi, tool } from '../src'
import { AiError } from '../src/errors'

afterEach(() => fakeAi.clear())

const slow = tool({
  name: 'slow',
  description: 'Takes its time',
  input: s.Object({}),
  run: async () => {
    await Bun.sleep(40)

    return 'done'
  },
})

describe('reply.steps', () => {
  it('lists the one request of a reply without tools, with its tokens and why it stopped', async () => {
    fakeAi.reply('Hello there')

    const reply = ask('Hi')
    const steps = await reply.steps

    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ finish: 'stop', calls: [], usage: await reply.usage })
    expect(steps[0]?.ms).toBeGreaterThanOrEqual(0)
    expect(steps[0]?.firstTokenMs).toBeDefined()
    expect(steps[0]?.firstTokenMs).toBeLessThanOrEqual(steps[0]!.ms)
  })

  it('lists a request per round of a tool loop, each with the calls it made and how long they ran', async () => {
    fakeAi.reply({ calls: [{ name: 'slow' }, { name: 'slow' }] })
    fakeAi.reply('finished')

    const reply = ask('go', { tools: [slow] })
    const steps = await reply.steps
    const calls = await reply.calls

    expect(steps).toHaveLength(2)
    expect(steps[0]?.calls.map(call => call.name)).toEqual(['slow', 'slow'])
    expect(steps[0]?.calls.every(call => (call.ms ?? 0) >= 30)).toBe(true)
    expect(steps[1]?.calls).toEqual([])
    expect(calls.every(call => (call.ms ?? 0) >= 30)).toBe(true)
  })

  it('counts the round a tool loop stopped on at maxSteps, and none of the calls it left unrun', async () => {
    fakeAi.reply({ calls: [{ name: 'slow' }] })
    fakeAi.reply({ calls: [{ name: 'slow' }] })

    const reply = ask('go', { tools: [slow], maxSteps: 2 })
    const steps = await reply.steps

    expect(await reply.finish).toBe('steps')
    expect(steps.map(step => step.calls.length)).toEqual([1, 0])
  })

  it('lists the request a reply was stopped after, with the calls that ran before the stop', async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const gated = tool({
      name: 'gated',
      description: 'Waits for the test',
      input: s.Object({}),
      run: async () => {
        started.resolve()
        await release.promise

        return 'done'
      },
    })

    fakeAi.reply({ calls: [{ name: 'gated' }, { name: 'gated' }] })
    fakeAi.reply('never')

    const reply = ask('go', { tools: [gated] })
    const steps = reply.steps

    await started.promise
    reply.stop()
    release.resolve()

    const [step, ...rest] = await steps

    expect(rest).toEqual([])
    expect(step?.calls.map(call => [call.name, call.status])).toEqual([['gated', 'done']])
    expect(await reply.calls).toEqual(step!.calls)
    expect(fakeAi.asked).toHaveLength(1)
  })

  it('estimates the tokens of each tool-loop request a provider gave no counts for', async () => {
    let asked = 0
    const silent: Provider = {
      name: 'silent',
      model: 'm',
      async* stream(): AsyncGenerator<Piece> {
        asked++

        if (asked === 1)
          yield { toolUse: { id: 'a', name: 'slow', arguments: '{}' } }
        else
          yield { text: 'x'.repeat(40) }
      },
    }

    const reply = ask('y'.repeat(400), { tools: [slow], provider: silent })
    const steps = await reply.steps

    expect(steps.map(step => step.usage?.outputTokens)).toEqual([Math.ceil(('slow'.length + 2) / 4), 10])
    // The second request sends the first again, with its call and result.
    expect(steps[1]!.usage!.inputTokens).toBeGreaterThan(steps[0]!.usage!.inputTokens)
    expect(steps[0]!.usage!.inputTokens).toBeGreaterThanOrEqual(100)
    expect(await reply.usage).toMatchObject({ inputTokens: steps[0]!.usage!.inputTokens + steps[1]!.usage!.inputTokens, outputTokens: 12 })
  })

  it('never rejects when the reply fails, and lists no request that did not end', async () => {
    fakeAi.fail(new AiError('unavailable', 'down'))

    const reply = ask('Hi')

    expect(await reply.steps).toEqual([])
    await expect((async () => reply)()).rejects.toThrow('down')
  })

  it('is on an ask with a schema too', async () => {
    const reply = ask('Hi', { schema: s.Object({ title: s.String() }) })

    await reply

    expect(await reply.steps).toHaveLength(1)
  })
})
