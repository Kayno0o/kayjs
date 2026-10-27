import type { Piece, Provider, ProviderRequest } from '../src'
import type { Event } from './helpers/provider'
import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { anthropic, ask, openai } from '../src'
import { forgetRefusals } from '../src/anthropic'
import { converse } from '../src/loop'
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

afterEach(forgetRefusals)

async function failed(reply: PromiseLike<string>): Promise<string> {
  try {
    await reply
  }
  catch (error) {
    return (error as Error).message
  }

  throw new Error('the reply did not fail')
}

function bodyOf(server: ReturnType<typeof provider>): Record<string, unknown> {
  return server.seen[0]!.body
}

const BASE: ProviderRequest = { messages: [{ role: 'user', content: 'Hi' }], system: undefined, model: 'm', maxTokens: 50, temperature: undefined, timeouts: { connect: '5000s', idle: '5000s' } }

describe('reasoning on Anthropic', () => {
  async function sent(options: { reasoning?: 'none' | 'low' | 'medium' | 'high', temperature?: number, body?: Record<string, unknown> }) {
    const server = serve(() => stream(anthropicEvents('ok')).response)

    await ask('Hi', { provider: anthropic({ baseUrl: server.url, apiKey: 'k', model: 'm' }), ...options })

    return bodyOf(server)
  }

  it('sends no thinking setting unless reasoning is given', async () => {
    expect('thinking' in await sent({})).toBe(false)
  })

  it('asks adaptive thinking with summarized text at the effort of each level, and leaves the temperature out', async () => {
    for (const level of ['low', 'medium', 'high'] as const) {
      const body = await sent({ reasoning: level, temperature: 0.2 })

      expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
      expect(body.output_config).toEqual({ effort: level })
      expect('temperature' in body).toBe(false)
    }
  })

  it('asks none as the lowest effort with thinking disabled, keeping the temperature', async () => {
    expect(await sent({ reasoning: 'none', temperature: 0.2 })).toMatchObject({ thinking: { type: 'disabled' }, output_config: { effort: 'low' }, temperature: 0.2 })
  })

  it('asks again without disabled when the model refuses it, once per model', async () => {
    const server = serve((_request, seen) => 'thinking' in seen.body ? Response.json({ error: { message: 'thinking.type disabled is not supported' } }, { status: 400 }) : stream(anthropicEvents('ok')).response)
    const provided = anthropic({ baseUrl: server.url, apiKey: 'k', model: 'strict' })

    expect(await ask('Hi', { provider: provided, reasoning: 'none' })).toBe('ok')
    expect(await ask('Again', { provider: provided, reasoning: 'none' })).toBe('ok')
    expect(server.seen).toHaveLength(3)
    expect('thinking' in server.seen[1]!.body).toBe(false)
    expect(server.seen[1]!.body.output_config).toEqual({ effort: 'low' })
    expect('thinking' in server.seen[2]!.body).toBe(false)
  })

  const refusing = (about: string, ...fields: string[]) => serve((_request, seen) => {
    const config = typeof seen.body.output_config === 'object' ? seen.body.output_config : null

    return fields.some(field => field in seen.body || (config !== null && field in config)) ? Response.json({ error: { message: about } }, { status: 400 }) : stream(anthropicEvents('ok')).response
  })

  it('surfaces a refusal that is not about thinking, and remembers nothing from it', async () => {
    const server = serve((_request, seen) => 'top_k' in seen.body ? Response.json({ error: { message: 'top_k: not allowed' } }, { status: 400 }) : stream(anthropicEvents('ok')).response)
    const provided = anthropic({ baseUrl: server.url, apiKey: 'k', model: 'm' })

    expect(await failed(ask('Hi', { provider: provided, reasoning: 'none', body: { top_k: 3 } }))).toContain('top_k: not allowed')
    expect(server.seen).toHaveLength(1)
    await ask('Hi', { provider: provided, reasoning: 'none' })
    expect(server.seen[1]!.body.thinking).toEqual({ type: 'disabled' })
  })

  it('remembers a refusal of disabled for its model and root only, and only once the retry got through', async () => {
    const server = refusing('thinking.type: disabled is not supported', 'thinking')
    const strict = anthropic({ baseUrl: server.url, apiKey: 'k', model: 'strict' })

    await ask('Hi', { provider: strict, reasoning: 'none' })
    await ask('Hi', { provider: strict, reasoning: 'none' })
    expect(server.seen.map(seen => 'thinking' in seen.body)).toEqual([true, false, false])

    await ask('Hi', { provider: anthropic({ baseUrl: server.url, apiKey: 'k', model: 'other' }), reasoning: 'none' })
    expect(server.seen.at(-2)!.body.thinking).toEqual({ type: 'disabled' })

    const elsewhere = refusing('never', 'nothing')

    await ask('Hi', { provider: anthropic({ baseUrl: elsewhere.url, apiKey: 'k', model: 'strict' }), reasoning: 'none' })
    expect(elsewhere.seen[0]!.body.thinking).toEqual({ type: 'disabled' })
  })

  it('does not remember a refusal when the retry is refused too', async () => {
    const server = refusing('thinking is not supported', 'thinking', 'output_config')
    const provided = anthropic({ baseUrl: server.url, apiKey: 'k', model: 'm' })

    expect(await failed(ask('Hi', { provider: provided, reasoning: 'none' }))).toContain('thinking is not supported')
    expect(await failed(ask('Hi', { provider: provided, reasoning: 'none' }))).toBeDefined()
    expect(server.seen.map(seen => 'thinking' in seen.body)).toEqual([true, false, true, false])
  })

  it('works for none on a model without effort, by leaving the effort out', async () => {
    const server = refusing('output_config.effort: extra inputs are not permitted', 'effort')
    const provided = anthropic({ baseUrl: server.url, apiKey: 'k', model: 'haiku' })

    expect(await ask('Hi', { provider: provided, reasoning: 'none' })).toBe('ok')
    expect(server.seen[1]!.body.thinking).toEqual({ type: 'disabled' })
    expect('output_config' in server.seen[1]!.body).toBe(false)
  })

  it('fails a level on a model without effort with an error naming reasoning and body.thinking', async () => {
    const server = refusing('output_config.effort: extra inputs are not permitted', 'effort')

    expect(await failed(ask('Hi', { provider: anthropic({ baseUrl: server.url, apiKey: 'k', model: 'haiku' }), reasoning: 'high' }))).toContain('body: { thinking }')
    expect(server.seen).toHaveLength(1)
  })

  it('keeps the effort beside the schema\'s format', async () => {
    const server = serve(() => stream(anthropicEvents('{}')).response)
    const request: ProviderRequest = { ...BASE, reasoning: 'medium', schema: { type: 'object', properties: {}, required: [] } }

    await collect(anthropic({ baseUrl: server.url, apiKey: 'k' }).stream(request, new AbortController().signal))
    expect(bodyOf(server).output_config).toMatchObject({ effort: 'medium', format: { type: 'json_schema' } })
  })

  it('sends a thinking of the body as it is, with no effort, for a model that wants a budget', async () => {
    const body = await sent({ reasoning: 'high', body: { thinking: { type: 'enabled', budget_tokens: 2000 } } })

    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 2000 })
    expect('output_config' in body).toBe(false)
  })

  it('keeps an omitted thinking block, empty but signed, to send back', async () => {
    const server = serve(() => stream([
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-omitted' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_stop', { type: 'message_stop' }],
    ]).response)
    const pieces = await collect(anthropic({ baseUrl: server.url, apiKey: 'k' }).stream(BASE, new AbortController().signal))

    expect(pieces.filter(piece => 'thinking' in piece)).toEqual([{ thinking: { text: '', signature: 'sig-omitted' } }])
    expect(pieces.filter(piece => 'reasoning' in piece)).toEqual([])
  })

  it('streams the thinking as reasoning pieces, never as text, with the finished blocks', async () => {
    const server = serve(() => stream([
      ['message_start', { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me ' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'think.' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'enc' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 1 }],
      ['content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Answer' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 2 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }],
      ['message_stop', { type: 'message_stop' }],
    ]).response)
    const pieces = await collect(anthropic({ baseUrl: server.url, apiKey: 'k' }).stream(BASE, new AbortController().signal))

    expect(pieces.filter(piece => 'reasoning' in piece)).toEqual([{ reasoning: 'Let me ' }, { reasoning: 'think.' }])
    expect(pieces.filter(piece => 'thinking' in piece)).toEqual([{ thinking: { text: 'Let me think.', signature: 'sig-1' } }, { thinking: { redacted: 'enc' } }])
    expect(pieces.filter(piece => 'text' in piece)).toEqual([{ text: 'Answer' }])
  })

  it('drops a thinking block that came without a signature', async () => {
    const server = serve(() => stream([
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hm' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_stop', { type: 'message_stop' }],
    ]).response)
    const pieces = await collect(anthropic({ baseUrl: server.url, apiKey: 'k' }).stream(BASE, new AbortController().signal))

    expect(pieces.filter(piece => 'thinking' in piece)).toEqual([])
  })

  it('sends the thinking blocks back before the tool calls of the turn', async () => {
    const server = serve(() => stream(anthropicEvents('ok')).response)
    const request: ProviderRequest = {
      ...BASE,
      messages: [
        { role: 'user', content: 'Add milk' },
        { role: 'assistant', content: '', thinking: [{ text: 'hmm', signature: 's' }, { redacted: 'enc' }], calls: [{ id: 'c1', name: 'add_note', arguments: '{}' }] },
        { role: 'user', content: '', results: [{ id: 'c1', content: 'ok', ok: true }] },
      ],
    }

    await collect(anthropic({ baseUrl: server.url, apiKey: 'k' }).stream(request, new AbortController().signal))
    expect((bodyOf(server).messages as { content: unknown }[])[1]!.content).toEqual([{ type: 'thinking', thinking: 'hmm', signature: 's' }, { type: 'redacted_thinking', data: 'enc' }, { type: 'tool_use', id: 'c1', name: 'add_note', input: {} }])
  })
})

