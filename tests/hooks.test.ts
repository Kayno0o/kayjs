import { afterEach, describe, expect, it } from 'bun:test'
import { refuse } from '../src/runtime'
import { RefusedError } from '../src/runtime/refuse'
import { decide, hookContext, notify } from '../src/server/library'
import { answeringRequest } from '../src/server/log'
import { useAppOnError } from '../src/server/report'
import { nameUser } from '../src/server/request-user'

const reported: { error: unknown, source: string | undefined, request: Request | undefined }[] = []

useAppOnError(({ error, source, request }) => {
  reported.push({ error, source, request })
})

afterEach(() => {
  reported.length = 0
})

describe('refuse', () => {
  it('throws a refusal with a default status of 403, or 422 for fields', async () => {
    expect(() => refuse()).toThrow(RefusedError)

    const plain = decide('t.plain', [() => refuse()], {})
    const fields = decide('t.fields', [() => refuse('Fix it', { errors: { name: 'required' }, data: 1 })], {})

    return Promise.all([
      expect(plain).resolves.toEqual({ refused: { status: 403, message: 'Refused', errors: {}, data: undefined } }),
      expect(fields).resolves.toEqual({ refused: { status: 422, message: 'Fix it', errors: { name: 'required' }, data: 1 } }),
    ])
  })

  it('refuses an status outside 400 to 599', () => {
    expect(() => refuse('x', { status: 200 })).toThrow(RangeError)
  })
})

describe('hookContext', () => {
  it('is empty outside a request', async () => {
    expect(await hookContext()).toEqual({ request: undefined, ip: undefined, userAgent: undefined, userId: undefined, locale: undefined })
  })

  it('reads the request, its user agent and the user a library named', async () => {
    const request = new Request('http://localhost/', { headers: { 'user-agent': 'tester' } })

    nameUser(request, () => 'user-1')

    const context = await answeringRequest(request, async () => hookContext())

    expect(context.request).toBe(request)
    expect(context.userAgent).toBe('tester')
    expect(context.userId).toBe('user-1')
  })
})

describe('notify', () => {
  it('runs the hooks in order with the event and a context, skipping undefined ones', async () => {
    const seen: string[] = []

    await notify('t.order', [
      ({ id, context }) => {
        seen.push(`a${id}${context.request === undefined}`)
      },
      undefined,
      async ({ id }) => {
        await Bun.sleep(5)
        seen.push(`b${id}`)
      },
      ({ id }) => {
        seen.push(`c${id}`)
      },
    ], { id: 1 })

    expect(seen).toEqual(['a1true', 'b1', 'c1'])
  })

  it('logs a throw, reports it with its source and still runs the next hook', async () => {
    const boom = new Error('boom')
    const seen: number[] = []

    await notify('t.throw', [
      () => {
        throw boom
      },
      () => {
        seen.push(2)
      },
    ], {})

    expect(seen).toEqual([2])
    expect(reported).toHaveLength(1)
    expect(reported[0]?.error).toBe(boom)
    expect(reported[0]?.source).toBe('t.throw')
  })

  it('waits for a slow hook up to the cap, reports it late and goes on', async () => {
    const seen: string[] = []
    const started = performance.now()

    await notify('t.slow', [
      async () => {
        await Bun.sleep(60)
        seen.push('slow')
      },
      () => {
        seen.push('next')
      },
    ], {}, { timeout: 10 })

    expect(performance.now() - started).toBeLessThan(55)
    expect(seen).toEqual(['next'])
    expect(reported).toHaveLength(1)
    expect(String(reported[0]?.error)).toContain('did not finish in 10 ms')

    await Bun.sleep(80)
    expect(seen).toEqual(['next', 'slow'])
  })

  it('reports a hook failing after its cap', async () => {
    await notify('t.late-throw', [
      async () => {
        await Bun.sleep(30)

        throw new Error('late')
      },
    ], {}, { timeout: 5 })
    await Bun.sleep(60)

    expect(reported.map(({ error }) => String(error))).toEqual(['Error: t.late-throw did not finish in 5 ms, left running', 'Error: late'])
  })

  it('does not wait for a detached hook', async () => {
    const seen: string[] = []

    await notify('t.detached', [
      async () => {
        await Bun.sleep(30)
        seen.push('done')
      },
    ], {}, { detached: true })

    expect(seen).toEqual([])
    await Bun.sleep(60)
    expect(seen).toEqual(['done'])
  })

  it('reports a detached hook that throws', async () => {
    await notify('t.detached-throw', [() => {
      throw new Error('x')
    }], {}, { detached: true })
    await Bun.sleep(10)

    expect(reported.map(({ source }) => source)).toEqual(['t.detached-throw'])
  })

  it('reports under the request being answered', async () => {
    const request = new Request('http://localhost/')

    await answeringRequest(request, async () => notify('t.request', [() => {
      throw new Error('x')
    }], {}))

    expect(reported[0]?.request).toBe(request)
  })
})

describe('decide', () => {
  interface Input { name: string, tags: string[] }

  it('answers an empty change with no hook or no change', async () => {
    expect(await decide<Input, Input>('t.none', [], { name: 'a', tags: [] })).toEqual({ change: {} })
    expect(await decide<Input, Input>('t.void', [undefined, () => undefined], { name: 'a', tags: [] })).toEqual({ change: {} })
  })

  it('lays each change over the last, each hook seeing the value before', async () => {
    const seen: string[] = []

    const answer = await decide<Input, Input>('t.chain', [
      ({ name }) => {
        seen.push(name)

        return { name: `${name}b` }
      },
      async ({ name }) => {
        seen.push(name)

        return { name: `${name}c`, tags: ['x'] }
      },
    ], { name: 'a', tags: [] })

    expect(seen).toEqual(['a', 'ab'])
    expect(answer).toEqual({ change: { name: 'abc', tags: ['x'] } })
  })

  it('stops at the first refusal, by false or refuse()', async () => {
    const ran: number[] = []

    const byFalse = await decide<Input, Input>('t.false', [() => false, () => {
      ran.push(2)
    }], { name: 'a', tags: [] })

    const byRefuse = await decide<Input, Input>('t.refuse', [() => refuse('No', { status: 409 }), () => {
      ran.push(3)
    }], { name: 'a', tags: [] })

    expect(byFalse).toEqual({ refused: { status: 403, message: 'Refused', errors: {}, data: undefined } })
    expect(byRefuse).toEqual({ refused: { status: 409, message: 'No', errors: {}, data: undefined } })
    expect(ran).toEqual([])
    expect(reported).toEqual([])
  })

  it('refuses as a server error on any other throw, after reporting it', async () => {
    const boom = new Error('boom')

    const answer = await decide<Input, Input>('t.boom', [() => {
      throw boom
    }], { name: 'a', tags: [] })

    expect(answer).toEqual({ refused: { status: 500, message: 'Internal server error', errors: {}, data: undefined } })
    expect(reported.map(({ error, source }) => [error, source])).toEqual([[boom, 't.boom']])
  })

  it('ignores a returned value that is not an object', async () => {
    expect(await decide<Input, Input>('t.odd', [() => true as never, () => ['x'] as never], { name: 'a', tags: [] })).toEqual({ change: {} })
  })
})
