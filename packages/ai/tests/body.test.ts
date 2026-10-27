import { afterAll, describe, expect, it } from 'bun:test'
import { AiError, anthropic, ask, openai } from '../src'
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

describe('fields kayjs-ai does not model', () => {
  it('sends an ask\'s body to an OpenAI-compatible server and one built with a body, the ask winning', async () => {
    const server = serve(() => stream(openaiEvents('ok')).response)
    const provided = openai({ baseUrl: `${server.url}/v1`, model: 'm', body: { top_p: 0.5, seed: 1, provider: { order: ['a'] } } })

    expect(await ask('Hi', { provider: provided, body: { seed: 7, stop: ['END'] } })).toBe('ok')
    expect(server.seen[0]!.body).toMatchObject({ top_p: 0.5, seed: 7, stop: ['END'], provider: { order: ['a'] }, model: 'm', stream: true })
  })

  it('sends them to Anthropic', async () => {
    const server = serve(() => stream(anthropicEvents('ok')).response)
    const provided = anthropic({ baseUrl: server.url, apiKey: 'k', model: 'm', body: { top_k: 40 } })

    expect(await ask('Hi', { provider: provided, body: { metadata: { user_id: 'u1' } } })).toBe('ok')
    expect(server.seen[0]!.body).toMatchObject({ top_k: 40, metadata: { user_id: 'u1' } })
  })

  it('never lets them replace what kayjs-ai settles', async () => {
    const server = serve(() => stream(openaiEvents('ok')).response)
    const provided = openai({ baseUrl: `${server.url}/v1`, model: 'm', body: { stream: false, model: 'other' } })

    await ask('Hi', { provider: provided, temperature: 0.1, reasoning: 'low', body: { messages: [], temperature: 2, reasoning_effort: 'high', max_tokens: 1, stream_options: null } })
    expect(server.seen[0]!.body).toMatchObject({ model: 'm', stream: true, temperature: 0.1, reasoning_effort: 'low', max_tokens: 4096, stream_options: { include_usage: true } })
    expect(server.seen[0]!.body.messages).toEqual([{ role: 'user', content: 'Hi' }])
  })

  it('keeps a body temperature when the ask sets none, and the Anthropic settled fields too', async () => {
    const openaiServer = serve(() => stream(openaiEvents('ok')).response)
    const anthropicServer = serve(() => stream(anthropicEvents('ok')).response)

    await ask('Hi', { provider: openai({ baseUrl: `${openaiServer.url}/v1`, model: 'm' }), body: { temperature: 0.3 } })
    await ask('Hi', { provider: anthropic({ baseUrl: anthropicServer.url, apiKey: 'k', model: 'm' }), body: { max_tokens: 1, stream: false, system: 'x' } })
    expect(openaiServer.seen[0]!.body.temperature).toBe(0.3)
    expect(anthropicServer.seen[0]!.body).toMatchObject({ max_tokens: 4096, stream: true })
    expect('system' in anthropicServer.seen[0]!.body).toBe(true)
  })

  it('fails with the server\'s own message when it refuses a field', async () => {
    const server = serve(() => Response.json({ error: { message: 'Unrecognized request argument supplied: safe_prompt' } }, { status: 400 }))

    try {
      await ask('Hi', { provider: openai({ baseUrl: `${server.url}/v1`, model: 'm' }), body: { safe_prompt: true } })
    }
    catch (error) {
      expect(error).toBeInstanceOf(AiError)
      expect((error as AiError).message).toContain('Unrecognized request argument supplied: safe_prompt')

      return
    }

    throw new Error('the ask did not fail')
  })

  it('refuses a body that is no object', async () => {
    expect(() => openai({ body: [] as never })).toThrow('body')
    expect(() => anthropic({ apiKey: 'k', body: 'x' as never })).toThrow('body')
    expect(() => ask('Hi', { provider: openai({ model: 'm' }), body: null as never })).toThrow('body')
  })
})
