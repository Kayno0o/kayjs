import type { Piece, Provider } from '../src'
import type { Verdict, Verdicts } from './helpers/structured'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { s } from 'kay'
import { testSite } from 'kay/test'
import { ai, AiError, ask, fakeAi } from '../src'
import { forgetCounts } from '../src/limits'
import { verdict } from './fixture/src/answers'
import { done } from './fixture/src/testing'

const ROOT = join(import.meta.dir, 'fixture')
const site = await testSite({ root: ROOT })
const { summarize, triage, whole, outcome } = await import(join(ROOT, 'src/routes/verdicts.kay')) as Verdicts
const { testing } = await import(join(ROOT, 'src/testing')) as typeof import('./fixture/src/testing')

const answer: Verdict = { title: 'Hello world', score: 4.5, tags: ['a', 'bc'], author: { name: 'Alice' } }

afterAll(async () => site.close())
beforeEach(() => {
  done.length = 0
  forgetCounts()
})
afterEach(() => {
  ai()
  forgetCounts()
  fakeAi.clear()
  testing.provider = undefined
})

async function failure(reply: PromiseLike<unknown>): Promise<AiError> {
  try {
    await reply
  }
  catch (error) {
    expect(error).toBeInstanceOf(AiError)

    return error as AiError
  }

  throw new Error('the reply did not fail')
}

async function snapshots<T>(reply: AsyncIterable<T>): Promise<T[]> {
  const seen: T[] = []

  for await (const part of reply)
    seen.push(part)

  return seen
}

// A provider saying these pieces of text one by one, a beat apart so a reader sees each.
function typing(...texts: string[]): Provider {
  return {
    name: 'typing',
    model: 'm',
    async* stream(_request, signal): AsyncGenerator<Piece> {
      for (const text of texts) {
        if (signal.aborted)
          return

        yield { text }
        await Bun.sleep(4)
      }

      yield { usage: { inputTokens: 3, outputTokens: 7 } }
      yield { finish: 'stop' }
    },
  }
}

describe('ask with a schema', () => {
  it('answers the value the schema describes, typed with no cast', async () => {
    fakeAi.reply({ data: answer })

    const reply = ask('Review it', { schema: verdict })
    const value = await reply
    const title: string = value.title
    const name: string = value.author.name
    const tags: string[] = value.tags

    // @ts-expect-error a field the schema does not have
    expect(value.missing).toBeUndefined()
    expect([title, name, tags]).toEqual(['Hello world', 'Alice', ['a', 'bc']])
    expect(value).toEqual(answer)
    expect(await reply.finish).toBe('stop')
    expect(await reply.usage).toMatchObject({ outputTokens: expect.any(Number) })
  })

  it('streams the object through stream(), which an async function returns as it is', async () => {
    fakeAi.reply({ data: answer })

    const returned = await (async () => ask('Review it', { schema: verdict }).stream())()
    const seen: unknown[] = []

    expect('then' in returned).toBe(false)

    for await (const value of returned)
      seen.push(value)

    expect(seen.at(-1)).toEqual(answer)
  })

  it('still answers text when there is no schema', async () => {
    const text: string = await ask('x')

    expect(text).toBe('Fake reply to: x')
  })

  it('hands the provider the schema as JSON Schema, without kay\'s own marks', async () => {
    fakeAi.reply({ data: answer })
    await ask('x', { schema: verdict })

    expect(fakeAi.last()!.schema).toEqual({
      type: 'object',
      properties: {
        title: { type: 'string' },
        score: { type: 'number' },
        tags: { type: 'array', items: { type: 'string' } },
        author: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      },
      required: ['title', 'score', 'tags', 'author'],
    })
    expect(fakeAi.last()!.tools).toBeUndefined()
  })

  it('asks for an object: a schema of any other shape throws at the call', () => {
    expect(() => ask('x', { schema: s.String() as never })).toThrow(TypeError)
    expect(() => ask('x', { schema: s.Array(s.String()) as never })).toThrow('s.Object')
    expect(() => ask('x', { schema: {} as never })).toThrow(TypeError)
  })

  it('refuses a record or an intersection, which a model would be told is empty', () => {
    expect(() => ask('x', { schema: s.Object({ scores: s.Record(s.String(), s.Number()) }) })).toThrow('s.Record')
    expect(() => ask('x', { schema: s.Intersect([s.Object({ a: s.String() }), s.Object({ b: s.String() })]) })).toThrow('s.Intersect')
  })

  it('types a choice as the string it grows into while it streams', async () => {
    const shape = s.Object({ label: s.UnionEnum(['spam', 'ham']) })
    const labels: (string | undefined)[] = []

    for await (const part of ask('x', { schema: shape, provider: typing('{"label":"sp', 'am"}') })) {
      // @ts-expect-error a snapshot's choice may be a prefix of one
      const narrow: 'spam' | 'ham' | undefined = part.label

      labels.push(narrow)
    }

    expect(labels).toEqual(['sp', 'spam'])
  })

  it('answers the value of a schema with optional fields, a number only a whole one and a choice', async () => {
    const shape = s.Object({ kind: s.UnionEnum(['bug', 'feature']), count: s.Integer({ minimum: 0 }), note: s.Optional(s.String()) })

    fakeAi.reply({ data: { kind: 'bug', count: 3 } })

    const value = await ask('x', { schema: shape })
    const kind: 'bug' | 'feature' = value.kind

    expect(kind).toBe('bug')
    expect(value).toEqual({ kind: 'bug', count: 3 })

    fakeAi.reply({ data: { kind: 'bug', count: 2.5 } })
    expect((await failure(ask('x', { schema: shape }))).fields).toEqual(['count'])
    fakeAi.reply({ data: { kind: 'other', count: 1 } })
    expect((await failure(ask('x', { schema: shape }))).fields).toEqual(['kind'])
  })
})

