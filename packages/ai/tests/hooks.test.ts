import type { Piece, Provider, RequestHookCall } from '../src'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { s } from 'kay'
import { useAppOnError } from '../../../src/server/report'
import { ai, AiError, ask, fakeAi, ground, tool } from '../src'
import { forgetCounts } from '../src/limits'

const real = process.env.KAYJS_AI_REAL_PROVIDERS

// Hooks set in ai() skip the fake, so these asks go to a provider of their own.
beforeEach(() => {
  process.env.KAYJS_AI_REAL_PROVIDERS = '1'
})

afterEach(() => {
  if (real === undefined)
    delete process.env.KAYJS_AI_REAL_PROVIDERS
  else
    process.env.KAYJS_AI_REAL_PROVIDERS = real

  ai()
  forgetCounts()
  fakeAi.clear()
})

const looked = tool({ name: 'look', description: 'Looks', input: s.Object({}), run: () => 'seen' })

// Answers `echo:` and the last message it was sent, after the calls it is scripted to make.
function echo(seen: { messages: string[], system: (string | undefined)[] } = { messages: [], system: [] }, calls = 0): Provider & { seen: typeof seen } {
  let asked = 0

  return {
    seen,
    name: 'echo',
    model: 'm',
    async* stream(request): AsyncGenerator<Piece> {
      seen.messages.push(request.messages.map(message => message.content).join('|'))
      seen.system.push(request.system)
      asked++

      if (asked <= calls) {
        yield { toolUse: { id: `c${asked}`, name: 'look', arguments: '{}' } }
        yield { usage: { inputTokens: 3, outputTokens: 1 } }

        return
      }

      yield { text: `echo:${request.messages.at(-1)?.content}` }
      yield { usage: { inputTokens: 5, outputTokens: 2 } }
      yield { finish: 'stop' }
    },
  }
}

describe('beforeRequest', () => {
  it('may change the messages and the system prompt the provider is sent', async () => {
    const provider = echo()

    ai({ beforeRequest: ({ messages }) => ({ messages: messages.map(message => ({ ...message, content: message.content.replace('secret', '***') })), system: 'be brief' }) })

    expect(await ask('my secret', { provider, system: 'long' })).toBe('echo:my ***')
    expect(provider.seen).toEqual({ messages: ['my ***'], system: ['be brief'] })
  })

  it('is given the messages, the system prompt, the model and the options of the ask', async () => {
    const calls: RequestHookCall[] = []

    ai({ beforeRequest: (call) => {
      calls.push(call)
    } })

    await ask('hi', { provider: echo(), system: 's', maxTokens: 10 })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ messages: [{ role: 'user', content: 'hi' }], system: 's', model: 'm', options: { maxTokens: 10 } })
  })

  it('leaves what it does not return as it was', async () => {
    const provider = echo()

    ai({ beforeRequest: () => ({ system: 'added' }) })
    await ask('hi', { provider, system: 'old' })

    expect(provider.seen).toEqual({ messages: ['hi'], system: ['added'] })
  })

  it('refuses the ask with the error it throws, calls onError and never asks the provider', async () => {
    const provider = echo()
    const errors: unknown[] = []

    ai({ beforeRequest: () => {
      throw new AiError('invalid', 'moderated')
    }, onError: ({ error }) => errors.push(error) })

    await expect(Promise.resolve(ask('bad', { provider }))).rejects.toThrow('moderated')
    expect(provider.seen.messages).toEqual([])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(AiError)
  })

  it('may be async, and one given to the ask runs after the one of ai()', async () => {
    const provider = echo()
    const heard: string[] = []

    ai({ beforeRequest: () => {
      heard.push('global')
    } })

    await ask('hi', { provider, beforeRequest: async () => {
      await Bun.sleep(1)
      heard.push('own')

      return { messages: [{ role: 'user', content: 'changed' }] }
    } })

    expect(heard).toEqual(['global', 'own'])
    expect(provider.seen.messages).toEqual(['changed'])
  })

  it('counts the request it left against the budget, once', async () => {
    const provider: Provider = { name: 'mute', model: 'm', async* stream() {
      yield { text: 'ok' }
    } }

    ai({ budget: { tokens: 100, window: '1m' }, beforeRequest: ({ messages }) => messages[0]!.content === 'hi' ? { messages: [{ role: 'user', content: 'x'.repeat(400) }] } : undefined })

    // 400 characters stand for 100 input tokens when the provider counts none: the short original would have counted 2 in all.
    await ask('hi', { provider, key: 'visitor' })
    await expect(Promise.resolve(ask('again', { provider, key: 'visitor' }))).rejects.toMatchObject({ kind: 'limited' })
  })

  it('is not counted against the budget when it refuses', async () => {
    ai({ budget: { tokens: 100, window: '1m' }, beforeRequest: () => {
      throw new AiError('invalid', 'no')
    } })

    for (let tries = 0; tries < 3; tries++)
      await expect(Promise.resolve(ask('hi', { provider: echo(), key: 'visitor' }))).rejects.toMatchObject({ kind: 'invalid' })
  })

  it('refuses a request it grew past maxInputChars', async () => {
    ai({ beforeRequest: () => ({ messages: [{ role: 'user', content: 'x'.repeat(100) }] }) })

    await expect(Promise.resolve(ask('hi', { provider: echo(), maxInputChars: 50 }))).rejects.toMatchObject({ kind: 'too-long' })
  })

  it('refuses an answer that is neither nothing nor { messages, system }', async () => {
    ai({ beforeRequest: () => 'text' as never })

    await expect(Promise.resolve(ask('hi', { provider: echo() }))).rejects.toThrow('beforeRequest returns')
  })

  it('applies to a structured ask and to the system prompt of ground()', async () => {
    const provider = echo()
    const grounded = ground([{ title: 'T', href: '/t', text: 'body' }], item => item)

    ai({ beforeRequest: ({ system }) => ({ system: `${system ?? ''} audited` }) })

    await ask('hi', { provider, system: grounded.system, sources: grounded.sources })
    expect(provider.seen.system[0]).toEndWith(' audited')
    expect(provider.seen.system[0]).toContain('<passage')
  })
})

