import type { JobStore } from '../src/server'
import { afterEach, describe, expect, it, setSystemTime } from 'bun:test'
import { workflow as makeWorkflow, memoryJobs } from '../src/server'
import { forgetQueue } from '../src/server/queue'
import { cleanUpAfterFile, kinds } from './job-stores'

cleanUpAfterFile()

let names = 0
const made: { drain: () => Promise<number> }[] = []

function workflow<Input, Known extends Record<string, unknown> = Record<string, unknown>>(...args: Parameters<typeof makeWorkflow<Input, Known>>) {
  const created = makeWorkflow<Input, Known>(...args)

  made.push(created)

  return created
}

afterEach(() => {
  setSystemTime()

  for (const created of made.splice(0))
    forgetQueue(created)
})

const noop = () => undefined
const named = () => `flow-${++names}`
const MINUTE = 60_000
const later = (ms: number) => setSystemTime(Date.now() + ms)

describe.each(kinds)('a workflow on a $name store', ({ open }) => {
  it('runs each step once and passes the results of the steps before', async () => {
    const store = await open()
    const calls: string[] = []
    const flow = workflow<{ to: string }>(named(), async ({ input, step }) => {
      const code = await step.run('code', () => {
        calls.push('code')

        return { value: 42, when: new Date(0) }
      })

      await step.run('mail', () => void calls.push(`mail ${input.to} ${code.value} ${code.when.getTime()}`))
    }, { store })
    const id = await flow.start({ to: 'a@b.c' })

    expect(await flow.status(id)).toMatchObject({ status: 'sleeping', steps: 0 })
    await flow.drain()
    expect(calls).toEqual(['code', 'mail a@b.c 42 0'])
    expect(await flow.status(id)).toBeUndefined()
  })

  it('resumes at the next step when a step fails, without running the finished ones again', async () => {
    const store = await open()
    const calls: string[] = []
    let fail = true
    const flow = workflow<undefined>(named(), async ({ step }) => {
      await step.run('one', () => void calls.push('one'))
      await step.run('two', () => {
        calls.push('two')

        if (fail)
          throw new Error('boom')
      })
      await step.run('three', () => void calls.push('three'))
    }, { store, backoff: '1s' })

    const id = await flow.start()

    await flow.drain()
    expect(calls).toEqual(['one', 'two'])
    expect(await flow.status(id)).toMatchObject({ status: 'sleeping', steps: 1, error: 'boom' })
    fail = false
    later(2000)
    await flow.drain()
    expect(calls).toEqual(['one', 'two', 'two', 'three'])
  })

  it('does not spend its attempts across steps', async () => {
    const store = await open()
    const seen = new Set<string>()
    const flow = workflow<undefined>(named(), async ({ step }) => {
      for (const name of ['a', 'b', 'c']) {
        await step.run(name, () => {
          if (!seen.has(name)) {
            seen.add(name)

            throw new Error(`first ${name}`)
          }
        })
      }
    }, { store, attempts: 2, backoff: '1s' })
    const id = await flow.start()

    for (let round = 0; round < 4; round++) {
      await flow.drain()
      later(2000)
    }

    expect(await flow.status(id)).toBeUndefined()
    expect(seen.size).toBe(3)
  })

  it('retries a run that outlasts lostAfter from the steps it kept, in another process', async () => {
    const store = await open()
    const name = named()
    const calls: string[] = []
    const first = workflow<undefined>(name, async ({ step }) => {
      await step.run('one', () => void calls.push('one'))
      await step.run('two', async () => new Promise<void>(noop))
    }, { store, lostAfter: '300ms' })
    const id = await first.start()
    const stuck = first.drain()

    await Bun.sleep(50)
    forgetQueue(first)
    expect(await first.status(id)).toMatchObject({ status: 'running', steps: 1 })

    // The run outlasted lostAfter, which gave it back to retry once its backoff passed.
    await Bun.sleep(400)
    later(MINUTE)

    const second = workflow<undefined>(name, async ({ step }) => {
      await step.run('one', () => void calls.push('one again'))
      await step.run('two', () => void calls.push('two'))
    }, { store })

    expect(await second.drain()).toBe(1)
    expect(calls).toEqual(['one', 'two'])
    void stuck
  })

  it('sleeps without a process and wakes when its time comes', async () => {
    const store = await open()
    const calls: string[] = []
    const flow = workflow<undefined>(named(), async ({ step }) => {
      await step.run('before', () => void calls.push('before'))
      await step.sleep('3d')
      await step.run('after', () => void calls.push('after'))
    }, { store })
    const id = await flow.start()

    await flow.drain()
    expect(calls).toEqual(['before'])
    expect(await flow.status(id)).toMatchObject({ status: 'sleeping', steps: 2 })
    later(2 * 24 * 60 * MINUTE)
    await flow.drain()
    expect(calls).toEqual(['before'])
    later(24 * 60 * MINUTE + 1000)
    await flow.drain()
    expect(calls).toEqual(['before', 'after'])
    expect(await flow.status(id)).toBeUndefined()
  })

  it('wakes a waiting run with an event and its data', async () => {
    const store = await open()
    const got: unknown[] = []
    const flow = workflow<undefined, { paid: { amount: number }, other: undefined }>(named(), async ({ step }) => {
      got.push(await step.waitFor('paid'))
      await step.run('done', () => void got.push('done'))
    }, { store })
    const id = await flow.start()

    await flow.drain()
    expect(await flow.status(id)).toMatchObject({ status: 'waiting', event: 'paid' })
    expect(await flow.send('nobody', 'paid', { amount: 1 })).toBe(false)
    expect(await flow.send(id, 'paid', { amount: 12 })).toBe(true)
    await flow.drain()
    expect(got).toEqual([{ amount: 12 }, 'done'])
    expect(await flow.status(id)).toBeUndefined()
  })

  it('keeps an event sent before the run waits for it, even one sent right after start', async () => {
    const store = await open()
    const got: unknown[] = []
    const flow = workflow<undefined, { paid: number, other: string }>(named(), async ({ step }) => {
      await step.sleep('1h')
      await step.run('log', () => void got.push(['slept']))

      const paid = await step.waitFor('paid')

      await step.run('paid', () => void got.push(paid))
    }, { store })
    const id = await flow.start()

    expect(await flow.send(id, 'paid', 5)).toBe(true)
    expect(await flow.send(id, 'paid', 6)).toBe(true)
    await flow.drain()
    later(2 * 60 * MINUTE)
    await flow.drain()
    expect(got).toEqual([['slept'], 5])
  })

  it('wakes a run after a suspension even when the claims share a millisecond', async () => {
    const store = await open()
    const got: unknown[] = []
    const flow = workflow<undefined, { go: number }>(named(), async ({ step }) => {
      got.push(await step.waitFor('go'))
      await step.run('after', () => void got.push('after'))
    }, { store })
    const id = await flow.start()

    setSystemTime(new Date(Date.now()))
    await flow.drain()
    expect(await flow.send(id, 'go', 1)).toBe(true)
    await flow.drain()
    expect(got).toEqual([1, 'after'])
    expect(await flow.status(id)).toBeUndefined()
  })

  it('starts no step once its run lost the hold', async () => {
    const store = await open()
    const calls: string[] = []
    const flow = workflow<undefined>(named(), async ({ step }) => {
      await step.run('slow', async () => Bun.sleep(450))
      await step.run('next', () => void calls.push('next'))
    }, { store, lostAfter: '300ms' })

    await flow.start()
    await flow.drain()
    expect(calls).toEqual([])
  })

  it('times a wait out, and an event after that is dropped', async () => {
    const store = await open()
    const got: unknown[] = []
    const flow = workflow<undefined, { verified: string }>(named(), async ({ step }) => {
      const first = await step.waitFor('verified', { timeout: '3d' })

      await step.run('first', () => void got.push(first))

      const second = await step.waitFor('verified', { timeout: '1d' })

      await step.run('second', () => void got.push(second))
    }, { store })
    const id = await flow.start()

    await flow.drain()
    later(2 * 24 * 60 * MINUTE)
    await flow.drain()
    expect(got).toEqual([])
    later(24 * 60 * MINUTE + 1000)
    await flow.drain()
    expect(got).toEqual([{ timedOut: true }])
    expect(await flow.status(id)).toMatchObject({ status: 'waiting', event: 'verified', steps: 2 })
    expect(await flow.send(id, 'verified', 'yes')).toBe(true)
    await flow.drain()
    expect(got).toEqual([{ timedOut: true }, { timedOut: false, data: 'yes' }])
  })

  it('wakes only once when an event and a timeout race', async () => {
    const store = await open()
    const got: unknown[] = []
    const flow = workflow<undefined, { go: number }>(named(), async ({ step }) => {
      got.push(await step.waitFor('go', { timeout: '1h' }))
    }, { store })
    const id = await flow.start()

    await flow.drain()
    later(61 * MINUTE)

    const [sent] = await Promise.all([flow.send(id, 'go', 1), flow.drain()])

    expect(got).toHaveLength(1)
    expect(got[0]).toEqual(sent ? { timedOut: false, data: 1 } : { timedOut: true })
  })

  it('keeps one live run per id, and starts again once it ended', async () => {
    const store = await open()
    const ran: string[] = []
    const flow = workflow<string>(named(), async ({ id, input, step }) => {
      await step.run('go', () => void ran.push(`${id}:${input}`))
    }, { store })

    expect(await flow.start('a', { id: 'user-1' })).toBe('user-1')
    expect(await flow.start('b', { id: 'user-1' })).toBe('user-1')
    await flow.drain()
    expect(ran).toEqual(['user-1:a'])
    await flow.start('c', { id: 'user-1' })
    await flow.drain()
    expect(ran).toEqual(['user-1:a', 'user-1:c'])
  })

  it('starts after a delay', async () => {
    const store = await open()
    const ran: number[] = []
    const flow = workflow<undefined>(named(), async ({ step }) => step.run('go', () => void ran.push(1)), { store })

    await flow.start(undefined, { delay: '1h' })
    await flow.drain()
    expect(ran).toEqual([])
    later(61 * MINUTE)
    await flow.drain()
    expect(ran).toEqual([1])
  })

  it('cancels a sleeping run, and a running one at its next step', async () => {
    const store = await open()
    const ran: string[] = []
    const gate = Promise.withResolvers<void>()
    const flow = workflow<string>(named(), async ({ input, step }) => {
      if (input === 'running') {
        await step.run('wait', async () => gate.promise)
        await step.run('never', () => void ran.push('never'))
      }
      else {
        await step.sleep('1d')
        await step.run('never', () => void ran.push('never'))
      }
    }, { store })
    const sleeping = await flow.start('sleeping')

    await flow.drain()
    expect(await flow.cancel(sleeping)).toBe(true)
    expect(await flow.cancel(sleeping)).toBe(false)

    const running = await flow.start('running')
    const draining = flow.drain()

    await Bun.sleep(50)
    expect(await flow.status(running)).toMatchObject({ status: 'running' })
    expect(await flow.cancel(running)).toBe(true)
    gate.resolve()
    await draining
    later(2 * 24 * 60 * MINUTE)
    await flow.drain()
    expect(ran).toEqual([])
  })

  it('fails a run whose steps changed under it, and keeps it as failed with the error', async () => {
    const store = await open()
    const name = named()
    const before = workflow<undefined>(name, async ({ step }) => {
      await step.run('one', () => undefined)
      await step.sleep('1h')
    }, { store })
    const id = await before.start()

    await before.drain()
    forgetQueue(before)

    const failures: string[] = []
    const after = workflow<undefined>(name, async ({ step }) => {
      await step.run('renamed', () => undefined)
    }, { store, attempts: 1, onFailed: ({ error }) => void failures.push((error as Error).message) })

    later(2 * MINUTE * 60)
    await after.drain()
    expect(failures[0]).toContain('changed under a run')
    expect(await after.status(id)).toMatchObject({ status: 'failed' })
  })

  it('takes a try around a step as no way to swallow a sleep', async () => {
    const store = await open()
    const calls: string[] = []
    const flow = workflow<undefined>(named(), async ({ step }) => {
      try {
        await step.sleep('1h')
      }
      catch {
        calls.push('caught')
      }

      calls.push('after')
    }, { store })

    await flow.start()
    await flow.drain()
    expect(calls).toEqual([])
    later(2 * MINUTE * 60)
    await flow.drain()
    expect(calls).toEqual(['after'])
  })

  it('refuses a step result devalue cannot keep, and two steps at once', async () => {
    const store = await open()
    const failures: string[] = []
    const flow = workflow<number>(named(), async ({ input, step }) => {
      if (input === 1)
        await step.run('fn', () => () => 1)
      else
        await Promise.all([step.run('a', () => 1), step.run('b', () => 2)])
    }, { store, attempts: 1, onFailed: ({ error }) => void failures.push((error as Error).message) })

    await flow.start(1)
    await flow.start(2)
    await flow.drain()
    expect(failures.some(message => message.includes('devalue cannot keep'))).toBe(true)
    expect(failures.some(message => message.includes('two steps at once'))).toBe(true)
  })
})

describe('a workflow needs a store with update', () => {
  it('throws config-invalid when its store has none', async () => {
    const store: JobStore = { ...memoryJobs(), update: undefined }
    const flow = workflow<undefined>(named(), () => undefined, { store })

    await expect(flow.status('x')).rejects.toThrow('update()')
  })
})
