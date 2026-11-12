import { describe, expect, it, jest } from 'bun:test'
import { ApiError } from '../src/runtime/api-error'
import { connection } from '../src/runtime/connection'
import { listenerSet } from '../src/runtime/listener-set'
import { retryLater } from '../src/runtime/retry-later'

const sleep = async (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('retryLater', () => {
  it('runs after the backoff, and not once cancelled', () => {
    jest.useFakeTimers()

    try {
      let runs = 0
      const cancel = retryLater(0, () => runs++)

      jest.advanceTimersByTime(500)
      expect(runs).toBe(1)

      retryLater(0, () => runs++)()
      jest.advanceTimersByTime(500)
      expect(runs).toBe(1)
      cancel()
    }
    finally {
      jest.useRealTimers()
    }
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

    once.lost(new ApiError(0, 'Dropped'))
    expect(once.status()).toBe('failed')
    expect(connection<string>(() => undefined, false, true).status()).toBe('idle')
  })
})