describe('onStep, onToolCall, onSuccess', () => {
  it('fire once per request, per call state and per reply', async () => {
    const events: string[] = []

    ai({
      onStep: step => events.push(`step ${step.calls.length} ${step.finish}`),
      onToolCall: call => events.push(`call ${call.name} ${call.status}`),
      onSuccess: done => events.push(`finish ${done.text} ${done.usage?.inputTokens} ${done.steps.length} ${done.finish} ${done.stopped}`),
    })

    const reply = ask('go', { provider: echo(undefined, 1), tools: [looked] })

    await reply
    await reply.steps

    expect(events).toEqual(['call look running', 'call look done', 'step 1 undefined', 'step 0 stop', 'finish echo: 8 2 stop false'])
  })

  it('fire for a reply read twice only once', async () => {
    let finished = 0

    ai({ onSuccess: () => {
      finished++
    } })

    const reply = ask('hi', { provider: echo() })

    await reply
    await reply
    await reply.usage

    expect(finished).toBe(1)
  })

  it('report a stopped reply as stopped, with what it had', async () => {
    const done: unknown[] = []
    const slow: Provider = { name: 'slow', model: 'm', async* stream(_request, signal) {
      yield { text: 'start ' }
      await new Promise(resolve => signal.addEventListener('abort', resolve))
    } }

    ai({ onSuccess: result => done.push(result) })

    const reply = ask('hi', { provider: slow })

    setTimeout(() => reply.stop(), 20)
    await reply
    expect(done).toMatchObject([{ text: 'start ', stopped: true }])
  })

  it('leave a failed reply to onError alone', async () => {
    const heard: string[] = []
    const broken: Provider = { name: 'broken', model: 'm', async* stream() {
      yield { text: 'half' }

      throw new AiError('unavailable', 'down')
    } }

    ai({ onSuccess: () => heard.push('finish'), onError: ({ error }) => heard.push(`error ${(error as AiError).kind}`) })

    await expect(Promise.resolve(ask('hi', { provider: broken }))).rejects.toThrow('down')
    expect(heard).toEqual(['error unavailable'])
  })

  it('never fail the reply when a hook throws or rejects', async () => {
    const log = spyOn(console, 'error').mockImplementation(() => undefined)

    ai({
      onStep: () => {
        throw new Error('step')
      },
      onSuccess: async () => Promise.reject(new Error('finish')),
    })

    try {
      expect(await ask('hi', { provider: echo() })).toBe('echo:hi')
      await Bun.sleep(5)
    }
    finally {
      log.mockRestore()
    }
  })

  it('are added to by the ones of the ask', async () => {
    const heard: string[] = []

    ai({ onSuccess: () => heard.push('global finish'), onStep: () => heard.push('global step') })
    await ask('hi', { provider: echo(), onSuccess: () => heard.push('own finish') })

    expect(heard).toEqual(['global step', 'global finish', 'own finish'])
  })
})

describe('the fake', () => {
  it('runs the hooks of ai() for no ask it answers, and those of the ask itself for every one', async () => {
    delete process.env.KAYJS_AI_REAL_PROVIDERS

    const heard: string[] = []

    ai({ onSuccess: () => heard.push('global') })
    fakeAi.reply('one')
    fakeAi.reply('two')

    expect(await ask('hi')).toBe('one')
    expect(await ask('hi', { onSuccess: () => heard.push('own') })).toBe('two')
    expect(heard).toEqual(['own'])
  })
})

