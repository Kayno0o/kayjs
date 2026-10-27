import type { Piece, ProviderRequest } from '../src'
import type { Event } from './helpers/provider'
import { afterAll, describe, expect, it } from 'bun:test'
import { anthropic, ask, openai } from '../src'
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

function bodyOf(server: ReturnType<typeof provider>): Record<string, unknown> {
  return server.seen[0]!.body
}

const BASE: ProviderRequest = { messages: [{ role: 'user', content: 'Hi' }], system: undefined, model: 'm', maxTokens: 50, temperature: undefined, timeouts: { connect: '5000s', idle: '5000s' } }

describe('reasoning on Anthropic', () => {
  async function sent(options: { reasoning?: 'none' | 'low' | 'medium' | 'high', maxTokens?: number, temperature?: number, body?: Record<string, unknown> }) {
    const server = serve(() => stream(anthropicEvents('ok')).response)

    await ask('Hi', { provider: anthropic({ baseUrl: server.url, apiKey: 'k', model: 'm' }), ...options })

    return bodyOf(server)
  }

  it('sends no thinking setting unless reasoning is given', async () => {
    expect('thinking' in await sent({})).toBe(false)
  })

  it('turns thinking off for none, keeping the temperature', async () => {
    expect(await sent({ reasoning: 'none', temperature: 0.2 })).toMatchObject({ thinking: { type: 'disabled' }, temperature: 0.2 })
  })

  it('sizes the budget from maxTokens for each level and drops the temperature it refuses', async () => {
    const low = await sent({ reasoning: 'low', maxTokens: 8000, temperature: 0.2 })

    expect(low.thinking).toEqual({ type: 'enabled', budget_tokens: 2000 })
    expect('temperature' in low).toBe(false)
    expect((await sent({ reasoning: 'medium', maxTokens: 8000 })).thinking).toEqual({ type: 'enabled', budget_tokens: 4000 })
    expect((await sent({ reasoning: 'high', maxTokens: 8000 })).thinking).toEqual({ type: 'enabled', budget_tokens: 6000 })
  })

  it('keeps the budget at the minimum of 1024 and under maxTokens, else leaves thinking off', async () => {
    expect((await sent({ reasoning: 'low', maxTokens: 2000 })).thinking).toEqual({ type: 'enabled', budget_tokens: 1024 })
    expect((await sent({ reasoning: 'high', maxTokens: 1500 })).thinking).toEqual({ type: 'enabled', budget_tokens: 1125 })
    expect('thinking' in await sent({ reasoning: 'high', maxTokens: 1024 })).toBe(false)
  })

  it('lets reasoning win over a thinking field of the body', async () => {
    expect((await sent({ reasoning: 'none', body: { thinking: { type: 'enabled', budget_tokens: 2000 } } })).thinking).toEqual({ type: 'disabled' })
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