describe('an answer the schema refuses', () => {
  it('fails with a schema error naming the missing field, not a parse error', async () => {
    fakeAi.reply({ data: { title: 'x', tags: [], author: { name: 'a' } } })

    const error = await failure(ask('x', { schema: verdict }))

    expect(error.kind).toBe('schema')
    expect(error.fields).toEqual(['score'])
    expect(error.message).toContain('score')
    expect(JSON.parse(error.partial!)).toEqual({ title: 'x', tags: [], author: { name: 'a' } })
    expect(error).not.toBeInstanceOf(SyntaxError)
  })

  it('names a field of the wrong type by its path, nested ones and array items included', async () => {
    fakeAi.reply({ data: { title: 'x', score: '4', tags: ['a', 2], author: { name: 7 } } })

    const error = await failure(ask('x', { schema: verdict }))

    expect(error.kind).toBe('schema')
    expect([...error.fields!].sort()).toEqual(['author.name', 'score', 'tags[1]'])
    expect(error.message).toContain('author.name')
  })

  it('refuses a field the schema bounds', async () => {
    const bounded = s.Object({ stars: s.Integer({ minimum: 1, maximum: 5 }), name: s.String({ minLength: 3 }) })

    fakeAi.reply({ data: { stars: 9, name: 'ab' } })
    expect([...(await failure(ask('x', { schema: bounded }))).fields!].sort()).toEqual(['name', 'stars'])
  })

  it('fails when the model wraps the JSON in text', async () => {
    fakeAi.reply('Sure! Here it is: {"title":"x"}')

    const error = await failure(ask('x', { schema: verdict }))

    expect(error.kind).toBe('schema')
    expect(error.fields).toEqual([])
    expect(error.message).toContain('JSON')
    expect(error.partial).toBe('Sure! Here it is: {"title":"x"}')
  })

  it('fails on an answer that is no object, an empty one included', async () => {
    fakeAi.reply('[1,2]')
    expect((await failure(ask('x', { schema: verdict }))).kind).toBe('schema')
    fakeAi.reply('"text"')
    expect((await failure(ask('x', { schema: verdict }))).kind).toBe('schema')
    fakeAi.reply('')
    expect((await failure(ask('x', { schema: verdict }))).kind).toBe('schema')
    fakeAi.reply('null')
    expect((await failure(ask('x', { schema: verdict }))).kind).toBe('schema')
  })

  it('says a reply cut by maxTokens was cut, with what came as the partial, and still reports why it ended', async () => {
    fakeAi.reply({ text: '{"title":"Hel', finish: 'length' })

    const reply = ask('x', { schema: verdict, maxTokens: 5 })
    const error = await failure(reply)

    expect(error.kind).toBe('schema')
    expect(error.message).toContain('maxTokens')
    expect(error.partial).toBe('{"title":"Hel')
    expect(await reply.finish).toBe('length')
    expect(await reply.usage).toBeDefined()
  })

  it('says a reply the provider filtered was refused', async () => {
    fakeAi.reply({ text: '', finish: 'filtered' })

    const error = await failure(ask('x', { schema: verdict }))

    expect(error.kind).toBe('schema')
    expect(error.message).toContain('refused')
  })

  it('leaves a failure of the provider as it is', async () => {
    fakeAi.fail(new AiError('unavailable', 'down', { status: 503 }))
    expect((await failure(ask('x', { schema: verdict }))).kind).toBe('unavailable')
  })

  it('fails a streaming reader after the last snapshot', async () => {
    fakeAi.reply({ data: { title: 'x' } })

    const seen: unknown[] = []
    let error: unknown

    try {
      for await (const part of ask('x', { schema: verdict }))
        seen.push(part)
    }
    catch (caught) {
      error = caught
    }

    expect(seen.at(-1)).toEqual({ title: 'x' })
    expect(error).toMatchObject({ kind: 'schema' })
    expect([...(error as AiError).fields!].sort()).toEqual(['author', 'score', 'tags'])
  })

  it('reads nothing a model made up beyond the schema into the value\'s type: extra fields neither fail nor change a valid one', async () => {
    fakeAi.reply({ data: { ...answer, extra: 1 } })
    expect(await ask('x', { schema: verdict })).toMatchObject(answer)
  })
})