describe('structured asks and failed calls', () => {
  it('run the hooks once for a schema ask', async () => {
    const heard: string[] = []
    const json: Provider = { name: 'json', model: 'm', async* stream() {
      yield { text: '{"a":1}' }
    } }

    ai({ beforeRequest: () => {
      heard.push('request')
    }, onSuccess: () => heard.push('finish') })

    expect(await ask('hi', { provider: json, schema: s.Object({ a: s.Number() }) })).toEqual({ a: 1 })
    expect(heard).toEqual(['request', 'finish'])
  })

  it('tell onToolCall a call that failed', async () => {
    const statuses: string[] = []
    const broken = tool({ name: 'look', description: 'Looks', input: s.Object({}), run: () => {
      throw new Error('no')
    } })

    const log = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      ai({ onToolCall: call => statuses.push(call.status) })
      await ask('go', { provider: echo(undefined, 1), tools: [broken] })
    }
    finally {
      log.mockRestore()
    }

    expect(statuses).toEqual(['running', 'failed'])
  })
})

describe('the hook convention', () => {
  it('gives every hook the context of the request, and tells onError an object', async () => {
    const seen: unknown[] = []
    const broken: Provider = { name: 'broken', model: 'm', async* stream() {
      throw new AiError('invalid', 'no')
    } }

    ai({
      beforeRequest: ({ context }) => {
        seen.push(Object.keys(context).sort())
      },
      onError: failure => seen.push(failure),
    })

    await expect(Promise.resolve(ask('hi', { provider: broken }))).rejects.toThrow('no')
    expect(seen[0]).toEqual(['ip', 'locale', 'request', 'userAgent', 'userId'])
    expect(seen[1]).toMatchObject({ error: { kind: 'invalid' }, context: { request: undefined } })
  })

  it('refuses the ask on false with a refusal, calling onError and never asking the provider', async () => {
    const provider = echo()
    const errors: unknown[] = []

    ai({ beforeRequest: () => false, onError: ({ error }) => errors.push(error) })

    await expect(Promise.resolve(ask('hi', { provider }))).rejects.toMatchObject({ [Symbol.for('kay.refused')]: { status: 403 } })
    expect(provider.seen.messages).toEqual([])
    expect(errors).toHaveLength(1)
  })

  it('runs the beforeRequest of ai(), then the ask\'s, each seeing what the one before changed', async () => {
    const provider = echo()
    const seen: string[] = []

    ai({
      beforeRequest: ({ system }) => {
        seen.push(`new ${system}`)

        return { system: 'new' }
      },
    })

    await ask('hi', { provider, system: 'asked', beforeRequest: ({ system }) => {
      seen.push(`own ${system}`)
    } })

    expect(seen).toEqual(['new asked', 'own new'])
    expect(provider.seen.system).toEqual(['new'])
  })

  it('tells onSuccess of a finished reply and not of a failed one', async () => {
    const heard: string[] = []
    const broken: Provider = { name: 'broken', model: 'm', async* stream() {
      throw new AiError('invalid', 'no')
    } }

    ai({ onSuccess: () => heard.push('success') })

    await ask('hi', { provider: echo() })
    expect(heard).toEqual(['success'])

    await expect(Promise.resolve(ask('hi', { provider: broken }))).rejects.toThrow('no')
    expect(heard).toEqual(['success'])
  })

  it('reports a hook that throws with its source and still runs the next one', async () => {
    const sources: (string | undefined)[] = []
    const heard: string[] = []

    const log = spyOn(console, 'error').mockImplementation(() => undefined)

    useAppOnError(({ source }) => {
      sources.push(source)
    })

    ai({
      onStep: () => {
        throw new Error('step')
      },
      onSuccess: async () => Promise.reject(new Error('success')),
    })

    try {
      await ask('hi', { provider: echo(), onStep: () => heard.push('own step'), onSuccess: () => heard.push('own success') })
      await Bun.sleep(10)
    }
    finally {
      log.mockRestore()
    }

    expect(heard).toEqual(['own step', 'own success'])
    expect(sources.sort()).toEqual(['ai.onStep', 'ai.onSuccess'])
  })

  it('accepts the new names in ai() and refuses one that is no function', () => {
    expect(() => ai({ beforeRequest: 'no' as never })).toThrow('beforeRequest')
    expect(() => ai({ onSuccess: 'no' as never })).toThrow('onSuccess')
    expect(() => ai({ beforeRequest: () => undefined, onSuccess: () => undefined })).not.toThrow()
  })
})
