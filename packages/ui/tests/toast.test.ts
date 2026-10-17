import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { ActionError } from 'kay'
import { attempt, dismissToast, holdToasts, toast, toasts } from '../src/toast'

function shown() {
  return toasts().map(({ message, type }) => ({ message, type }))
}

beforeEach(() => {
  toasts.set([])
})

// The fixture site renders Toaster in this same process, so no toast may outlive its test.
afterEach(() => {
  for (const { id } of toasts())
    dismissToast(id)
})

describe('toast', () => {
  test('queues each message with its type, in order', () => {
    toast.success('Saved')
    toast.error('Refused')

    expect(shown()).toEqual([{ message: 'Saved', type: 'success' }, { message: 'Refused', type: 'error' }])
  })

  test('carries the tone of its type, a failed call being a danger, and the deprecated type beside it', () => {
    toast.error('Refused')
    toast.success('Saved')
    toast.info('Copied')

    expect(toasts().map(({ tone, type }) => [tone, type])).toEqual([['danger', 'error'], ['success', 'success'], ['info', 'info']])
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

  test('runs out after six seconds, an error after ten', () => {
    toast.info('Copied')
    toast.error('Refused')
    jest.advanceTimersByTime(5999)

    expect(shown().map(item => item.message)).toEqual(['Copied', 'Refused'])

    jest.advanceTimersByTime(1)

    expect(shown().map(item => item.message)).toEqual(['Refused'])

    jest.advanceTimersByTime(4000)

    expect(shown()).toEqual([])
  })

  test('runs for the duration it is given, whatever its tone', () => {
    toast.info('Short', { duration: 1000 })
    toast.error('Long', { duration: 20_000 })
    jest.advanceTimersByTime(999)

    expect(shown().map(item => item.message)).toEqual(['Short', 'Long'])

    jest.advanceTimersByTime(1)

    expect(shown().map(item => item.message)).toEqual(['Long'])

    jest.advanceTimersByTime(18_999)

    expect(shown().map(item => item.message)).toEqual(['Long'])

    jest.advanceTimersByTime(1)

    expect(shown()).toEqual([])
  })

  test('falls back to the default time for a duration that is not a time', () => {
    toast.info('NaN', { duration: Number.NaN })
    toast.info('Negative', { duration: -5 })
    toast.info('Unset', { duration: undefined })
    jest.advanceTimersByTime(6000)

    expect(shown()).toEqual([])
  })

  test('stays until dismissed with an infinite duration, holds and releases included, and answers its id', () => {
    const sticky = toast.error('Stuck', { duration: Infinity })

    toast.info('Gone')
    jest.advanceTimersByTime(60_000)

    expect(shown().map(item => item.message)).toEqual(['Stuck'])

    holdToasts('pointer', true)
    holdToasts('pointer', false)
    jest.advanceTimersByTime(60_000)

    expect(shown().map(item => item.message)).toEqual(['Stuck'])

    dismissToast(sticky)

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
    jest.advanceTimersByTime(4999)

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
    jest.advanceTimersByTime(6000)

    expect(shown()).toEqual([])
  })
})

describe('attempt', () => {
  test('toasts the failure instead of throwing, and resolves to undefined', async () => {
    expect(await attempt(async () => Promise.reject(new Error('refused')), 'Could not save')).toBeUndefined()
    expect(shown()).toEqual([{ message: 'Could not save', type: 'error' }])
  })

  test('toasts what `refused` reads from the handler\'s refusal, or a refusal of the whole call, before `failure`', async () => {
    const refused = (data: { error?: string }) => data.error
    const reject = (error: Error) => async () => Promise.reject(error)

    await attempt(reject(new ActionError(400, '', {}, { error: 'Still referenced' })), 'Could not delete', refused)
    await attempt(reject(new ActionError(400, '', {}, { error: '' })), 'Could not delete', refused)
    await attempt(reject(new ActionError(429, '', { '': 'Too many tries' })), 'Could not delete', refused)
    await attempt(reject(new ActionError(400, '', {}, { error: 'Still referenced' })), 'Could not delete')
    // A schema refusal and a plain error carry no handler data, so `refused` is never asked.
    await attempt(reject(new ActionError(422, '', { name: 'Required' })), 'Could not delete', refused)
    await attempt(reject(new Error('offline')), 'Could not delete', refused)
    // An empty refusal says nothing, so `failure` goes in its place.
    await attempt(reject(new ActionError(400, '', { '': '' }, { error: '' })), 'Could not delete', refused)

    expect(shown().map(({ message }) => message)).toEqual(['Still referenced', 'Could not delete', 'Too many tries', 'Could not delete', 'Could not delete', 'Could not delete', 'Could not delete'])
  })

  test('stays quiet when the call goes through, and hands back what it returned', async () => {
    expect(await attempt(async () => Promise.resolve(42), 'Could not save')).toBe(42)
    expect(toasts()).toHaveLength(0)
  })

  test('resolves to true for a call returning nothing, so only a failure is undefined', async () => {
    expect(await attempt(async () => undefined, 'Could not save')).toBe(true)
  })

  test('takes its messages as options, toasting `success` once the call goes through', async () => {
    expect(await attempt(async () => undefined, { failure: 'Could not save', success: 'Saved' })).toBe(true)
    expect(await attempt(async () => Promise.reject(new ActionError(409, '', {}, { error: 'Taken' })), { failure: 'Could not save', success: 'Saved', refused: (data: { error: string }) => data.error })).toBeUndefined()
    expect(shown()).toEqual([{ message: 'Saved', type: 'success' }, { message: 'Taken', type: 'error' }])
  })
})