describe('streaming a structured reply', () => {
  const pieces = ['{"title":"He', 'llo wor', 'ld","score":', '4.5', ',"tags":["a","b', 'c"],"author":{"name":"Al', 'ice"}}']

  it('gives the partial object so far: strings growing, anything else once complete', async () => {
    const seen = await snapshots(ask('x', { schema: verdict, provider: typing(...pieces) }))

    expect(seen).toEqual([
      { title: 'He' },
      { title: 'Hello wor' },
      { title: 'Hello world' },
      { title: 'Hello world', score: 4.5, tags: ['a', 'b'] },
      { title: 'Hello world', score: 4.5, tags: ['a', 'bc'], author: { name: 'Al' } },
      answer,
    ])
  })

  it('types a snapshot as a partial of the value', async () => {
    for await (const part of ask('x', { schema: verdict, provider: typing(...pieces) })) {
      const title: string | undefined = part.title
      const name: string | undefined = part.author?.name
      const first: string | undefined = part.tags?.[0]

      // @ts-expect-error a snapshot may not have its title yet
      const sure: string = part.title

      expect([title, name, first, sure].length).toBe(4)
    }
  })

  it('ends on the validated value and reads the same answer by await and by for await', async () => {
    const reply = ask('x', { schema: verdict, provider: typing(...pieces) })
    const [seen, value] = await Promise.all([snapshots(reply), reply])

    expect(seen.at(-1)).toEqual(value)
    expect(value).toEqual(answer)
    expect(fakeAi.asked).toHaveLength(0)
  })

  it('sends nothing until it is first read, and asks the provider once however it is read', async () => {
    fakeAi.reply({ data: answer })

    const reply = ask('x', { schema: verdict })

    expect(fakeAi.asked).toHaveLength(0)
    await Promise.all([reply, snapshots(reply), reply.usage])
    expect(fakeAi.asked).toHaveLength(1)
  })

  it('stops the provider when the reader leaves early', async () => {
    let aborted = false
    const slow: Provider = {
      name: 'slow',
      model: 'm',
      async* stream(_request, signal): AsyncGenerator<Piece> {
        signal.addEventListener('abort', () => {
          aborted = true
        })
        yield { text: '{"title":"a' }
        await Bun.sleep(5000)
      },
    }

    const reading = ask('x', { schema: verdict, provider: slow })[Symbol.asyncIterator]()

    expect((await reading.next()).value).toEqual({ title: 'a' })
    await reading.return?.()

    expect(aborted).toBe(true)
  })

  it('stops with stop(), the text received making the failing answer\'s partial', async () => {
    const reply = ask('x', { schema: verdict, provider: typing(...pieces) })

    setTimeout(() => reply.stop(), 6)

    const error = await failure(reply)

    expect(error.kind).toBe('schema')
    expect(error.partial).toStartWith('{"title":"')
  })

  it('streams to an island through an action, a snapshot at a time', async () => {
    testing.provider = typing(...pieces)

    const seen = await site.call(summarize, { prompt: 'go' })

    expect(seen.at(0)).toEqual({ title: 'He' })
    expect(seen.at(-1)).toEqual(answer)
    expect(seen.some(part => part.tags?.length === 2 && part.author === undefined)).toBe(true)
  })

  it('renders in an await block, each snapshot replacing the last, and the checked object at the end', async () => {
    testing.provider = typing(...pieces)

    const page = await site.visit('/verdicts')

    expect(page.settled.html).toContain('Hello world')
    expect(page.settled.html).toContain('<li>bc</li>')
    expect(page.settled.html).not.toContain('The review failed')
  })

  it('shows the catch of an await block when the answer does not fit', async () => {
    fakeAi.reply({ data: { title: 'x' } })

    const page = await site.visit('/verdicts')

    expect(page.settled.html).toContain('The review failed')
  })

  it('answers the whole value from an async handler, which awaits the reply', async () => {
    testing.provider = typing(...pieces)
    expect(await site.call(whole, { prompt: 'go' })).toEqual(answer)
  })

  it('fails the action of a streaming answer the schema refuses', async () => {
    fakeAi.reply({ data: { title: 'x' } })

    const refused = await site.refusal(whole, { prompt: 'go' })

    expect(refused.status).toBe(500)
  })
})

