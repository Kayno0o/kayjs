import type { AiError, Piece, ProviderRequest } from '../src'
import type { Event } from './helpers/provider'
import { afterAll, describe, expect, it } from 'bun:test'
import { s } from 'kay'
import { anthropic, ask, openai } from '../src'
import { verdict } from './fixture/src/answers'
import { anthropicEvents, openaiEvents, provider, stream } from './helpers/provider'

const servers: ReturnType<typeof provider>[] = []

function serve(handle: Parameters<typeof provider>[0]) {
  const server = provider(handle)

  servers.push(server)

  return server
}

afterAll(async () => {
  await Promise.all(servers.map(async server => server.stop()))
})

async function collect(source: AsyncIterable<Piece>): Promise<Piece[]> {
  const pieces: Piece[] = []

  for await (const piece of source)
    pieces.push(piece)

  return pieces
}

async function snapshots<T>(reply: AsyncIterable<T>): Promise<T[]> {
  const seen: T[] = []

  for await (const part of reply)
    seen.push(part)

  return seen
}

async function failure(reply: PromiseLike<unknown>): Promise<AiError> {
  try {
    await reply
  }
  catch (error) {
    return error as AiError
  }

  throw new Error('the reply did not fail')
}

const ANSWER = { title: 'Hello world', score: 4.5, tags: ['a', 'bc'], author: { name: 'Alice' } }
const JSON_PIECES = ['{"title":"Hello ', 'world","score":4.5,"tags":["a",', '"bc"],"author":{"name":"Ali', 'ce"}}']
// What a provider is told of `verdict`: every object closed to other fields.
const SENT = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    score: { type: 'number' },
    tags: { type: 'array', items: { type: 'string' } },
    author: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
  },
  required: ['title', 'score', 'tags', 'author'],
  additionalProperties: false,
}
const BASE: ProviderRequest = { messages: [{ role: 'user', content: 'Review' }], system: undefined, model: 'm', maxTokens: 50, temperature: undefined, timeouts: { connect: 5000, idle: 5000 }, schema: SENT }
const SPEC = { name: 'add_note', description: 'Add note', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } }

function openaiAnswer(chunks: string[], finish = 'stop'): Event[] {
  return [
    ...chunks.map((content): Event => [undefined, { choices: [{ index: 0, delta: { content }, finish_reason: null }] }]),
    [undefined, { choices: [{ index: 0, delta: {}, finish_reason: finish }] }],
    [undefined, { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } }],
    [undefined, '[DONE]'],
  ]
}

function anthropicAnswer(chunks: string[], stop = 'end_turn'): Event[] {
  return anthropicEvents(...chunks).map((event): Event => event[0] === 'message_delta' ? ['message_delta', { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 15 } }] : event)
}

