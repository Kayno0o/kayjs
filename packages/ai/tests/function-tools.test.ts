import type { Tools } from './helpers/tools'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { s } from 'kay'
import { testSite } from 'kay/test'
import { ai, ask, fakeAi, tool } from '../src'
import { forgetCounts } from '../src/limits'
import { done } from './fixture/src/testing'

afterEach(() => {
  ai()
  forgetCounts()
  fakeAi.clear()
})

const found: string[] = []

const lookUp = tool({
  name: 'look_up',
  description: 'Looks an article up by its title',
  input: s.Object({ title: s.String({ minLength: 2 }), limit: s.Optional(s.Integer({ minimum: 1, maximum: 5 })) }),
  run: ({ title }) => {
    found.push(title)

    return { title, body: `About ${title}` }
  },
})

describe('function tools outside a request', () => {
  it('shows the label of a function tool on its call', async () => {
    fakeAi.reply({ calls: [{ name: 'look_up', input: { title: 'Moon' } }] })
    fakeAi.reply('ok')

    const labelled = tool({ name: 'look_up', label: 'Looked an article up', description: 'Looks an article up', input: s.Object({ title: s.String() }), run: () => 'found' })
    const calls: string[] = []

    for await (const step of ask('go', { tools: [labelled] }).progress())
      calls.push(...step.calls.map(call => call.label ?? 'none'))

    expect(calls.at(-1)).toBe('Looked an article up')
    expect(fakeAi.asked[0]!.tools![0]).not.toHaveProperty('label')
  })

  it('lets a scheduled ask call a plain function, its result going back to the model as JSON', async () => {
    found.length = 0
    fakeAi.reply({ text: 'Looking. ', calls: [{ name: 'look_up', input: { title: 'Moon' } }] })
    fakeAi.reply(asked => `Got ${asked.messages.at(-1)!.results![0]!.content}`)

    const reply = ask('write the episode', { tools: [lookUp] })

    expect(await reply).toBe('Looking. \n\nGot {"title":"Moon","body":"About Moon"}')
    expect(found).toEqual(['Moon'])
    expect(fakeAi.asked[0]!.tools).toEqual([{ name: 'look_up', description: 'Looks an article up by its title', inputSchema: expect.objectContaining({ type: 'object', required: ['title'] }) }])
  })

  it('runs a tool that writes unasked and never calls confirm, as no visitor is there to hold it', async () => {
    found.length = 0
    fakeAi.reply({ calls: [{ name: 'look_up', input: { title: 'Sun' } }] })
    fakeAi.reply('done')

    const calls: unknown[] = []

    await ask('go', { tools: [lookUp], confirm: (call) => {
      calls.push(call)

      return false
    } })

    expect(calls).toEqual([])
    expect(found).toEqual(['Sun'])
  })

  it('answers the model an input the schema refuses, and runs nothing', async () => {
    found.length = 0
    fakeAi.reply({ calls: [{ name: 'look_up', input: { title: 'x' } }, { name: 'look_up', input: { title: 'Mars', limit: 9 } }] })
    fakeAi.reply('done')

    const reply = ask('go', { tools: [lookUp] })

    await reply

    const results = fakeAi.last()!.messages.at(-1)!.results!

    expect(results.map(result => result.ok)).toEqual([false, false])
    expect(results[0]!.content).toContain('The arguments do not fit the tool')
    expect(found).toEqual([])
  })

  it('tells the model a throwing tool could not run, without what it threw', async () => {
    const broken = tool({ name: 'broken', description: 'Fails', input: s.Object({}), run: () => {
      throw new Error('secret path /etc/x')
    } })

    fakeAi.reply({ calls: [{ name: 'broken' }] })
    fakeAi.reply('done')
    await ask('go', { tools: [broken] })

    expect(fakeAi.last()!.messages.at(-1)!.results).toEqual([{ id: expect.any(String), content: 'The tool could not run', ok: false }])
  })

  it('stops after maxSteps as in a request', async () => {
    fakeAi.reply({ calls: [{ name: 'look_up', input: { title: 'Sun' } }] })
    fakeAi.reply({ calls: [{ name: 'look_up', input: { title: 'Sun' } }] })

    const reply = ask('go', { tools: [lookUp], maxSteps: 2 })

    await reply

    expect(await reply.finish).toBe('steps')
    expect(fakeAi.asked).toHaveLength(2)
  })

  it('counts a job against the key it names and the total, with no visitor', async () => {
    ai({ rateLimit: { max: 1, window: '1m' } })
    fakeAi.reply({ calls: [{ name: 'look_up', input: { title: 'Sun' } }] })
    fakeAi.reply('one')

    await ask('go', { tools: [lookUp], key: 'job' })

    expect(fakeAi.asked).toHaveLength(2)

    let refused: unknown

    try {
      await ask('again', { tools: [lookUp], key: 'job' })
    }
    catch (error) {
      refused = error
    }

    expect(refused).toMatchObject({ kind: 'limited', limit: 'asks' })
  })

  it('refuses a name that is not a model\'s, two tools of one name and a schema that is no object', () => {
    expect(() => tool({ name: 'has space', description: 'x', input: s.Object({}), run: () => '' })).toThrow('tool takes')
    expect(() => tool({ name: 'ok', description: '', input: s.Object({}), run: () => '' })).toThrow('tool takes')
    expect(() => ask('x', { tools: [lookUp, tool({ name: 'look_up', description: 'x', input: s.Object({}), run: () => '' })] })).toThrow('tools[1]')
    expect(() => ask('x', { tools: [tool({ name: 'bad', description: 'x', input: s.String(), run: () => '' })] })).toThrow('object schema')
  })

  it('refuses an input that is no kay schema, and a hand-written tool', () => {
    const handWritten = { name: 'foreign', description: 'x', input: s.Object({}), run: () => '' }

    // @ts-expect-error a hand-written object is no FunctionTool
    expect(() => ask('x', { tools: [handWritten] })).toThrow()
    expect(() => ask('x', { tools: [tool({ name: 'foreign', description: 'x', input: { '~standard': {} } as never, run: () => '' })] })).toThrow('kay schema')
  })

  it('cuts a result past 20,000 characters and hands run the reply\'s signal', async () => {
    const signals: AbortSignal[] = []
    const long = tool({ name: 'long', description: 'Long', input: s.Object({}), run: (_input, { signal }) => {
      signals.push(signal)

      return 'x'.repeat(30_000)
    } })

    fakeAi.reply({ calls: [{ name: 'long' }] })
    fakeAi.reply('done')
    await ask('go', { tools: [long] })

    const content = fakeAi.last()!.messages.at(-1)!.results![0]!.content

    expect(content).toHaveLength(20_000 + '... (cut)'.length)
    expect(signals[0]!.aborted).toBe(false)
  })
})

describe('function tools in a request', () => {
  const site = testSite({ root: join(import.meta.dir, 'fixture') })

  afterAll(async () => (await site).close())
  beforeEach(() => {
    done.length = 0
  })

  it('runs unasked beside an action that confirm holds', async () => {
    const { mixed } = await import(join(import.meta.dir, 'fixture/src/routes/tools.kay')) as Tools

    fakeAi.reply({ calls: [{ name: 'add_note', input: { title: 'Milk' } }, { name: 'stamp' }] })
    fakeAi.reply('ok')

    const steps = await (await site).call(mixed, { prompt: 'go' })

    expect(steps.at(-1)!.calls).toMatchObject([{ name: 'add_note', status: 'failed' }, { name: 'stamp', status: 'done', result: 'stamped' }])
    expect(done).toEqual(['stamp'])
  })

  it('numbers an action named as a function tool, whatever their order', async () => {
    const { mixed } = await import(join(import.meta.dir, 'fixture/src/routes/tools.kay')) as Tools

    fakeAi.reply('ok')
    await (await site).call(mixed, { prompt: 'go', twin: true })

    expect(fakeAi.asked[0]!.tools!.map(spec => spec.name)).toEqual(['add_note', 'add_note_2'])
  })
})
