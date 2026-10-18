import type { Event, Seen } from './helpers/provider'
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

// A server that answers 422 to a parameter it does not list, naming it as Mistral does.
function strict(refuses: string[], events: Event[]) {
  return serve((_request, seen: Seen) => {
    const found = refuses.find(name => name in seen.body)

    if (found !== undefined)
      return Response.json({ object: 'error', message: { detail: [{ type: 'extra_forbidden', loc: ['body', found] }] } }, { status: 422 })

    return stream(events).response
  })
}

function withCached(cached: number): Event[] {
  return openaiEvents('ok').map(([name, data]): Event => typeof data === 'object' && data !== null && 'usage' in data ? [name, { choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: cached } } }] : [name, data])
}

describe('Anthropic prompt caching', () => {
  const events = anthropicEvents('ok').map(([name, data]): Event => name === 'message_start' ? [name, { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 800, cache_creation_input_tokens: 200 } } }] : [name, data])

  it('asks for automatic caching by default and reports the cache usage apart', async () => {
    const server = serve(() => stream(events).response)
    const reply = ask('Hi', { provider: anthropic({ apiKey: 'k', baseUrl: server.url, model: 'm' }) })

    await reply
    expect(server.seen[0]!.body.cache_control).toEqual({ type: 'ephemeral' })
    expect(await reply.usage).toEqual({ inputTokens: 10, outputTokens: 15, cacheReadTokens: 800, cacheWriteTokens: 200 })
  })

  it('keeps the cache for an hour when asked, and sends nothing when turned off', async () => {
    const server = serve(() => stream(events).response)
    const provided = anthropic({ apiKey: 'k', baseUrl: server.url, model: 'm' })

    await ask('Hi', { provider: provided, cache: '1h' })
    await ask('Hi', { provider: provided, cache: false })
    expect(server.seen[0]!.body.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect('cache_control' in server.seen[1]!.body).toBe(false)
  })
})

describe('OpenAI-compatible prompt caching', () => {
  it('sends one key for a conversation, the same for every turn and different between conversations', async () => {
    const server = serve(() => stream(openaiEvents('ok')).response)
    const provided = openai({ baseUrl: `${server.url}/v1`, model: 'm' })

    await ask([{ role: 'user', content: 'one' }], { provider: provided, system: 'S' })
    await ask([{ role: 'user', content: 'one' }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'two' }], { provider: provided, system: 'S' })
    await ask([{ role: 'user', content: 'other' }], { provider: provided, system: 'S' })

    const keys = server.seen.map(seen => seen.body.prompt_cache_key)

    expect(keys[0]).toMatch(/^kay-[0-9a-f]{32}$/)
    expect(keys[1]).toBe(keys[0])
    expect(keys[2]).not.toBe(keys[0])
    expect(JSON.stringify(keys)).not.toContain('one')
  })

  it('splits the cached tokens out of the prompt tokens', async () => {
    const server = serve(() => stream(withCached(60)).response)
    const reply = ask('Hi', { provider: openai({ baseUrl: `${server.url}/v1`, model: 'm' }) })

    await reply
    expect(await reply.usage).toEqual({ inputTokens: 40, outputTokens: 5, cacheReadTokens: 60 })
  })

  it('sends no key when caching is off', async () => {
    const server = serve(() => stream(openaiEvents('ok')).response)

    await ask('Hi', { provider: openai({ baseUrl: `${server.url}/v1`, model: 'm' }), cache: false })
    expect('prompt_cache_key' in server.seen[0]!.body).toBe(false)
  })

  it('drops only the key a server refuses, once, and keeps asking for usage', async () => {
    const server = strict(['prompt_cache_key'], openaiEvents('ok'))
    const provided = openai({ baseUrl: `${server.url}/v1`, model: 'm' })

    expect(await ask('Hi', { provider: provided })).toBe('ok')
    expect(await ask('Again', { provider: provided })).toBe('ok')
    expect(server.seen).toHaveLength(3)
    expect(server.seen[1]!.body.stream_options).toEqual({ include_usage: true })
    expect('prompt_cache_key' in server.seen[1]!.body).toBe(false)
    expect('prompt_cache_key' in server.seen[2]!.body).toBe(false)
    expect(server.seen[2]!.body.stream_options).toEqual({ include_usage: true })
  })

  it('drops both when a server refuses both, in one retry per refusal', async () => {
    const server = strict(['stream_options', 'prompt_cache_key'], openaiEvents('ok'))
    const provided = openai({ baseUrl: `${server.url}/v1`, model: 'm' })

    expect(await ask('Hi', { provider: provided })).toBe('ok')
    expect(await ask('Again', { provider: provided })).toBe('ok')
    expect(server.seen).toHaveLength(4)

    for (const seen of server.seen.slice(2))
      expect(Object.keys(seen.body)).not.toContain('prompt_cache_key')
  })

  it('does not remember a refusal when the retry fails as well', async () => {
    const server = serve((_request, seen) => 'model' in seen.body && seen.body.model === 'bad' ? Response.json({ error: { message: 'unknown model' } }, { status: 400 }) : stream(openaiEvents('ok')).response)
    const provided = openai({ baseUrl: `${server.url}/v1`, model: 'm' })

    await expect(Promise.resolve(ask('Hi', { provider: provided, model: 'bad' }))).rejects.toMatchObject({ kind: 'invalid' })
    await ask('Hi', { provider: provided })
    expect(server.seen.at(-1)!.body.prompt_cache_key).toBeDefined()
    expect(server.seen.at(-1)!.body.stream_options).toBeDefined()
  })
})
