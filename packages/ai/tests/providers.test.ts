import type { ProviderRequest } from '../src'
import type { Event } from './helpers/provider'
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

// The events up to the one carrying `text`, before any that says the reply is done.
function upTo(list: Event[], text: string): Event[] {
  return list.slice(0, list.findIndex(([, data]) => JSON.stringify(data).includes(`"${text}"`)) + 1)
}

async function snapshots(reply: AsyncIterable<string>): Promise<string[]> {
  const seen: string[] = []

  for await (const text of reply)
    seen.push(text)

  return seen
}

async function failure(reply: PromiseLike<string>): Promise<AiError> {
  try {
    await reply
  }
  catch (error) {
    return error as AiError
  }

  throw new Error('the reply did not fail')
}

describe('an OpenAI-compatible provider', () => {
  it('asks chat completions with a bearer key and streams the text', async () => {
    const server = serve(() => stream(openaiEvents('Hel', 'lo ', 'there')).response)
    const reply = ask([{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hey' }, { role: 'user', content: 'Again' }], { provider: openai({ baseUrl: `${server.url}/v1/`, apiKey: 'sk-test', model: 'gpt-x' }), system: 'Be brief', maxTokens: 50, temperature: 0.2 })

    expect(server.seen).toEqual([])
    expect(await reply).toBe('Hello there')
    expect(await reply.usage).toEqual({ inputTokens: 12, outputTokens: 5 })
    expect(server.seen).toHaveLength(1)
    expect(server.seen[0]!.url).toBe('/v1/chat/completions')
    expect(server.seen[0]!.headers.get('authorization')).toBe('Bearer sk-test')
    expect(server.seen[0]!.body).toMatchObject({ model: 'gpt-x', stream: true, max_tokens: 50, temperature: 0.2, messages: [{ role: 'system', content: 'Be brief' }, { role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hey' }, { role: 'user', content: 'Again' }] })
  })

  it('sends no key to a server wanting none', async () => {
    const server = serve(() => stream(openaiEvents('ok')).response)

    expect(await ask('Hi', { provider: openai({ baseUrl: server.url, model: 'llama' }) })).toBe('ok')
    expect(server.seen[0]!.headers.get('authorization')).toBeNull()
  })

  it('gives snapshots, the text so far, and the pieces alone through deltas()', async () => {
    const server = serve(() => stream(openaiEvents('a', 'b', 'c')).response)
    const options = { provider: openai({ baseUrl: server.url, model: 'm' }) }
    const all = await snapshots(ask('x', options))

    expect(all.at(-1)).toBe('abc')
    expect(all.every((text, index) => index === 0 || text.startsWith(all[index - 1]!))).toBe(true)
    expect((await snapshots(ask('x', options).deltas())).join('')).toBe('abc')
  })

  it('reads data lines split across chunks and ignores comments', async () => {
    const server = serve(() => new Response(`: keep-alive\n\ndata: {"choices":[{"delta":{"content":"one"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":" two"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`))

    expect(await ask('x', { provider: openai({ baseUrl: server.url, model: 'm' }) })).toBe('one two')
  })
})

describe('why a reply ended', () => {
  it('says when the token cap or a filter cut the reply, and still returns its text', async () => {
    const capped = serve(() => stream([[undefined, { choices: [{ delta: { content: 'hi' }, finish_reason: 'length' }] }], [undefined, '[DONE]']]).response)
    const filtered = serve(() => stream(anthropicEvents('no').map(([event, data]): Event => event === 'message_delta' ? [event, { type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: { output_tokens: 2 } }] : [event, data])).response)
    const normal = serve(() => stream(openaiEvents('ok')).response)
    const first = ask('x', { provider: openai({ baseUrl: capped.url, model: 'm' }) })
    const second = ask('x', { provider: anthropic({ apiKey: 'k', baseUrl: filtered.url, model: 'm' }) })

    expect(await first).toBe('hi')
    expect(await first.finish).toBe('length')
    expect(await second.finish).toBe('filtered')
    expect(await ask('x', { provider: openai({ baseUrl: normal.url, model: 'm' }) }).finish).toBe('stop')
  })
})

describe('Anthropic\'s provider', () => {
  it('asks the Messages API with its key and version headers and streams the text deltas', async () => {
    const server = serve(() => stream(anthropicEvents('Hel', 'lo')).response)
    const reply = ask('Hi', { provider: anthropic({ apiKey: 'sk-ant', baseUrl: server.url, model: 'claude-x' }), system: 'Be brief' })

    expect(await reply).toBe('Hello')
    expect(await reply.usage).toEqual({ inputTokens: 25, outputTokens: 15 })
    expect(server.seen[0]!.url).toBe('/v1/messages')
    expect(server.seen[0]!.headers.get('x-api-key')).toBe('sk-ant')
    expect(server.seen[0]!.headers.get('anthropic-version')).toBe('2023-06-01')
    expect(server.seen[0]!.body).toEqual({ model: 'claude-x', max_tokens: 4096, stream: true, system: 'Be brief', messages: [{ role: 'user', content: 'Hi' }] })
  })

  it('reads an error event mid-reply as the provider failing', async () => {
    const server = serve(() => stream([...upTo(anthropicEvents('Hel'), 'Hel'), ['error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]]).response)
    const error = await failure(ask('Hi', { provider: anthropic({ apiKey: 'k', baseUrl: server.url, model: 'm' }) }))

    expect(error).toMatchObject({ kind: 'unavailable', partial: 'Hel' })
  })
})

describe.each([
  ['openai', (url: string) => openai({ baseUrl: url, model: 'm' }), openaiEvents],
  ['anthropic', (url: string) => anthropic({ apiKey: 'k', baseUrl: url, model: 'm' }), anthropicEvents],
] as const)('%s failures', (name, make, events) => {
  const asking = (url: string) => ask('Hi', { provider: make(url) })

  it('names a refused key without repeating it', async () => {
    const server = serve(() => Response.json({ error: { message: 'Invalid API key' } }, { status: 401 }))
    const error = await failure(asking(server.url))

    expect(error).toBeInstanceOf(AiError)
    expect(error).toMatchObject({ kind: 'auth', status: 401 })
    expect(error.message).toContain('Invalid API key')
  })

  it('reads Retry-After seconds and dates on a 429', async () => {
    const seconds = serve(() => Response.json({ error: { message: 'slow down' } }, { status: 429, headers: { 'retry-after': '20' } }))
    const date = serve(() => new Response('{}', { status: 429, headers: { 'retry-after': new Date(Date.now() + 30_000).toUTCString() } }))
    const none = serve(() => new Response('busy', { status: 429 }))

    expect(await failure(asking(seconds.url))).toMatchObject({ kind: 'rate-limited', status: 429, retryAfter: 20 })
    expect((await failure(asking(date.url))).retryAfter).toBeGreaterThan(25)
    expect(await failure(asking(none.url))).toMatchObject({ kind: 'rate-limited', retryAfter: undefined })
  })

  it('never sends the key to another origin a redirect points at', async () => {
    const elsewhere = serve(() => stream(events('leaked')).response)
    const server = serve(() => new Response(null, { status: 307, headers: { location: `${elsewhere.url}/v1/messages` } }))

    expect(await failure(asking(server.url))).toMatchObject({ kind: 'network' })
    expect(elsewhere.seen).toEqual([])
  })

  it('hides the key from what the provider echoes back', async () => {
    const server = serve((_request, { headers }) => Response.json({ error: { message: `Incorrect key ${headers.get('x-api-key') ?? headers.get('authorization')}` } }, { status: 401 }))
    const error = await failure(ask('Hi', { provider: name === 'anthropic' ? anthropic({ apiKey: 'sk-secret', baseUrl: server.url, model: 'm' }) : openai({ baseUrl: server.url, apiKey: 'sk-secret', model: 'm' }) }))

    expect(error.message).toContain('[key]')
    expect(error.message).not.toContain('sk-secret')
  })

  it('reports an out-of-credit 429 as invalid, as waiting does not help', async () => {
    const server = serve(() => Response.json({ error: { message: 'You exceeded your quota', code: 'insufficient_quota' } }, { status: 429, headers: { 'retry-after': '5' } }))

    expect(await failure(asking(server.url))).toMatchObject({ kind: 'invalid', status: 429, retryAfter: undefined })
  })

  it('refuses a Retry-After that is no whole seconds or date, or a date gone by', async () => {
    const fraction = serve(() => new Response('{}', { status: 429, headers: { 'retry-after': '1.5' } }))
    const past = serve(() => new Response('{}', { status: 429, headers: { 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' } }))

    expect((await failure(asking(fraction.url))).retryAfter).toBeUndefined()
    expect((await failure(asking(past.url))).retryAfter).toBeUndefined()
  })

  it('names a server that answers JSON instead of streaming', async () => {
    const server = serve(() => Response.json({ choices: [] }))

    expect(await failure(asking(server.url))).toMatchObject({ kind: 'protocol' })
  })

  it('reports a 500 as unavailable and another 4xx as invalid', async () => {
    const down = serve(() => new Response('<html>oops</html>', { status: 500 }))
    const refused = serve(() => Response.json({ error: { message: 'unknown model' } }, { status: 404 }))

    expect(await failure(asking(down.url))).toMatchObject({ kind: 'unavailable', status: 500 })
    expect(await failure(asking(refused.url))).toMatchObject({ kind: 'invalid', status: 404 })
  })

  it('reports an unreachable server as a network error', async () => {
    const server = provider(() => new Response())

    await server.stop()

    expect(await failure(asking(server.url))).toMatchObject({ kind: 'network' })
  })

  it('fails a stream cut mid-reply with what came before it', async () => {
    const cut = upTo(events('Hel', 'lo'), 'Hel')
    const server = serve(() => stream(cut).response)
    const reply = asking(server.url)
    const seen: string[] = []
    let thrown: unknown

    try {
      for await (const text of reply)
        seen.push(text)
    }
    catch (error) {
      thrown = error
    }

    expect(thrown).toMatchObject({ kind: 'cut', partial: expect.stringContaining('Hel') })
    expect(seen.length).toBeGreaterThan(0)
  })

  it('fails on malformed events as a protocol error', async () => {
    const server = serve(() => new Response('data: {not json\n\n'))

    expect(await failure(asking(server.url))).toMatchObject({ kind: 'protocol' })
  })

  it('answers a cancelled reply with its text so far and stops the provider', async () => {
    let cancelled: Promise<void> | undefined
    const server = serve(() => {
      const held = stream(upTo(events('Hel'), 'Hel'), { hold: true })

      cancelled = held.cancelled

      return held.response
    })
    const reply = asking(server.url)

    const reading = reply[Symbol.asyncIterator]()

    expect((await reading.next()).value).toBe('Hel')
    await reading.return?.()
    await cancelled
    expect(await reply).toBe('Hel')
  })
})

describe('timeouts', () => {
  const makers = [
    ['openai', (url: string) => openai({ baseUrl: url, model: 'm' }), openaiEvents],
    ['anthropic', (url: string) => anthropic({ apiKey: 'k', baseUrl: url, model: 'm' }), anthropicEvents],
  ] as const

  it.each(makers)('fails a %s that accepts the request and never answers', async (_name, make) => {
    const server = serve(async () => new Promise<Response>(() => undefined))
    const error = await failure(ask('Hi', { provider: make(server.url), timeout: { connect: '50ms' } }))

    expect(error).toMatchObject({ kind: 'timeout' })
    expect(error.message).toContain('50 ms')
  })

  it.each(makers)('fails a %s stream that stops sending, with what came before', async (_name, make, events) => {
    const server = serve(() => stream(upTo(events('Hel'), 'Hel'), { hold: true }).response)
    const error = await failure(ask('Hi', { provider: make(server.url), timeout: { idle: '50ms' } }))

    expect(error).toMatchObject({ kind: 'timeout', partial: 'Hel' })
  })

  it('cancels the body of a stream that went idle', async () => {
    const held = stream(upTo(openaiEvents('Hel'), 'Hel'), { hold: true })
    const server = serve(() => held.response)

    await failure(ask('Hi', { provider: openai({ baseUrl: server.url, model: 'm' }), timeout: { idle: '50ms' } }))
    await held.cancelled
  })

  it('keeps a slow stream alive while chunks keep coming', async () => {
    const server = serve(() => {
      const encoder = new TextEncoder()
      const lines = [...openaiEvents('a', 'b', 'c')].map(event => `${event[0] === undefined ? '' : `event: ${event[0]}\n`}data: ${typeof event[1] === 'string' ? event[1] : JSON.stringify(event[1])}\n\n`)
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const line of lines) {
            controller.enqueue(encoder.encode(line))
            await Bun.sleep(40)
          }

          controller.close()
        },
      })

      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    })

    expect(await ask('Hi', { provider: openai({ baseUrl: server.url, model: 'm' }), timeout: { idle: '150ms' } })).toBe('abc')
  })

  it('ends without an error when stopped while connecting', async () => {
    const server = serve(async () => new Promise<Response>(() => undefined))
    const reply = ask('Hi', { provider: openai({ baseUrl: server.url, model: 'm' }), timeout: { connect: '5s' } })
    const text = (async () => reply)()

    await Bun.sleep(20)
    reply.stop()
    expect(await text).toBe('')
  })

  it('takes durations and rejects a bad value', () => {
    const provider = openai({ baseUrl: 'http://localhost:1', model: 'm' })

    expect(() => ask('Hi', { provider, timeout: { connect: 0 } })).toThrow('ask({ timeout }).connect')
    expect(() => ask('Hi', { provider, timeout: { idle: Number.NaN } })).toThrow('ask({ timeout }).idle')
    expect(() => ask('Hi', { provider, timeout: { idle: Number.POSITIVE_INFINITY } })).toThrow('ask({ timeout }).idle')
    expect(() => ask('Hi', { provider, timeout: { idle: '2m', connect: 10 } })).not.toThrow()
  })

  it('passes durations to a provider as milliseconds, capped to what a timer takes', async () => {
    const seen: unknown[] = []
    const spy = { name: 'spy', model: 'm', async* stream(request: ProviderRequest) {
      seen.push(request.timeouts)
      yield { text: 'ok' }
    } }

    await ask('Hi', { provider: spy, timeout: { connect: 2, idle: '500ms' } })
    await ask('Hi', { provider: spy, timeout: { connect: '365d' } })
    expect(seen).toEqual([{ connect: 2000, idle: 500 }, { connect: 2 ** 31 - 1, idle: 60_000 }])
  })

  it('passes the defaults to a provider', async () => {
    let seen: unknown

    await ask('Hi', { provider: { name: 'spy', model: 'm', async* stream(request) {
      seen = request.timeouts
      yield { text: 'ok' }
    } } })
    expect(seen).toEqual({ connect: 30_000, idle: 60_000 })
  })
})

describe('an openai error event', () => {
  const failing = async (error: object) => {
    const server = serve(() => stream([[undefined, { error }]]).response)

    return failure(ask('Hi', { provider: openai({ baseUrl: server.url, model: 'm' }) }))
  }

  it('is classified by its exact type or code', async () => {
    expect(await failing({ type: 'server_error', message: 'x' })).toMatchObject({ kind: 'unavailable' })
    expect(await failing({ type: 'requests', code: 'rate_limit_exceeded' })).toMatchObject({ kind: 'rate-limited' })
    expect(await failing({ code: 'invalid_api_key' })).toMatchObject({ kind: 'auth' })
  })

  it('is no match for a name merely containing one', async () => {
    expect(await failing({ type: 'invalid_request_error', code: 'unavailable_model_for_account' })).toMatchObject({ kind: 'invalid' })
    expect(await failing({ type: 'invalid_request_error', code: 'oauth_failure' })).toMatchObject({ kind: 'invalid' })
    expect(await failing({ type: 'invalid_request_error', code: 'rate_limit_policy_unset' })).toMatchObject({ kind: 'invalid' })
  })
})
