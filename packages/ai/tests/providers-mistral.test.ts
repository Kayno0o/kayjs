import type { Piece, ProviderRequest } from '../src'
import type { Event, Seen } from './helpers/provider'
import { afterAll, describe, expect, it } from 'bun:test'
import { AiError, ask, openai } from '../src'
import { openaiEvents, provider, stream } from './helpers/provider'

const servers: ReturnType<typeof provider>[] = []

afterAll(async () => {
  await Promise.all(servers.map(async server => server.stop()))
})

// A stand-in for Mistral: it refuses a parameter it does not list with a 422, and sends usage on the last chunk unasked.
function mistral(events: (seen: Seen) => Event[]) {
  const server = provider((_request, seen) => {
    if ('stream_options' in seen.body)
      return Response.json({ object: 'error', message: { detail: [{ type: 'extra_forbidden', loc: ['body', 'stream_options'], msg: 'Extra inputs are not permitted' }] }, type: 'invalid_request_error', code: null }, { status: 422 })

    return stream(events(seen)).response
  })

  servers.push(server)

  return server
}

function chunks(...deltas: [delta: unknown, finish?: string, usage?: unknown][]): Event[] {
  return [...deltas.map(([delta, finish, usage]): Event => [undefined, { id: 'cmpl', choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...usage === undefined ? {} : { usage } }]), [undefined, '[DONE]']]
}

const USAGE = { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 }

async function collect(source: AsyncIterable<Piece>): Promise<Piece[]> {
  const pieces: Piece[] = []

  for await (const piece of source)
    pieces.push(piece)

  return pieces
}

async function failure(reply: PromiseLike<string>): Promise<unknown> {
  try {
    await reply
  }
  catch (error) {
    return error
  }

  throw new Error('the reply did not fail')
}

const REQUEST: ProviderRequest = { messages: [{ role: 'user', content: 'Add milk' }], system: undefined, model: 'mistral-small-2603', maxTokens: 50, temperature: undefined, timeouts: { connect: '5000s', idle: '5000s' }, tools: [{ name: 'add_note', description: 'Add note', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } }] }

describe('Mistral through the OpenAI-compatible provider', () => {
  it('streams after the server refuses stream_options, counting the usage on the last chunk', async () => {
    const server = mistral(() => chunks([{ role: 'assistant', content: 'Bon' }], [{ content: 'jour' }, 'stop', USAGE]))
    const reply = ask('Hi', { provider: openai({ baseUrl: server.url, apiKey: 'k', model: 'mistral-small-2603' }) })

    expect(await reply).toBe('Bonjour')
    expect(await reply.usage).toEqual({ inputTokens: 9, outputTokens: 4 })
    expect(await reply.finish).toBe('stop')
    expect(server.seen).toHaveLength(2)
    expect(server.seen[0]!.body.stream_options).toEqual({ include_usage: true })
    expect(server.seen[1]!.body).toMatchObject({ model: 'mistral-small-2603', stream: true, max_tokens: 4096 })
    expect('stream_options' in server.seen[1]!.body).toBe(false)
  })

  it('remembers the refusal, so later asks send the request once', async () => {
    const server = mistral(() => chunks([{ content: 'ok' }, 'stop', USAGE]))
    const model = openai({ baseUrl: server.url, model: 'm' })

    await ask('one', { provider: model })
    await ask('two', { provider: openai({ baseUrl: `${server.url}/`, model: 'm' }) })

    expect(server.seen).toHaveLength(3)
    expect('stream_options' in server.seen[2]!.body).toBe(false)
  })

  it('fails with the error of the request when the retry fails too', async () => {
    const server = provider(() => Response.json({ error: { message: 'unknown model' } }, { status: 422 }))

    servers.push(server)

    const error = await failure(ask('Hi', { provider: openai({ baseUrl: server.url, model: 'm' }) }))

    expect(error).toBeInstanceOf(AiError)
    expect(error).toMatchObject({ kind: 'invalid', status: 422 })
    expect(server.seen).toHaveLength(2)
  })

  it('keeps asking for usage from a server that takes stream_options', async () => {
    const server = provider(() => stream(openaiEvents('hi')).response)

    servers.push(server)

    const reply = ask('Hi', { provider: openai({ baseUrl: server.url, model: 'm' }) })

    expect(await reply.usage).toEqual({ inputTokens: 12, outputTokens: 5 })
    expect(server.seen).toHaveLength(1)
    expect(server.seen[0]!.body.stream_options).toEqual({ include_usage: true })
  })

  it('reads the text chunks of an array content and drops the thinking ones', async () => {
    const server = mistral(() => chunks(
      [{ content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'hmm' }] }] }],
      [{ content: [{ type: 'text', text: 'Hel' }, { type: 'text', text: 'lo' }] }],
      [{ content: [{ type: 'reference', reference_ids: [1] }, { type: 'text', text: '!' }] }, 'stop', USAGE],
    ))

    expect(await ask('Hi', { provider: openai({ baseUrl: server.url, model: 'm' }) })).toBe('Hello!')
  })

  it('fails the reply when the stream ends on error', async () => {
    const server = mistral(() => chunks([{ content: 'half' }], [{}, 'error']))
    const reply = ask('Hi', { provider: openai({ baseUrl: server.url, model: 'm' }) })
    const error = await failure(reply)

    expect(error).toBeInstanceOf(AiError)
    expect(error).toMatchObject({ kind: 'unavailable', partial: 'half' })
    expect(await reply.finish).toBeUndefined()
  })

  it('streams tool calls in deltas and sends the results back as tool messages', async () => {
    const server = mistral(({ body }) => (body.messages as { role: string }[]).some(message => message.role === 'tool')
      ? chunks([{ content: 'Done' }, 'stop', USAGE])
      : chunks(
        [{ role: 'assistant', content: '', tool_calls: [{ id: 'abc123xyz', type: 'function', index: 0, function: { name: 'add_note', arguments: '{"title":' } }] }],
        [{ tool_calls: [{ id: 'abc123xyz', type: 'function', index: 0, function: { name: '', arguments: '"Milk"}' } }] }, 'tool_calls', USAGE],
      ))
    const model = openai({ baseUrl: server.url, model: 'm' })
    const first = await collect(model.stream(REQUEST, new AbortController().signal))

    expect(first).toEqual([{ toolUse: { id: 'abc123xyz', name: 'add_note', arguments: '{"title":"Milk"}' } }, { finish: 'stop' }, { usage: { inputTokens: 9, outputTokens: 4 } }])

    const second = await collect(model.stream({ ...REQUEST, messages: [...REQUEST.messages, { role: 'assistant', content: '', calls: [{ id: 'abc123xyz', name: 'add_note', arguments: '{"title":"Milk"}' }] }, { role: 'user', content: '', results: [{ id: 'abc123xyz', content: '{"id":1}', failed: false }] }] }, new AbortController().signal))

    expect(second).toContainEqual({ text: 'Done' })
    expect((server.seen.at(-1)!.body.messages as object[]).at(-1)).toEqual({ role: 'tool', tool_call_id: 'abc123xyz', content: '{"id":1}' })
  })
})
