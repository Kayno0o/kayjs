import process from 'node:process'
import { expect, test } from 'bun:test'
import { renderOnServer } from '../../../src/runtime/reactive'
import { asyncRows } from '../src/source'

// A component rendering on the server runs no effect: what a source draws there.
test('on the server an array is drawn, a function is never called and a promise is the skeleton', async () => {
  let calls = 0
  const seen = renderOnServer(() => {
    const rows = asyncRows<number>(() => [1, 2])
    const fn = asyncRows<number>(() => () => {
      calls++

      return [1]
    })
    const promise = asyncRows<number>(async () => new Promise<number[]>(() => undefined))

    return { rows: rows.rows(), arrayLoading: rows.loading(), fn: fn.rows(), fnLoading: fn.loading(), promiseLoading: promise.loading() }
  })

  await new Promise(resolve => setTimeout(resolve, 10))

  expect(seen).toEqual({ rows: [1, 2], arrayLoading: false, fn: [], fnLoading: true, promiseLoading: true })
  expect(calls).toBe(0)
})

test('a promise rejecting during a server render is consumed, never unhandled', async () => {
  const unhandled: unknown[] = []
  const listener = (error: unknown) => unhandled.push(error)

  process.on('unhandledRejection', listener)
  renderOnServer(() => asyncRows<number>(async () => Promise.reject(new Error('down'))))
  await new Promise(resolve => setTimeout(resolve, 20))
  process.off('unhandledRejection', listener)

  expect(unhandled).toEqual([])
})
