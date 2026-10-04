import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { attempt, dismissToast, holdToasts, toast, toasts } from '../src/toast'

function shown() {
  return toasts().map(({ message, type }) => ({ message, type }))
}

beforeEach(() => {
  toasts.set([])
})

describe('toast', () => {
  test('queues each message with its type, in order', () => {
    toast.success('Saved')
    toast.error('Refused')

    expect(shown()).toEqual([{ message: 'Saved', type: 'success' }, { message: 'Refused', type: 'error' }])
  })

  test('dismisses one toast by its id', () => {
    toast.info('first')
    toast.info('second')
    dismissToast(toasts()[0]!.id)

    expect(shown()).toEqual([{ message: 'second', type: 'info' }])
  })
})

describe('a toast\'s time', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test('runs out after four seconds', () => {
    toast.info('Copied')
    jest.advanceTimersByTime(3999)

    expect(shown()).toEqual([{ message: 'Copied', type: 'info' }])

    jest.advanceTimersByTime(1)

    expect(shown()).toEqual([])
  })

  test('stops while anything holds the toasts, then goes on with what it had left', () => {
    toast.info('Copied')
    jest.advanceTimersByTime(1000)
    holdToasts('pointer', true)
    holdToasts('focus', true)
    toast.info('Saved')
    jest.advanceTimersByTime(10_000)
    holdToasts('pointer', false)
    jest.advanceTimersByTime(10_000)

    expect(shown().map(item => item.message)).toEqual(['Copied', 'Saved'])

    holdToasts('focus', false)
    jest.advanceTimersByTime(2999)

    expect(shown().map(item => item.message)).toEqual(['Copied', 'Saved'])

    jest.advanceTimersByTime(1)

    expect(shown().map(item => item.message)).toEqual(['Saved'])

    jest.advanceTimersByTime(1000)

    expect(shown()).toEqual([])
  })

  test('lets go of every hold once the last toast is dismissed, since the toaster hides with it', () => {
    toast.info('Copied')
    holdToasts('pointer', true)
    dismissToast(toasts()[0]!.id)
    toast.info('Saved')
    jest.advanceTimersByTime(4000)

    expect(shown()).toEqual([])
  })
})

describe('attempt', () => {
  test('toasts the failure instead of throwing, and resolves to undefined', async () => {
    expect(await attempt(async () => Promise.reject(new Error('refused')), 'Could not save')).toBeUndefined()
    expect(shown()).toEqual([{ message: 'Could not save', type: 'error' }])
  })

  test('stays quiet when the call goes through, and hands back what it returned', async () => {
    expect(await attempt(async () => Promise.resolve(42), 'Could not save')).toBe(42)
    expect(toasts()).toHaveLength(0)
  })
})
