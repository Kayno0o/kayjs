import type { Piece, ProviderRequest } from '../src'
import type { Event } from './helpers/provider'
import type { Tools } from './helpers/tools'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { anthropic, openai } from '../src'
import { done, testing } from './fixture/src/testing'
import { anthropicEvents, openaiEvents, provider, stream } from './helpers/provider'

const site = await testSite({ root: join(import.meta.dir, 'fixture') })
const { converse } = await import(join(import.meta.dir, 'fixture/src/routes/tools.kay')) as Tools
const servers: ReturnType<typeof provider>[] = []

afterAll(async () => {
  await Promise.all([site.close(), ...servers.map(async server => server.stop())])
})
afterEach(() => {
  testing.provider = undefined
  done.length = 0
})

function serve(handle: Parameters<typeof provider>[0]) {
  const server = provider(handle)

  servers.push(server)

  return server
}

async function collect(source: AsyncIterable<Piece>): Promise<Piece[]> {
  const pieces: Piece[] = []

  for await (const piece of source)
    pieces.push(piece)

  return pieces
}

const SPEC = { name: 'add_note', description: 'Add note', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } }
const BASE: ProviderRequest = { messages: [{ role: 'user', content: 'Add milk' }], system: 'Be brief', model: 'm', maxTokens: 50, temperature: undefined, tools: [SPEC] }
const AFTER: ProviderRequest = {
  ...BASE,
  messages: [
    { role: 'user', content: 'Add milk' },
    { role: 'assistant', content: 'Adding.', calls: [{ id: 'c1', name: 'add_note', arguments: '{"title":"Milk"}' }, { id: 'c2', name: 'add_note', arguments: '{bad' }] },
    { role: 'user', content: '', results: [{ id: 'c1', content: '{"id":1}', failed: false }, { id: 'c2', content: 'The arguments are not valid JSON', failed: true }] },
  ],
}

function openaiToolEvents(...chunks: unknown[]): Event[] {
  return [...chunks.map((delta): Event => [undefined, { choices: [{ index: 0, delta, finish_reason: null }] }]), [undefined, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }], [undefined, { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } }], [undefined, '[DONE]']]
}

function anthropicToolEvents(blocks: Event[]): Event[] {
  return [
    ['message_start', { type: 'message_start', message: { usage: { input_tokens: 9, output_tokens: 1 } } }],
    ...blocks,
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } }],
    ['message_stop', { type: 'message_stop' }],
  ]
}