describe('reasoning across the steps of a tool loop', () => {
  it('joins the thinking of each step after a blank line, keeps the text apart and sends the blocks back', async () => {
    const seen: ProviderRequest[] = []
    const provided: Provider = {
      name: 'steps',
      model: 'm',
      async* stream(request) {
        const first = request.messages.length === 1

        seen.push(structuredClone(request))

        yield { reasoning: first ? 'a' : 'b' }
        yield { thinking: first ? { text: 'a', signature: 's' } : { redacted: 'enc' } }
        yield { text: first ? 'one' : 'two' }

        if (first)
          yield { toolUse: { id: 'x', name: 'unknown', arguments: '{}' } }

        yield { finish: 'stop' }
      },
    }
    const pieces = await collect(converse(provided, BASE, [], 3, new Request('http://localhost/'), new AbortController().signal))

    expect(pieces.filter(piece => 'reasoning' in piece)).toEqual([{ reasoning: 'a' }, { reasoning: '\n\nb' }])
    expect(pieces.filter(piece => 'thinking' in piece)).toEqual([])
    expect(seen[1]!.messages[1]!.thinking).toEqual([{ text: 'a', signature: 's' }])
  })
})

describe('reasoning on an OpenAI-compatible server', () => {
  function withThoughts(field: string): Event[] {
    return [
      [undefined, { choices: [{ index: 0, delta: { role: 'assistant', [field]: 'Hmm. ' }, finish_reason: null }] }],
      [undefined, { choices: [{ index: 0, delta: { [field]: 'Yes.' }, finish_reason: null }] }],
      ...openaiEvents('Answer'),
    ]
  }

  it('streams reasoning_content, and OpenRouter\'s reasoning, apart from the text', async () => {
    for (const field of ['reasoning_content', 'reasoning']) {
      const server = serve(() => stream(withThoughts(field)).response)
      const reply = ask('Hi', { provider: openai({ baseUrl: `${server.url}/v1`, model: 'm' }) })
      const seen: (string | undefined)[] = []

      for await (const progress of reply.progress())
        seen.push(progress.reasoning)

      expect(seen.at(-1)).toBe('Hmm. Yes.')
      expect(await reply).toBe('Answer')
    }
  })

  it('gives no reasoning to a reply whose provider thinks nothing aloud', async () => {
    const server = serve(() => stream(openaiEvents('Answer')).response)

    for await (const progress of ask('Hi', { provider: openai({ baseUrl: `${server.url}/v1`, model: 'm' }) }).progress())
      expect('reasoning' in progress).toBe(false)
  })
})
