import type { Asked } from '../src'
import type { Offered } from '../src/loop'
import type { Outcome, Tools } from './helpers/tools'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { encodeCall } from '../../../src/runtime/action'
import { ai, ask, fakeAi } from '../src'
import { forgetCounts } from '../src/limits'
import { converse } from '../src/loop'
import { createReply } from '../src/reply'
import { done } from './fixture/src/testing'

const ROOT = join(import.meta.dir, 'fixture')
const site = await testSite({ root: ROOT })
const { converse: conversing, watch, unconfirmed, refusedTools, upload } = await import(join(import.meta.dir, 'fixture/src/routes/tools.kay')) as Tools

afterAll(async () => site.close())
beforeEach(() => {
  done.length = 0
})
afterEach(() => fakeAi.clear())

async function conversation(prompt = 'go', extra: { maxSteps?: number, offer?: string[] } = {}, headers: Record<string, string> = {}): Promise<Outcome> {
  return site.call(conversing, { prompt, ...extra }, { headers })
}

// The results the model was sent back in the last ask.
function lastResults(): { id: string, content: string, ok: boolean, failed: boolean }[] {
  return fakeAi.last()!.messages.at(-1)!.results!
}

describe('actions as tools', () => {
  it('offers each action by its name and description, and runs the call the model makes as the action', async () => {
    fakeAi.reply({ text: 'Adding. ', calls: [{ name: 'add_note', input: { title: 'Milk' } }] })
    fakeAi.reply(asked => `Added: ${asked.messages.at(-1)!.results![0]!.content}`)

    const outcome = await conversation()

    expect(fakeAi.asked[0]!.tools!.map(tool => tool.name)).toContain('add_note')
    expect(fakeAi.asked[0]!.tools!.find(tool => tool.name === 'add_note')).toMatchObject({ description: 'Add note', inputSchema: { type: 'object', required: ['title'] } })
    expect(done).toEqual(['addNote:Milk'])
    expect(outcome.calls).toEqual([{ id: 'fake_1', name: 'add_note', input: { title: 'Milk' }, status: 'done', result: expect.stringContaining('Milk') }])
    expect(outcome.text).toStartWith('Adding. \n\nAdded: ')
    expect(outcome.finish).toBe('stop')
  })

  it('sums the cache reads and writes of the steps', async () => {
    fakeAi.reply({ calls: [{ name: 'add_note', input: { title: 'Milk' } }], cache: { read: 100, written: 40 } })
    fakeAi.reply({ text: 'done', cache: { read: 140 } })

    expect(await conversation()).toMatchObject({ usage: { cacheReadTokens: 240, cacheWriteTokens: 40 } })
  })

  it('sends the assistant turn that called and the results with it, and sums the tokens of the steps', async () => {
    fakeAi.reply({ calls: [{ name: 'add_note', input: { title: 'Milk' }, id: 'x1' }] })
    fakeAi.reply('Done')

    const outcome = await conversation('please')
    const second = fakeAi.asked[1]!

    expect(second.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user'])
    expect(second.messages[1]!.calls).toEqual([{ id: 'x1', name: 'add_note', arguments: '{"title":"Milk"}' }])
    expect(second.messages[2]!.results).toEqual([{ id: 'x1', content: expect.stringContaining('Milk'), ok: true, failed: false }])
    expect(outcome.usage!.inputTokens).toBe(fakeAi.asked.reduce((sum, asked) => sum + asked.messages.reduce((all, message) => all + Math.ceil(message.content.length / 4) + (message.results ?? []).reduce((n, result) => n + Math.ceil(result.content.length / 4), 0), 0), 0))
  })

  it('offers only the actions passed, so a name the app did not list is unknown to the model', async () => {
    fakeAi.reply({ calls: [{ name: 'wipe', input: { confirm: true } }] })
    fakeAi.reply('ok')

    const outcome = await conversation('go', { offer: ['addNote'] }, { authorization: 'Bearer open' })

    expect(fakeAi.asked[0]!.tools!.map(tool => tool.name)).toEqual(['add_note'])
    expect(outcome.calls[0]).toMatchObject({ status: 'failed', result: expect.stringContaining('There is no tool named "wipe"; the tools are add_note') })
    expect(done).toEqual([])
  })

  it('refuses to offer an action that cannot be a tool, naming its place in the list, before anything is asked', async () => {
    for (const which of ['vetoed', 'upload']) {
      const refused = await site.refusal(refusedTools, { which: which as 'vetoed' })

      expect(refused.status).toBe(500)
    }

    expect(fakeAi.asked).toEqual([])
    expect(() => ask('x', { tools: [conversing, conversing, upload] })).toThrow('tools[2]')
  })

  it('throws outside a request, where there is no visitor to run as', () => {
    expect(() => ask('x', { tools: [] })).not.toThrow()
    expect(() => ask('x', { tools: [conversing] })).toThrow('needs the request being answered')
  })

  it('rejects a maxSteps that is not a whole number of 1 or more', () => {
    for (const maxSteps of [0, -1, 1.5, Number.NaN])
      expect(() => ask('x', { tools: [conversing], maxSteps })).toThrow('maxSteps')
  })
})

describe('what the model gets back when a call goes wrong', () => {
  it('tells it the arguments were not JSON, or not an object, and lets it go on', async () => {
    fakeAi.reply({ calls: [{ name: 'add_note', input: '{"title": ' }, { name: 'add_note', input: '[1]' }, { name: 'add_note', input: 'null' }, { name: 'add_note', input: '"text"' }, { name: 'add_note', input: 'x'.repeat(70_000) }] })
    fakeAi.reply('recovered')

    const outcome = await conversation()

    expect(outcome.text).toEndWith('recovered')
    expect(outcome.calls.map(call => [call.status, call.result, call.input])).toEqual([
      ['failed', 'The arguments are not valid JSON', {}],
      ['failed', 'The arguments must be a JSON object', {}],
      ['failed', 'The arguments must be a JSON object', {}],
      ['failed', 'The arguments must be a JSON object', {}],
      ['failed', 'The arguments are too long', {}],
    ])
    expect(done).toEqual([])
  })

  it('sends the model back its calls with the arguments as an object, so a garbled text never reaches a provider that parses them', async () => {
    fakeAi.reply({ calls: [{ name: 'add_note', input: '{"title": ' }, { name: 'add_note', input: { title: 'Milk' } }, { name: 'add_note', input: 'x'.repeat(70_000) }] })
    fakeAi.reply('ok')

    await conversation()

    expect(fakeAi.asked[1]!.messages[1]!.calls!.map(call => call.arguments)).toEqual(['{}', '{"title":"Milk"}', '{}'])
  })

  it('takes no arguments for an empty string, as a model calling a tool with none writes it', async () => {
    fakeAi.reply({ calls: [{ name: 'limited', input: '' }] })
    fakeAi.reply('ok')

    expect((await conversation()).calls[0]).toMatchObject({ status: 'done', result: 'counted' })
  })

  it('names the fields a schema refused and does not run the action', async () => {
    fakeAi.reply({ calls: [{ name: 'add_note', input: { title: 'x' } }] })
    fakeAi.reply('ok')

    const outcome = await conversation()

    expect(outcome.calls[0]).toMatchObject({ status: 'failed' })
    expect(JSON.parse(outcome.calls[0]!.result!)).toEqual({ status: 422, errors: { title: 'Too short' } })
    expect(done).toEqual([])
  })

  it('answers an unknown tool name without running anything, even a huge one', async () => {
    fakeAi.reply({ calls: [{ name: 'drop_table' }, { name: 'n'.repeat(5000) }, { name: '' }] })
    fakeAi.reply('ok')

    const outcome = await conversation()

    expect(outcome.calls.map(call => call.status)).toEqual(['failed', 'failed', 'failed'])
    expect(outcome.calls[0]!.result).toContain('There is no tool named "drop_table"')
    expect(outcome.calls[1]!.result!.length).toBeLessThan(400)
  })

  it('answers an action that fails, redirects or throws as an error result, without what threw', async () => {
    fakeAi.reply({ calls: [{ name: 'refuses' }, { name: 'sends_away' }, { name: 'breaks' }] })
    fakeAi.reply('ok')

    const outcome = await conversation()

    expect(outcome.calls.map(call => call.status)).toEqual(['failed', 'failed', 'failed'])
    expect(JSON.parse(outcome.calls[0]!.result!)).toMatchObject({ status: 409, data: { reason: 'full' } })
    expect(outcome.calls[1]!.result).toBe('The call ended in a redirect to /, where a page would carry on')
    expect(JSON.stringify(outcome)).not.toContain('boom secret')
    expect(lastResults().map(result => result.ok)).toEqual([false, false, false])
  })

  it('runs a guarded action as the visitor: refused for an anonymous one, done for a signed in one', async () => {
    fakeAi.reply({ calls: [{ name: 'wipe', input: { confirm: true } }] })
    fakeAi.reply('anonymous done')
    fakeAi.reply({ calls: [{ name: 'wipe', input: { confirm: true } }] })
    fakeAi.reply('signed in done')

    const anonymous = await conversation()

    expect(anonymous.calls[0]).toMatchObject({ status: 'failed', result: 'Sign in' })
    expect(done).toEqual([])

    const member = await conversation('go', {}, { authorization: 'Bearer open' })

    expect(member.calls[0]).toMatchObject({ status: 'done' })
    expect(done).toEqual(['wipe'])
  })

  it('applies the rate limit of the action to the calls of a model', async () => {
    fakeAi.reply({ calls: [{ name: 'limited' }, { name: 'limited' }] })
    fakeAi.reply('ok')

    const outcome = await conversation()

    expect(outcome.calls.map(call => call.status)).toEqual(['done', 'failed'])
    expect(JSON.parse(outcome.calls[1]!.result!)).toMatchObject({ status: 429 })
  })

  it('caps the calls of one step and runs the first ones only', async () => {
    fakeAi.reply({ calls: Array.from({ length: 40 }, () => ({ name: 'add_note', input: { title: 'Milk' } })) })
    fakeAi.reply('ok')

    const outcome = await conversation()

    expect(outcome.calls).toHaveLength(17)
    expect(done).toHaveLength(16)
    expect(outcome.calls.at(-1)).toMatchObject({ status: 'failed', result: 'Too many tool calls in one step' })
    expect(outcome.calls.map(call => call.id)).toEqual(Array.from({ length: 17 }, (_, index) => `fake_${index + 1}`))
  })
})

describe('the token budget', () => {
  afterEach(() => {
    ai()
    forgetCounts()
  })

  it('counts the tokens of every step of a loop, not of its last request alone', async () => {
    ai({ budget: { tokens: 20, window: '1m' } })
    // Each step answers 60 characters, 15 tokens: neither passes the budget, the two together do.
    fakeAi.reply({ text: 'y'.repeat(60), calls: [{ name: 'add_note', input: { title: 'Milk' } }] })
    fakeAi.reply('x'.repeat(60))

    expect((await conversation()).usage!.outputTokens).toBe(30)

    const refused = await site.refusal(conversing, { prompt: 'go again' })

    expect(refused.status).toBe(429)
    expect(fakeAi.asked).toHaveLength(2)
  })
})

describe('the loop', () => {
  it('stops at maxSteps with the reply ending as steps, without running the calls it was too late for', async () => {
    for (let index = 0; index < 10; index++)
      fakeAi.reply({ text: `step${index} `, calls: [{ name: 'add_note', input: { title: 'Milk' } }] })

    const outcome = await conversation('go', { maxSteps: 3 })

    expect(fakeAi.asked).toHaveLength(3)
    expect(done).toHaveLength(2)
    expect(outcome.calls).toHaveLength(2)
    expect(outcome.finish).toBe('steps')
    expect(outcome.text).toBe('step0 \n\nstep1 \n\nstep2 ')
    expect(new Set(outcome.calls.map(call => call.id)).size).toBe(2)
  })

  it('runs no call of a step the provider cut short, and ends with why', async () => {
    fakeAi.reply({ calls: [{ name: 'limited', input: '' }], finish: 'length' })
    fakeAi.reply('never')

    const outcome = await conversation()

    expect(outcome).toMatchObject({ calls: [], finish: 'length' })
    expect(fakeAi.asked).toHaveLength(1)

    fakeAi.clear()
    fakeAi.reply({ calls: [{ name: 'limited', input: '' }], finish: 'filtered' })

    expect(await conversation()).toMatchObject({ calls: [], finish: 'filtered' })
  })

  it('makes one request with maxSteps 1, whatever the model wants', async () => {
    fakeAi.reply({ calls: [{ name: 'add_note', input: { title: 'Milk' } }] })

    const outcome = await conversation('go', { maxSteps: 1 })

    expect(fakeAi.asked).toHaveLength(1)
    expect(outcome).toMatchObject({ calls: [], finish: 'steps' })
    expect(done).toEqual([])
  })

  it('makes 5 requests by default', async () => {
    for (let index = 0; index < 9; index++)
      fakeAi.reply({ calls: [{ name: 'add_note', input: { title: 'Milk' } }] })

    await conversation()

    expect(fakeAi.asked).toHaveLength(5)
  })

  it('answers in one request when the model calls nothing, and a model failing mid-loop fails the reply', async () => {
    expect((await conversation('hi')).text).toBe('Fake reply to: hi')
    expect(fakeAi.asked).toHaveLength(1)

    fakeAi.clear()
    fakeAi.reply({ calls: [{ name: 'add_note', input: { title: 'Milk' } }] })
    fakeAi.fail(new Error('down'))

    await expect(conversation()).rejects.toBeDefined()
  })

  it('streams its progress: a call running, then done, with the text', async () => {
    fakeAi.reply({ text: 'Adding. ', calls: [{ name: 'add_note', input: { title: 'Milk' } }, { name: 'slow' }] })
    fakeAi.reply('All done')

    const steps = await site.call(watch, { prompt: 'go' })
    const statuses = steps.map(step => step.calls.map(call => call.status).join())

    expect(statuses).toContain('running')
    expect(statuses).toContain('done,running')
    expect(steps.at(-1)!.calls.map(call => call.status)).toEqual(['done', 'done'])
    expect(steps.at(-1)!.text).toBe('Adding. \n\nAll done')
    expect(steps.every((step, index) => index === 0 || step.text.startsWith(steps[index - 1]!.text))).toBe(true)
  })
})

// The loop alone, over tools that are plain functions, for what an action cannot do on cue.
describe('a visitor leaving mid-loop', () => {
  it('asks no further once the request being answered aborts while a tool runs', async () => {
    const controller = new AbortController()

    fakeAi.reply({ calls: [{ name: 'slow' }, { name: 'add_note', input: { title: 'Milk' } }] })
    fakeAi.reply('never')

    const { headers, body } = encodeCall({ prompt: 'go' })
    const answer = site.handle(new Request(`http://localhost${conversing.url}`, { method: 'POST', headers: { ...headers, origin: 'http://localhost' }, body, signal: controller.signal }))

    await Bun.sleep(60)
    controller.abort()
    await Bun.sleep(250)
    await expect(answer).resolves.toBeDefined()

    expect(done).toEqual(['slow'])
    expect(fakeAi.asked).toHaveLength(1)
  })

  const request = new Request('http://localhost/')

  function offered(call: () => Promise<{ content: { type: 'text', text: string }[] }>): Offered[] {
    return [{ name: 'work', description: 'Works', inputSchema: {}, tool: { name: 'work', description: 'Works', inputSchema: {}, call } }]
  }

  function open(tools: Offered[], steps = 5) {
    return createReply(signal => converse(fakeAi, { messages: [{ role: 'user', content: 'go' }], system: undefined, model: 'fake', maxTokens: 10, temperature: undefined, timeouts: { connect: '5000s', idle: '5000s' } }, tools, steps, request, signal), [])
  }

  it('runs no further call and asks nothing more once stopped while a call ran', async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let ran = 0

    fakeAi.reply({ calls: [{ name: 'work' }, { name: 'work' }] })
    fakeAi.reply('never')

    const reply = open(offered(async () => {
      ran++
      started.resolve()
      await release.promise

      return { content: [{ type: 'text', text: 'ok' }] }
    }))
    const text = Promise.resolve(reply)

    await started.promise
    reply.stop()
    release.resolve()

    expect(await text).toBe('')
    expect(ran).toBe(1)
    expect(fakeAi.asked).toHaveLength(1)
    expect(await reply.finish).toBeUndefined()
  })

  it('asks nothing when it was stopped before the first read', async () => {
    const reply = createReply(signal => converse(fakeAi, { messages: [{ role: 'user', content: 'go' }], system: undefined, model: 'fake', maxTokens: 10, temperature: undefined, timeouts: { connect: '5000s', idle: '5000s' } }, offered(async () => ({ content: [] })), 5, request, signal), [AbortSignal.abort()])

    expect(await reply).toBe('')
    expect(fakeAi.asked).toEqual([])
  })

  it('stops when the reader leaves the progress early', async () => {
    fakeAi.reply({ calls: [{ name: 'work' }] })
    fakeAi.reply('never')

    const reply = open(offered(async () => {
      await Bun.sleep(30)

      return { content: [{ type: 'text', text: 'ok' }] }
    }))

    for await (const step of reply.progress()) {
      if (step.calls.some(call => call.status === 'running'))
        break
    }

    await Bun.sleep(20)

    // The call being answered finished, and no step followed it.
    expect(fakeAi.asked).toHaveLength(1)
    expect(await reply.finish).toBeUndefined()
  })

  it('keeps an action that threw outside the reply: what call() throws is a failed result', async () => {
    fakeAi.reply({ calls: [{ name: 'work' }] })
    fakeAi.reply((asked: Asked) => JSON.stringify(asked.messages.at(-1)!.results))

    const text = await open(offered(async () => {
      throw new Error('private detail')
    }))

    expect(text).toContain('The tool could not run')
    expect(text).not.toContain('private detail')
  })
})