describe('OpenAI tool calls', () => {
  it('offers the tools as functions and sends the calls and their results as the API takes them', async () => {
    const server = serve(() => stream(openaiEvents('ok')).response)

    await collect(openai({ baseUrl: server.url, model: 'm' }).stream(AFTER, new AbortController().signal))

    expect(server.seen[0]!.body.tools).toEqual([{ type: 'function', function: { name: 'add_note', description: 'Add note', parameters: SPEC.inputSchema } }])
    expect(server.seen[0]!.body.messages).toEqual([
      { role: 'system', content: 'Be brief' },
      { role: 'user', content: 'Add milk' },
      { role: 'assistant', content: 'Adding.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'add_note', arguments: '{"title":"Milk"}' } }, { id: 'c2', type: 'function', function: { name: 'add_note', arguments: '{bad' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"id":1}' },
      { role: 'tool', tool_call_id: 'c2', content: 'The arguments are not valid JSON' },
    ])
  })

  it('sends no tools key when none are offered', async () => {
    const server = serve(() => stream(openaiEvents('ok')).response)

    await collect(openai({ baseUrl: server.url, model: 'm' }).stream({ ...BASE, tools: undefined }, new AbortController().signal))

    expect(server.seen[0]!.body).not.toHaveProperty('tools')
  })

  it('joins the argument deltas of each call by index, in order, once the model finished', async () => {
    const server = serve(() => stream(openaiToolEvents(
      { role: 'assistant', content: 'Sure. ' },
      { tool_calls: [{ index: 1, id: 'b', type: 'function', function: { name: 'second', arguments: '' } }] },
      { tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'add_note', arguments: '{"tit' } }] },
      { tool_calls: [{ index: 0, function: { arguments: 'le":"Milk"}' } }] },
      { tool_calls: [{ index: 1, function: { arguments: '{}' } }] },
    )).response)
    const pieces = await collect(openai({ baseUrl: server.url, model: 'm' }).stream(BASE, new AbortController().signal))

    expect(pieces.filter(piece => 'toolUse' in piece)).toEqual([
      { toolUse: { id: 'a', name: 'add_note', arguments: '{"title":"Milk"}' } },
      { toolUse: { id: 'b', name: 'second', arguments: '{}' } },
    ])
    expect(pieces).toContainEqual({ text: 'Sure. ' })
  })

  it('takes a call a server sent whole with no id, and ignores junk in tool_calls', async () => {
    const server = serve(() => stream(openaiToolEvents({ tool_calls: [null, 7, { function: { name: 'add_note', arguments: '{"title":"Milk"}' } }, { index: 'x', function: { name: 5, arguments: {} } }] })).response)
    const pieces = await collect(openai({ baseUrl: server.url, model: 'm' }).stream(BASE, new AbortController().signal))

    expect(pieces.filter(piece => 'toolUse' in piece)).toEqual([
      { toolUse: { id: '', name: 'add_note', arguments: '{"title":"Milk"}' } },
      { toolUse: { id: '', name: '', arguments: '' } },
    ])
  })

  it('starts another call when a server reuses an index for another id, and keeps the arguments of each apart', async () => {
    const server = serve(() => stream(openaiToolEvents(
      { tool_calls: [{ index: 0, id: 'a', function: { name: 'add_note', arguments: '{"title":"A"}' } }] },
      { tool_calls: [{ index: 0, id: 'b', function: { name: 'add_note', arguments: '{"title":"B"}' } }] },
    )).response)
    const pieces = await collect(openai({ baseUrl: server.url, model: 'm' }).stream(BASE, new AbortController().signal))

    expect(pieces.filter(piece => 'toolUse' in piece).map(piece => 'toolUse' in piece && [piece.toolUse.id, piece.toolUse.arguments])).toEqual([['a', '{"title":"A"}'], ['b', '{"title":"B"}']])
  })

  it('stops growing the arguments and the calls it keeps past their caps', async () => {
    const chunk = 'x'.repeat(40_000)
    const many = Array.from({ length: 40 }, (_, index) => ({ tool_calls: [{ index, id: `c${index}`, function: { name: 'add_note', arguments: '{}' } }] }))
    const server = serve(() => stream(openaiToolEvents(
      { tool_calls: [{ index: 100, id: 'big', function: { name: 'add_note', arguments: chunk } }] },
      { tool_calls: [{ index: 100, function: { arguments: chunk } }] },
      { tool_calls: [{ index: 100, function: { arguments: chunk } }] },
      { tool_calls: [{ index: 100, function: { arguments: chunk } }] },
      ...many,
    )).response)
    const uses = (await collect(openai({ baseUrl: server.url, model: 'm' }).stream(BASE, new AbortController().signal))).flatMap(piece => 'toolUse' in piece ? [piece.toolUse] : [])

    expect(uses).toHaveLength(17)
    expect(uses.find(use => use.id === 'big')!.arguments.length).toBeLessThan(130_000)
    expect(uses.find(use => use.id === 'big')!.arguments.length).toBeGreaterThan(65_536)
  })

  it('runs the loop against the server: the call, the action as the visitor, and the result sent back', async () => {
    const server = serve((_request, seen) => {
      const first = (seen.body.messages as { role: string }[]).every(message => message.role !== 'tool')

      return stream(first
        ? openaiToolEvents({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'add_note', arguments: '{"title":' } }] }, { tool_calls: [{ index: 0, function: { arguments: '"Milk"}' } }] })
        : openaiEvents('Added', ' it')).response
    })

    testing.provider = openai({ baseUrl: server.url, model: 'm' })

    const outcome = await site.call(converse, { prompt: 'Add milk' })

    expect(outcome.text).toBe('Added it')
    expect(outcome.calls).toMatchObject([{ id: 'call_a', name: 'add_note', input: { title: 'Milk' }, status: 'done' }])
    expect(outcome.usage).toEqual({ inputTokens: 19, outputTokens: 8 })
    expect(done).toEqual(['addNote:Milk'])
    expect(server.seen).toHaveLength(2)
    expect((server.seen[1]!.body.messages as { role: string, tool_call_id?: string }[]).slice(-2).map(message => [message.role, message.tool_call_id])).toEqual([['assistant', undefined], ['tool', 'call_a']])
  })
})

