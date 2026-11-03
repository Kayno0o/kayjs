import { afterAll, afterEach, describe, expect, it, jest } from 'bun:test'
import { refuse } from '../src/runtime'
import { RefusedError } from '../src/runtime/refuse'
import { decide, hookContext, notify } from '../src/server/library'
import { answeringRequest } from '../src/server/log'
import { useAppOnError } from '../src/server/report'
import { nameUser } from '../src/server/request-user'

interface Report { error: unknown, source: string | undefined, request: Request | undefined }

const reported: Report[] = []
let waiting: ((report: Report) => void)[] = []

useAppOnError(({ error, source, request }) => {
  const report = { error, source, request }

  reported.push(report)

  for (const wake of waiting)
    wake(report)

  waiting = []
})

afterEach(() => {
  reported.length = 0
  jest.useRealTimers()
})

afterAll(() => {
  useAppOnError(undefined)
})

// Resolves with the next error handed to the app's `onError`.
async function nextReport(): Promise<Report> {
  return new Promise((resolve) => {
    waiting.push(resolve)
  })
}

function deferred(): { promise: Promise<void>, resolve: () => void, reject: (error: unknown) => void } {
  let resolve!: () => void
  let reject!: (error: unknown) => void

  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })

  return { promise, resolve, reject }
}

describe('refuse', () => {
  it('throws a refusal with a default status of 403, or 422 for fields', async () => {
    expect(() => refuse()).toThrow(RefusedError)

    expect(await decide('t.plain', [() => refuse()], {})).toEqual({ refused: { status: 403, message: 'Refused', errors: {}, data: undefined } })
    expect(await decide('t.fields', [() => refuse('Fix it', { errors: { name: 'required' }, data: 1 })], {})).toEqual({ refused: { status: 422, message: 'Fix it', errors: { name: 'required' }, data: 1 } })
  })

  it('refuses a status outside 400 to 599', () => {
    expect(() => refuse('x', { status: 200 })).toThrow(RangeError)
  })

  it('carries its refusal under Symbol.for(kay.refused)', () => {
    try {
      refuse('x', { status: 409, data: 3 })
    }
    catch (error) {
      expect((error as Record<symbol, unknown>)[Symbol.for('kay.refused')]).toEqual({ status: 409, message: 'x', errors: {}, data: 3 })
    }
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

  it('goes on without the user when a library naming it throws', async () => {
    const request = new Request('http://localhost/')

    nameUser(request, () => {
      throw new Error('namer')
    })

    expect((await answeringRequest(request, async () => hookContext())).userId).toBeUndefined()
  })
})

describe('notify', () => {
  it('runs the hooks in order with the event and a context, skipping undefined ones', async () => {
    const seen: string[] = []
    const gate = deferred()

    const run = notify('t.order', [
      ({ id, context }) => {
        seen.push(`a${id}${context.request === undefined}`)
      },
      undefined,
      async ({ id }) => {
        await gate.promise
        seen.push(`b${id}`)
      },
      ({ id }) => {
        seen.push(`c${id}`)
      },
    ], { id: 1 })

    await Promise.resolve()
    expect(seen).toEqual(['a1true'])
    gate.resolve()
    await run
    expect(seen).toEqual(['a1true', 'b1', 'c1'])
  })

  it('tells the request and its user to the hooks', async () => {
    const request = new Request('http://localhost/', { headers: { 'user-agent': 'tester' } })
    const told: unknown[] = []

    nameUser(request, () => 'user-2')
    await answeringRequest(request, async () => notify('t.context', [({ context }) => {
      told.push(context.request, context.userId, context.userAgent)
    }], {}))

    expect(told).toEqual([request, 'user-2', 'tester'])
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

  it('leaves a hook running after 10 s, reports it late and goes on', async () => {
    jest.useFakeTimers()

    const seen: string[] = []
    const gate = deferred()

    const run = notify('t.slow', [
      async () => {
        await gate.promise
        seen.push('slow')
      },
      () => {
        seen.push('next')
      },
    ], {})

    await Promise.resolve()
    jest.advanceTimersByTime(9_999)
    await Promise.resolve()
    expect(seen).toEqual([])
    jest.advanceTimersByTime(1)
    await run

    expect(seen).toEqual(['next'])
    expect(reported).toHaveLength(1)
    expect(String(reported[0]?.error)).toContain('did not finish in 10000 ms')

    gate.resolve()
    await Promise.resolve()
    expect(seen).toContain('slow')
  })

  it('reports a hook failing after its cap', async () => {
    jest.useFakeTimers()

    const gate = deferred()
    const run = notify('t.late-throw', [async () => {
      await gate.promise

      throw new Error('late')
    }], {})

    await Promise.resolve()
    jest.advanceTimersByTime(10_000)
    await run

    const next = nextReport()

    gate.resolve()

    expect(String((await next).error)).toBe('Error: late')
    expect(reported.map(({ error }) => String(error))).toEqual(['Error: t.late-throw did not finish in 10000 ms, left running', 'Error: late'])
  })

  it('does not wait for a detached hook', async () => {
    const seen: string[] = []
    const gate = deferred()
    const done = deferred()

    await notify('t.detached', [async () => {
      await gate.promise
      seen.push('done')
      done.resolve()
    }], {}, { detached: true })

    expect(seen).toEqual([])
    gate.resolve()
    await done.promise
    expect(seen).toEqual(['done'])
  })

  it('reports a detached hook that throws', async () => {
    const next = nextReport()

    await notify('t.detached-throw', [() => {
      throw new Error('x')
    }], {}, { detached: true })

    expect((await next).source).toBe('t.detached-throw')
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

  it('tells the request and its user to the hooks', async () => {
    const request = new Request('http://localhost/', { headers: { 'user-agent': 'tester' } })
    const told: unknown[] = []

    nameUser(request, () => 'user-3')
    await answeringRequest(request, async () => decide('t.context', [({ context }) => {
      told.push(context.request, context.userId, context.userAgent)
    }], {}))

    expect(told).toEqual([request, 'user-3', 'tester'])
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

  it('returns a fresh refusal each time', async () => {
    const first = await decide('t.fresh', [() => false], {})
    const second = await decide('t.fresh', [() => false], {})

    expect(first).toEqual(second)
    expect(first).not.toBe(second)
  })

  it('honours any error carrying kay.refused, such as a library\'s', async () => {
    const answer = await decide('t.library', [() => {
      throw Object.assign(new Error('limit'), { [Symbol.for('kay.refused')]: { status: 429, retryAfter: 5, message: 'Slow down' } })
    }], {})

    expect(answer).toEqual({ refused: { status: 429, message: 'Slow down', errors: {}, data: undefined } })
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