describe('streaming a structured reply that starts over', () => {
  // A step that wrote some text before calling a tool, then the answer of the last step.
  function restarting(...texts: string[]): Provider {
    return {
      name: 'restarting',
      model: 'm',
      async* stream(): AsyncGenerator<Piece> {
        yield { text: 'Let me note that. ' }
        await Bun.sleep(4)
        yield { restart: true }

        for (const text of texts) {
          yield { text }
          await Bun.sleep(4)
        }

        yield { finish: 'stop' }
      },
    }
  }

  it('reads the object of the last step alone, as snapshots start over', async () => {
    const seen = await snapshots(ask('x', { schema: verdict, provider: restarting('{"title":"Hel', 'lo","score":1,"tags":[],"author":{"name":"A"}}') }))

    expect(seen.at(-1)).toEqual({ title: 'Hello', score: 1, tags: [], author: { name: 'A' } })
    expect(seen.some(part => part.title === 'Hel')).toBe(true)
  })

  it('tells a deltas() reader when the text starts over, so its pieces add up to the JSON answered', async () => {
    const reply = ask('x', { schema: verdict, provider: restarting('{"title":"Hel', 'lo","score":1,"tags":[],"author":{"name":"A"}}') })
    let kept = ''

    for await (const piece of reply.deltas({ onRestart: () => {
      kept = ''
    } })) {
      kept += piece
    }

    expect(JSON.parse(kept)).toEqual(await reply)
  })
})

describe('structured replies with tools', () => {
  it('runs the tools and answers the object of the last step, whatever the model said before calling', async () => {
    fakeAi.reply({ text: 'Let me note that. ', calls: [{ name: 'add_note', input: { title: 'Milk' } }] })
    fakeAi.reply({ data: answer })

    const seen = await site.call(triage, { prompt: 'go' })

    expect(done).toEqual(['addNote:Milk'])
    expect(seen.at(-1)).toEqual(answer)
    expect(fakeAi.asked).toHaveLength(2)
    expect(fakeAi.asked[0]!.schema).toBeDefined()
    expect(fakeAi.asked[1]!.schema).toEqual(fakeAi.asked[0]!.schema)
    expect(fakeAi.asked[1]!.messages.at(-1)!.results).toHaveLength(1)
  })

  it('keeps the calls, the usage summed over the steps and the finish reason of the loop', async () => {
    fakeAi.reply({ calls: [{ name: 'add_note', input: { title: 'Milk' } }] })
    fakeAi.reply({ data: answer })

    const result = await site.call(outcome, { prompt: 'go' })

    expect(result.value).toEqual(answer)
    expect(result.calls).toEqual([{ id: 'fake_1', name: 'add_note', input: { title: 'Milk' }, status: 'done', result: expect.stringContaining('Milk') }])
    expect(result.finish).toBe('stop')
    expect(result.usage!.outputTokens).toBeGreaterThan(0)
  })

  it('fails with a schema error naming maxSteps when the model still wants tools after the last step', async () => {
    fakeAi.reply({ calls: [{ name: 'add_note', input: { title: 'Milk' } }] })
    fakeAi.reply({ data: answer })

    const refused = await site.refusal(outcome, { prompt: 'go', maxSteps: 1 })

    expect(refused.status).toBe(500)
    expect(fakeAi.asked).toHaveLength(1)
    expect(done).toEqual([])
  })

  it('holds the loop\'s limits: a call past maxSteps is not run and a refused answer after the tools still fails', async () => {
    fakeAi.reply({ calls: [{ name: 'add_note', input: { title: 'Milk' } }] })
    fakeAi.reply({ data: { title: 'x' } })

    const refused = await site.refusal(outcome, { prompt: 'go' })

    expect(refused.status).toBe(500)
    expect(done).toEqual(['addNote:Milk'])
  })
})