describe('Anthropic tool use', () => {
  it('offers the tools with input_schema and sends tool_use and tool_result blocks', async () => {
    const server = serve(() => stream(anthropicEvents('ok')).response)

    await collect(anthropic({ apiKey: 'k', baseUrl: server.url, model: 'm' }).stream(AFTER, new AbortController().signal))

    expect(server.seen[0]!.body.tools).toEqual([{ name: 'add_note', description: 'Add note', input_schema: SPEC.inputSchema }])
    expect(server.seen[0]!.body.messages).toEqual([
      { role: 'user', content: 'Add milk' },
      { role: 'assistant', content: [{ type: 'text', text: 'Adding.' }, { type: 'tool_use', id: 'c1', name: 'add_note', input: { title: 'Milk' } }, { type: 'tool_use', id: 'c2', name: 'add_note', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '{"id":1}' }, { type: 'tool_result', tool_use_id: 'c2', content: 'The arguments are not valid JSON', is_error: true }] },
    ])
  })

  it('leaves out the empty text block of an assistant turn that only called', async () => {
    const server = serve(() => stream(anthropicEvents('ok')).response)
    const request = { ...AFTER, messages: [AFTER.messages[0]!, { ...AFTER.messages[1]!, content: '' }, AFTER.messages[2]!] }

    await collect(anthropic({ apiKey: 'k', baseUrl: server.url, model: 'm' }).stream(request, new AbortController().signal))

    expect((server.seen[0]!.body.messages as { content: { type: string }[] }[])[1]!.content.map(block => block.type)).toEqual(['tool_use', 'tool_use'])
  })

  it('leaves out an assistant text that is only whitespace, which the API refuses', async () => {
    const server = serve(() => stream(anthropicEvents('ok')).response)
    const request = { ...AFTER, messages: [AFTER.messages[0]!, { ...AFTER.messages[1]!, content: '\n ' }, AFTER.messages[2]!] }

    await collect(anthropic({ apiKey: 'k', baseUrl: server.url, model: 'm' }).stream(request, new AbortController().signal))

    expect((server.seen[0]!.body.messages as { content: { type: string }[] }[])[1]!.content.map(block => block.type)).toEqual(['tool_use', 'tool_use'])
  })

  it('collects each tool_use block as its arguments stream, and ignores deltas of a block it did not open', async () => {
    const delta = (index: number, partial: string): Event => ['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: partial } }]
    const server = serve(() => stream(anthropicToolEvents([
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'On it. ' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'add_note', input: {} } }],
      delta(1, ''),
      delta(1, '{"title"'),
      delta(9, 'stray'),
      delta(1, ': "Milk"}'),
      ['content_block_stop', { type: 'content_block_stop', index: 1 }],
      ['content_block_stop', { type: 'content_block_stop', index: 9 }],
    ])).response)
    const pieces = await collect(anthropic({ apiKey: 'k', baseUrl: server.url, model: 'm' }).stream(BASE, new AbortController().signal))

    expect(pieces.filter(piece => 'toolUse' in piece)).toEqual([{ toolUse: { id: 'toolu_1', name: 'add_note', arguments: '{"title": "Milk"}' } }])
    expect(pieces).toContainEqual({ text: 'On it. ' })
  })

  it('runs the loop against the server and sums both steps', async () => {
    const server = serve((_request, seen) => {
      const first = (seen.body.messages as { role: string }[]).length === 1

      return stream(first
        ? anthropicToolEvents([
          ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'add_note', input: {} } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"title":"Milk"}' } }],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ])
        : anthropicEvents('Added')).response
    })

    testing.provider = anthropic({ apiKey: 'k', baseUrl: server.url, model: 'm' })

    const outcome = await site.call(converse, { prompt: 'Add milk' })

    expect(outcome.text).toBe('Added')
    expect(outcome.calls).toMatchObject([{ id: 'toolu_1', status: 'done' }])
    expect(outcome.usage).toEqual({ inputTokens: 34, outputTokens: 35 })
    expect(server.seen[1]!.body.messages).toMatchObject([{ role: 'user' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1' }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }] }])
  })
})