describe('an OpenAI-compatible provider asked for a schema', () => {
  it('asks through response_format json_schema, strict when every field is required, and streams the object', async () => {
    const server = serve(() => stream(openaiAnswer(JSON_PIECES)).response)
    const reply = ask('Review', { schema: verdict, provider: openai({ baseUrl: `${server.url}/v1`, apiKey: 'sk', model: 'gpt-x' }) })
    const seen = await snapshots(reply)

    expect(server.seen[0]!.body).toMatchObject({ model: 'gpt-x', stream: true, response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: SENT } } })
    expect(server.seen[0]!.body).not.toHaveProperty('tools')
    expect(seen[0]).toEqual({ title: 'Hello ' })
    expect(seen.at(-1)).toEqual(ANSWER)
    expect(await reply).toEqual(ANSWER)
    expect(await reply.usage).toEqual({ inputTokens: 12, outputTokens: 5 })
  })

  it('is not strict when a field is optional, which strict mode cannot say', async () => {
    const server = serve(() => stream(openaiAnswer(['{"a":"x"}'])).response)
    const shape = s.Object({ a: s.String(), b: s.Optional(s.Number()) })

    expect(await ask('x', { schema: shape, provider: openai({ baseUrl: server.url, model: 'm' }) })).toEqual({ a: 'x' })
    expect(server.seen[0]!.body.response_format).toMatchObject({ json_schema: { strict: false, schema: { required: ['a'], additionalProperties: false } } })
  })

  it('moves the bounds a server cannot hold into the description, and checks them on the answer', async () => {
    const server = serve(() => stream(openaiAnswer(['{"name":"ab","stars":9}'])).response)
    const bounded = s.Object({ name: s.String({ minLength: 3, error: 'Too short' }), stars: s.Integer({ minimum: 1, maximum: 5 }) })
    const error = await failure(ask('x', { schema: bounded, provider: openai({ baseUrl: server.url, model: 'm' }) }))
    const sent = (server.seen[0]!.body.response_format as { json_schema: { schema: { properties: Record<string, Record<string, unknown>> } } }).json_schema.schema.properties

    expect(sent.name).toEqual({ type: 'string', description: '{minLength: 3}' })
    expect(sent.stars).toMatchObject({ type: 'integer', description: '{minimum: 1, maximum: 5}' })
    expect(sent.stars).not.toHaveProperty('minimum')
    expect(error.kind).toBe('schema')
    expect([...error.fields!].sort()).toEqual(['name', 'stars'])
  })

  it('serves an Ollama server the same way, on its OpenAI-compatible root', async () => {
    const server = serve(() => stream(openaiAnswer(JSON_PIECES)).response)

    expect(await ask('Review', { schema: verdict, maxTokens: 300, provider: openai({ baseUrl: `${server.url}/v1`, model: 'llama3.2' }) })).toEqual(ANSWER)
    expect(server.seen[0]!.url).toBe('/v1/chat/completions')
    expect(server.seen[0]!.headers.get('authorization')).toBeNull()
    expect(server.seen[0]!.body).toMatchObject({ max_tokens: 300, response_format: { type: 'json_schema' } })
  })

  it('sends the tools and the format together', async () => {
    const server = serve(() => stream(openaiAnswer(['{}'])).response)

    await collect(openai({ baseUrl: server.url, model: 'm' }).stream({ ...BASE, tools: [SPEC] }, new AbortController().signal))
    expect(server.seen[0]!.body).toMatchObject({ tools: [{ type: 'function', function: { name: 'add_note' } }], response_format: { type: 'json_schema' } })
  })

  it('sends no format to an ask without a schema', async () => {
    const server = serve(() => stream(openaiEvents('ok')).response)

    await ask('x', { provider: openai({ baseUrl: server.url, model: 'm' }) })
    expect(server.seen[0]!.body).not.toHaveProperty('response_format')
  })

  it('fails an answer cut by the token cap, as cut', async () => {
    const server = serve(() => stream(openaiAnswer(['{"title":"Hel'], 'length')).response)
    const reply = ask('x', { schema: verdict, provider: openai({ baseUrl: server.url, model: 'm' }) })
    const error = await failure(reply)

    expect(error).toMatchObject({ kind: 'schema', partial: '{"title":"Hel' })
    expect(error.message).toContain('maxTokens')
    expect(await reply.finish).toBe('length')
  })

  it('asks by a forced tool call a server that refuses response_format, and remembers it', async () => {
    const answerCall = (arguments_: string[]): Event[] => [
      [undefined, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'kay_answer', arguments: '' } }] }, finish_reason: null }] }],
      ...arguments_.map((piece): Event => [undefined, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] }, finish_reason: null }] }]),
      [undefined, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }],
      [undefined, { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } }],
      [undefined, '[DONE]'],
    ]
    const server = serve((_request, { body }) => body.response_format === undefined
      ? stream(answerCall(JSON_PIECES)).response
      : Response.json({ error: { message: 'Unsupported parameter: \'response_format\'', type: 'invalid_request_error' } }, { status: 400 }))
    const make = () => ask('Review', { schema: verdict, provider: openai({ baseUrl: server.url, model: 'm' }) })
    const first = make()
    const seen = await snapshots(first)

    expect(server.seen).toHaveLength(2)
    expect(server.seen[1]!.body).not.toHaveProperty('response_format')
    expect(server.seen[1]!.body).toMatchObject({ tools: [{ type: 'function', function: { name: 'kay_answer', parameters: SENT } }], tool_choice: 'required' })
    expect(seen[0]).toEqual({ title: 'Hello ' })
    expect(seen.at(-1)).toEqual(ANSWER)
    expect(await first.usage).toEqual({ inputTokens: 12, outputTokens: 5 })
    expect(await first.finish).toBe('stop')
    expect(await first.calls).toEqual([])

    expect(await make()).toEqual(ANSWER)
    expect(server.seen).toHaveLength(3)
    expect(server.seen[2]!.body).toHaveProperty('tool_choice', 'required')
  })

  it('keeps asking through response_format after a 400 that refuses the schema, which is no server without it', async () => {
    const server = serve(() => Response.json({ error: { message: 'Invalid schema for response_format \'answer\': bad', type: 'invalid_request_error' } }, { status: 400 }))
    const provider = openai({ baseUrl: server.url, model: 'm' })

    expect(await failure(ask('x', { schema: verdict, provider }))).toMatchObject({ kind: 'invalid', status: 400 })
    expect(server.seen.every(seen => !('tool_choice' in seen.body))).toBe(true)
    expect(await failure(ask('x', { schema: verdict, provider }))).toMatchObject({ kind: 'invalid' })
    expect(server.seen.every(seen => 'response_format' in seen.body)).toBe(true)
  })

  it('does not remember a server as without response_format when the call by tool fails as well', async () => {
    const server = serve((_request, { body }) => Response.json({ error: { message: body.response_format === undefined ? 'unknown model' : 'response_format is not here' } }, { status: 400 }))
    const provider = openai({ baseUrl: server.url, model: 'm' })

    await failure(ask('x', { schema: verdict, provider }))

    const before = server.seen.length

    await failure(ask('x', { schema: verdict, provider }))
    expect(server.seen[before]!.body).toHaveProperty('response_format')
  })

  it('does not take another 400 for a refused response_format', async () => {
    const server = serve(() => Response.json({ error: { message: 'unknown model' } }, { status: 400 }))
    const error = await failure(ask('x', { schema: verdict, provider: openai({ baseUrl: server.url, model: 'm' }) }))

    expect(error).toMatchObject({ kind: 'invalid', status: 400 })
    expect(server.seen.every(seen => !('tool_choice' in seen.body))).toBe(true)
  })
})

