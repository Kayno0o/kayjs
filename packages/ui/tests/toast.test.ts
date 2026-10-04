import { beforeEach, describe, expect, test } from 'bun:test'
import { attempt, dismissToast, toast, toasts } from '../src/toast'

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
