import { describe, expect, it } from 'bun:test'
import { connection, listenerSet, retryLater } from '../src/runtime/connection'

const sleep = async (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('retryLater', () => {
  it('runs after the backoff, and not once cancelled', async () => {
    let runs = 0
    const cancel = retryLater(0, () => runs++, { firstMs: 5, waitOnline: true })

    await sleep(30)
    expect(runs).toBe(1)

    retryLater(0, () => runs++, { firstMs: 5, waitOnline: true })()
    await sleep(30)
    expect(runs).toBe(1)
    cancel()
  })
})

describe('listenerSet', () => {
  it('calls every listener, one throwing leaving the others alone, and stops a removed one', () => {
    const set = listenerSet<number>()
    const seen: number[] = []
    const quiet = console.error

    console.error = () => undefined

    try {
      set.on(() => {
        throw new Error('boom')
      })

      const off = set.on(value => seen.push(value))

      set.emit(1)
      off()
      set.emit(2)
    }
    finally {
      console.error = quiet
    }

    expect(seen).toEqual([1])
  })
})

describe('connection', () => {
  it('keeps the last value and the status, retries a drop after the backoff and fails when it may not reconnect', async () => {
    let opened = 0
    const link = connection<string>(() => void opened++, true)

    expect(link.status()).toBe('connecting')
    link.receive('a')
    expect(link.last()).toBe('a')
    link.set('open')
    link.lost()
    expect(link.status()).toBe('connecting')
    link.stop()
    await sleep(900)
    expect(opened).toBe(0)

    link.forget()
    expect(link.last()).toBeUndefined()

    const once = connection<string>(() => undefined, false)

    once.lost()
    expect(once.status()).toBe('failed')
    expect(connection<string>(() => undefined, false, true).status()).toBe('idle')
  })
})