describe('Anthropic\'s provider asked for a schema', () => {
  it('asks through output_config json_schema and streams the object', async () => {
    const server = serve(() => stream(anthropicAnswer(JSON_PIECES)).response)
    const reply = ask('Review', { schema: verdict, provider: anthropic({ apiKey: 'sk-ant', baseUrl: server.url, model: 'claude-x' }) })
    const seen = await snapshots(reply)

    expect(server.seen[0]!.body).toEqual({ model: 'claude-x', max_tokens: 4096, stream: true, cache_control: { type: 'ephemeral' }, messages: [{ role: 'user', content: 'Review' }], output_config: { format: { type: 'json_schema', schema: SENT } } })
    expect(seen[0]).toEqual({ title: 'Hello ' })
    expect(seen.at(-1)).toEqual(ANSWER)
    expect(await reply).toEqual(ANSWER)
    expect(await reply.usage).toEqual({ inputTokens: 25, outputTokens: 15 })
  })

  it('moves what the format cannot hold into the description', async () => {
    const server = serve(() => stream(anthropicAnswer(['{"name":"abc","stars":3,"tags":["x"]}'])).response)
    const bounded = s.Object({ name: s.String({ minLength: 3 }), stars: s.Integer({ minimum: 1, maximum: 5 }), tags: s.Array(s.String(), { minItems: 1, maxItems: 4 }) })

    expect(await ask('x', { schema: bounded, provider: anthropic({ apiKey: 'k', baseUrl: server.url, model: 'm' }) })).toEqual({ name: 'abc', stars: 3, tags: ['x'] })

    const sent = (server.seen[0]!.body.output_config as { format: { schema: { properties: Record<string, Record<string, unknown>> } } }).format.schema.properties

    expect(sent.name).toEqual({ type: 'string', description: '{minLength: 3}' })
    expect(sent.stars).not.toHaveProperty('minimum')
    expect(sent.tags).toEqual({ type: 'array', items: { type: 'string' }, description: '{minItems: 1, maxItems: 4}' })
  })

  it('sends the tools and the format together, and no format without a schema', async () => {
    const server = serve(() => stream(anthropicAnswer(['{}'])).response)

    await collect(anthropic({ apiKey: 'k', baseUrl: server.url, model: 'm' }).stream({ ...BASE, tools: [SPEC] }, new AbortController().signal))
    await collect(anthropic({ apiKey: 'k', baseUrl: server.url, model: 'm' }).stream({ ...BASE, schema: undefined }, new AbortController().signal))
    expect(server.seen[0]!.body).toMatchObject({ tools: [{ name: 'add_note' }], output_config: { format: { type: 'json_schema' } } })
    expect(server.seen[1]!.body).not.toHaveProperty('output_config')
  })

  it('fails an answer cut by max_tokens as cut, and one refused as refused', async () => {
    const cut = serve(() => stream(anthropicAnswer(['{"title":"Hel'], 'max_tokens')).response)
    const refused = serve(() => stream(anthropicAnswer([''], 'refusal')).response)
    const first = await failure(ask('x', { schema: verdict, provider: anthropic({ apiKey: 'k', baseUrl: cut.url, model: 'm' }) }))
    const second = await failure(ask('x', { schema: verdict, provider: anthropic({ apiKey: 'k', baseUrl: refused.url, model: 'm' }) }))

    expect(first).toMatchObject({ kind: 'schema', partial: '{"title":"Hel' })
    expect(first.message).toContain('maxTokens')
    expect(second.kind).toBe('schema')
    expect(second.message).toContain('refused')
  })

  it('surfaces a 400 on the format as the provider refusing the request', async () => {
    const server = serve(() => Response.json({ error: { type: 'invalid_request_error', message: 'output_config.format is not supported by this model' } }, { status: 400 }))
    const error = await failure(ask('x', { schema: verdict, provider: anthropic({ apiKey: 'k', baseUrl: server.url, model: 'm' }) }))

    expect(error).toMatchObject({ kind: 'invalid', status: 400 })
    expect(error.message).toContain('output_config')
  })
})