describe('limits around a structured reply', () => {
  it('refuses the ask past the limit before the provider is called', async () => {
    ai({ rateLimit: { max: 1, window: '1m' } })
    fakeAi.reply({ data: answer })
    await ask('a', { schema: verdict, key: 'v' })

    const error = await failure(ask('b', { schema: verdict, key: 'v' }))

    expect(error.kind).toBe('limited')
    expect(fakeAi.asked).toHaveLength(1)
  })

  it('counts the tokens of a structured reply against the budget', async () => {
    ai({ budget: { tokens: 5, window: '1m' } })
    fakeAi.reply({ data: answer })
    await ask('a', { schema: verdict, key: 'v' })

    expect((await failure(ask('b', { schema: verdict, key: 'v' }))).limit).toBe('budget')
  })

  it('counts the tokens of a reply whose answer the schema refuses', async () => {
    ai({ budget: { tokens: 5, window: '1m' } })
    fakeAi.reply({ data: { title: 'x' } })
    expect((await failure(ask('a', { schema: verdict, key: 'v' }))).kind).toBe('schema')
    expect((await failure(ask('b', { schema: verdict, key: 'v' }))).limit).toBe('budget')
  })

  it('refuses messages past maxInputChars with too-long, to await and for await alike, before the provider', async () => {
    expect((await failure(ask('x'.repeat(30), { schema: verdict, maxInputChars: 10 }))).kind).toBe('too-long')

    const error = await failure(snapshots(ask('x'.repeat(30), { schema: verdict, maxInputChars: 10 })))

    expect(error.kind).toBe('too-long')
    expect(fakeAi.asked).toHaveLength(0)
  })

  it('throws at the call for a maxInputChars that is no number', () => {
    expect(() => ask('x', { schema: verdict, maxInputChars: 0 })).toThrow(TypeError)
  })
})

describe('the fake answering a schema', () => {
  it('sends a scripted object as JSON in pieces', async () => {
    fakeAi.reply({ data: answer })

    const pieces: string[] = []

    for await (const text of ask('x', { schema: verdict }).deltas())
      pieces.push(text)

    expect(pieces.length).toBeGreaterThan(1)
    expect(JSON.parse(pieces.join(''))).toEqual(answer)
  })

  it('takes a function reading what was asked', async () => {
    fakeAi.reply(asked => ({ data: { ...answer, title: `${asked.messages.length} message` } }))
    expect((await ask('x', { schema: verdict })).title).toBe('1 message')
  })

  it('answers a sample that fits the schema when nothing is scripted, so kay dev needs no key', async () => {
    const rich = s.Object({
      name: s.String({ minLength: 1 }),
      count: s.Integer({ minimum: 2 }),
      ratio: s.Number(),
      ok: s.Boolean(),
      kind: s.UnionEnum(['bug', 'feature']),
      tags: s.Array(s.String()),
      pair: s.Array(s.String(), { minItems: 2 }),
      nested: s.Object({ when: s.String({ format: 'date-time' }), maybe: s.Optional(s.Number()) }),
      either: s.Union([s.Literal('a'), s.Number()]),
    })
    const value = await ask('x', { schema: rich })

    expect(value.kind).toBe('bug')
    expect(value.count).toBeGreaterThanOrEqual(2)
    expect(value.pair).toHaveLength(2)
    expect(value.nested.when).toMatch(/^\d{4}-\d\d-\d\dT/)
  })

  it('keeps the schema of what was asked', async () => {
    await ask('x', { schema: verdict })
    expect(fakeAi.last()!.schema).toMatchObject({ type: 'object', required: ['title', 'score', 'tags', 'author'] })
  })
})
