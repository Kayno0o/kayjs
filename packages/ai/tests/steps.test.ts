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