describe('confirm', () => {
  const request = new Request('http://localhost/')
  const base = { messages: [{ role: 'user' as const, content: 'go' }], system: undefined, model: 'fake', maxTokens: 10, temperature: undefined, timeouts: { connect: '5s' as const, idle: '5s' as const } }

  function run(confirm: Parameters<typeof converse>[6], call: () => Promise<{ content: { type: 'text', text: string }[] }>) {
    const tool = { name: 'book', description: 'Books', inputSchema: {}, call }

    return createReply(signal => converse(fakeAi, base, [{ name: 'book', description: 'Books', inputSchema: {}, tool }], 5, request, signal, confirm), [])
  }

  it('runs a call only when confirm answers true, handing it the name, the arguments and the request', async () => {
    const seen: unknown[] = []
    let ran = 0

    fakeAi.reply({ calls: [{ name: 'book', input: { slot: 'ten' } }] })
    fakeAi.reply('done')

    await run((call) => {
      seen.push(call)

      return true
    }, async () => {
      ran++

      return { content: [{ type: 'text', text: 'ok' }] }
    })

    expect(ran).toBe(1)
    expect(seen).toEqual([{ name: 'book', input: { slot: 'ten' }, request }])
  })

  it('tells the model the visitor has not confirmed, and runs nothing, for false and anything but true', async () => {
    for (const confirm of [() => false, () => 'yes' as unknown as boolean]) {
      let ran = 0

      fakeAi.clear()
      fakeAi.reply({ calls: [{ name: 'book' }] })
      fakeAi.reply((asked: Asked) => JSON.stringify(asked.messages.at(-1)!.results))

      const text = await run(confirm, async () => {
        ran++

        return { content: [] }
      })

      expect(ran).toBe(0)
      expect(text).toContain('has not confirmed')
      expect(text).toContain('"failed":true')
    }
  })

  it('is the one ask passes to the loop', async () => {
    fakeAi.reply({ calls: [{ name: 'add_note', input: { title: 'Milk' } }] })
    fakeAi.reply('ok')

    const steps = await site.call(unconfirmed, { prompt: 'go' })

    expect(done).toEqual([])
    expect(steps.at(-1)!.calls).toMatchObject([{ name: 'add_note', status: 'failed' }])
  })

  it('runs nothing when confirm throws', async () => {
    let ran = 0

    fakeAi.reply({ calls: [{ name: 'book' }] })
    fakeAi.reply((asked: Asked) => JSON.stringify(asked.messages.at(-1)!.results))

    const text = await run(async () => Promise.reject(new Error('down')), async () => {
      ran++

      return { content: [] }
    })

    expect(ran).toBe(0)
    expect(text).toContain('"failed":true')
  })
})
