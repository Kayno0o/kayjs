import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { ActionError, ApiError, signal } from 'kay'
import { callAction } from '../src/forms'
import { attempt, dismissToast, holdToasts, messageOf, toast, toasts } from '../src/toast'

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

  test('takes any tone, the method giving its own by default, and a danger one keeps an error\'s guard', () => {
    toast.warning('Careful')
    toast.info('Quiet', { tone: 'neutral' })
    toast.success('Marked', { tone: 'accent' })
    toast.info('Failed', { tone: 'danger' })
    toast.info('Failed', { tone: 'danger' })

    expect(toasts().map(({ tone, type }) => [tone, type])).toEqual([['warning', 'info'], ['neutral', 'info'], ['accent', 'info'], ['danger', 'error']])
  })

  test('dismisses one toast by its id', () => {
    toast.info('first')
    toast.info('second')
    dismissToast(toasts()[0]!.id)

    expect(shown()).toEqual([{ message: 'second', type: 'info' }])
  })
})

describe('a toast\'s action', () => {
  const action = { label: 'Retry', run: () => 1 }

  test('is kept on the toast, and an error with the same words open is shown once', () => {
    toast.error('Offline', { action })
    toast.error('Offline', { action: { label: 'Other', run: () => 2 } })

    expect(toasts()).toHaveLength(1)
    expect(toasts()[0]!.action).toBe(action)
  })

  test('keeps the clock of its tone: none for an error, six seconds otherwise', () => {
    jest.useFakeTimers()

    toast.error('Refused', { action })
    toast.success('Saved', { action })
    jest.advanceTimersByTime(6000)

    expect(shown().map(item => item.message)).toEqual(['Refused'])
    jest.useRealTimers()
  })

  test('comes from `refusedAction` for a refusal, not for a failure', async () => {
    const refusedAction = (data: { error: string, diverged: boolean }) => data.diverged ? action : undefined
    const reject = (error: Error) => async () => Promise.reject(error)
    const refused = (data: { error: string, diverged: boolean }) => data.error

    await attempt(reject(new ActionError(400, '', {}, { error: 'Diverged', diverged: true })), { failure: 'Could not pull', refused, refusedAction })
    await attempt(reject(new ActionError(400, '', {}, { error: 'Locked', diverged: false })), { failure: 'Could not pull', refused, refusedAction })
    await attempt(reject(new Error('offline')), { failure: 'Could not pull', refused, refusedAction })

    expect(toasts().map(item => [item.message, item.action])).toEqual([['Diverged', action], ['Locked', undefined], ['Could not pull', undefined]])
  })

  test('is dropped, with the throw logged, when `refusedAction` throws', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined)

    await attempt(async () => Promise.reject(new ActionError(400, '', {}, { error: 'No' })), { failure: 'Could not pull', refused: (data: { error: string }) => data.error, refusedAction: () => {
      throw new Error('bug')
    } })

    expect(toasts().map(item => [item.message, item.action])).toEqual([['No', undefined]])
    expect(error).toHaveBeenCalledTimes(1)
    error.mockRestore()
  })
})

describe('a toast\'s action with onRefused', () => {
  test('shows no toast, so no button', async () => {
    await attempt(async () => Promise.reject(new ActionError(400, '', {}, { error: 'No' })), { failure: 'Could not pull', onRefused: () => undefined, refusedAction: () => ({ label: 'Retry', run: () => 1 }) })

    expect(shown()).toEqual([])
  })
})

describe('a toast\'s time', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test('runs out after six seconds, an error staying until it is dismissed', () => {
    toast.info('Copied')

    const refused = toast.error('Refused')

    jest.advanceTimersByTime(5999)

    expect(shown().map(item => item.message)).toEqual(['Copied', 'Refused'])

    jest.advanceTimersByTime(1)

    expect(shown().map(item => item.message)).toEqual(['Refused'])

    jest.advanceTimersByTime(600_000)

    expect(shown().map(item => item.message)).toEqual(['Refused'])
    dismissToast(refused)

    expect(shown()).toEqual([])
  })

  test('runs for the duration it is given, whatever its tone', () => {
    toast.info('Short', { duration: '1000ms' })
    toast.error('Long', { duration: '20000ms' })
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
    toast.info('NaN', { duration: 'soon' as never })
    toast.info('Negative', { duration: '-5s' as never })
    toast.info('Unset', { duration: undefined })
    jest.advanceTimersByTime(6000)

    expect(shown()).toEqual([])
  })

  test('shows an error already open once, answering the id of the shown one', () => {
    const first = toast.error('Offline')

    expect(toast.error('Offline')).toBe(first)
    toast.error('Other')
    expect(shown().map(item => item.message)).toEqual(['Offline', 'Other'])
  })

  test('stays until dismissed with an infinite duration, holds and releases included, and answers its id', () => {
    const sticky = toast.error('Stuck', { duration: false })

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
    // Without `refused`, a string, or a string `error` or `message`, that reads as a message is toasted.
    await attempt(reject(new ActionError(409, '', {}, { error: 'Name taken' })), 'Could not delete')
    await attempt(reject(new ActionError(409, '', {}, { message: 'Branch is behind', error: 5 })), 'Could not delete')
    await attempt(reject(new ActionError(409, '', {}, 'Locked by someone')), 'Could not delete')
    await attempt(reject(new ActionError(409, '', {}, { error: 'NOT_FOUND' })), 'Code failure')
    await attempt(reject(new ActionError(409, '', {}, { error: 'two\nlines' })), 'Lines failure')
    await attempt(reject(new ActionError(409, '', {}, { output: 'nginx: bad' })), 'Other failure')
    // A schema refusal and a plain error carry no handler data, so `refused` is never asked.
    await attempt(reject(new ActionError(422, '', { name: 'Required' })), 'Could not delete', refused)
    await attempt(reject(new Error('offline')), 'Could not delete', refused)
    // An empty refusal says nothing, so `failure` goes in its place.
    await attempt(reject(new ActionError(400, '', { '': '' }, { error: '' })), 'Could not delete', refused)

    expect(shown().map(({ message }) => message)).toEqual(['Still referenced', 'Could not delete', 'Too many tries', 'Name taken', 'Branch is behind', 'Locked by someone', 'Code failure', 'Lines failure', 'Other failure'])
    // The same error open is shown once.
  })

  test('hands a refusal to `onRefused` without toasting, and still toasts a failure that is no refusal', async () => {
    const seen: unknown[] = []
    const onRefused = (data: unknown) => seen.push(data)
    const reject = (error: Error) => async () => Promise.reject(error)

    expect(await attempt(reject(new ActionError(400, '', {}, { output: 'nginx: [emerg] bad directive' })), { failure: 'Could not apply', onRefused })).toBeUndefined()
    expect(await attempt(reject(new ApiError(409, 'Conflict', { reason: 'Busy' })), { failure: 'Could not apply', onRefused })).toBeUndefined()
    // A falsy answer is still the refusal's data.
    await attempt(reject(new ActionError(400, '', {}, 0)), { failure: 'Could not apply', onRefused })

    expect(seen).toEqual([{ output: 'nginx: [emerg] bad directive' }, { reason: 'Busy' }, 0])
    expect(shown()).toEqual([])

    await attempt(reject(new Error('offline')), { failure: 'Could not apply', onRefused })
    await attempt(reject(new ActionError(422, '', { name: 'Required' })), { failure: 'Could not apply', onRefused })
    await attempt(reject(new ApiError(0, 'Failed to fetch')), { failure: 'Could not apply', onRefused })

    expect(seen).toHaveLength(3)
    expect(shown().map(({ message }) => message)).toEqual(['Could not apply'])
  })

  test('hands a 5xx answer to `failure`, not to `onRefused`, even when it is a JSON object', async () => {
    const seen: unknown[] = []

    await attempt(async () => Promise.reject(new ApiError(503, 'Unavailable', { reason: 'Down' })), { failure: 'Could not apply', onRefused: data => seen.push(data) })

    expect(seen).toEqual([])
    expect(shown().map(({ message }) => message)).toEqual(['Could not apply'])
  })

  test('awaits `onRefused`, and a throw or a rejection of it toasts `failure` instead of escaping', async () => {
    const order: string[] = []
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const refuse = async () => Promise.reject(new ActionError(400, '', {}, { error: 'Busy' }))

    try {
      expect(await attempt(refuse, { failure: 'Could not apply', onRefused: async () => {
        await Promise.resolve()
        order.push('shown')
      } })).toBeUndefined()
      order.push('after')
      expect(await attempt(refuse, { failure: 'Could not apply', onRefused: async () => Promise.reject(new Error('boom')) })).toBeUndefined()
      expect(await attempt(refuse, { failure: 'Could not apply again', onRefused: () => {
        throw new Error('boom')
      } })).toBeUndefined()
    }
    finally {
      spy.mockRestore()
    }

    expect(order).toEqual(['shown', 'after'])
    expect(shown().map(({ message }) => message)).toEqual(['Could not apply', 'Could not apply again'])
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

  describe('over a call() that throws ApiError', () => {
    const reject = (error: Error) => async () => Promise.reject(error)
    const said = async (error: Error, refused?: (data: { reason?: string }) => string | undefined) => {
      toasts.set([])
      await attempt(reject(error), 'Could not delete', refused)

      return shown().map(({ message }) => message)
    }

    test('reads an ActionError as one, not as the ApiError it extends', async () => {
      // Read as an ApiError, its text body would be toasted in place of the words the handler and the schema gave.
      expect(await said(new ActionError(409, 'Taken', { '': 'Schema words' }, { reason: 'Handler words' }), data => data.reason)).toEqual(['Handler words'])
      expect(await said(new ActionError(409, 'Taken', { '': 'Schema words' }))).toEqual(['Schema words'])
      expect(await said(new ActionError(500, 'Boom', { '': 'Schema words' }))).toEqual(['Schema words'])
    })

    test('toasts the route\'s own words for a refusal, as for an action\'s', async () => {
      expect(await said(new ApiError(409, 'Still referenced', 'Still referenced'))).toEqual(['Still referenced'])
      expect(await said(new ApiError(422, 'Name is required', { message: 'Name is required' }))).toEqual(['Name is required'])
    })

    test('falls back to `failure` when no answer came, the route says nothing, or it failed', async () => {
      expect(await said(new ApiError(0, 'Failed to fetch'))).toEqual(['Could not delete'])
      expect(await said(new ApiError(404, 'Not Found', ''))).toEqual(['Could not delete'])
      expect(await said(new ApiError(400, 'Bad Request', { code: 7 }))).toEqual(['Could not delete'])
      expect(await said(new ApiError(500, 'Boom', 'Boom'))).toEqual(['Could not delete'])
    })

    test('lets `refused` read the answer first, for any status but 0, and falls through to the words of the route when it says nothing', async () => {
      const refused = (data: { reason?: string }) => data.reason

      expect(await said(new ApiError(409, 'Conflict', { reason: 'Still referenced' }), refused)).toEqual(['Still referenced'])
      expect(await said(new ApiError(503, 'HTTP 503', { reason: 'Busy, retry' }), refused)).toEqual(['Busy, retry'])
      expect(await said(new ApiError(409, 'Taken', 'Taken'), refused)).toEqual(['Taken'])
      expect(await said(new ApiError(409, 'Taken', { reason: '', message: 'Taken' }), refused)).toEqual(['Taken'])
      expect(await said(new ApiError(0, 'Failed to fetch'), refused)).toEqual(['Could not delete'])
    })

    test('keeps what does not read as a message to `failure`: markup, a status code, several lines, a page of text', async () => {
      const proxy = '<html><body><h1>413 Request Entity Too Large</h1></body></html>'

      expect(await said(new ApiError(413, proxy, proxy))).toEqual(['Could not delete'])
      expect(await said(new ApiError(404, 'NOT_FOUND', 'NOT_FOUND'))).toEqual(['Could not delete'])
      expect(await said(new ApiError(400, 'a\nb', 'a\nb'))).toEqual(['Could not delete'])
      expect(await said(new ApiError(422, 'x'.repeat(201), 'x'.repeat(201)))).toEqual(['Could not delete'])
      expect(await said(new ApiError(422, 'x'.repeat(200), { message: 'x'.repeat(200) }))).toEqual(['x'.repeat(200)])
    })

    test('calls `refused` only for an answer that is an object, and survives one that throws', async () => {
      const refused = (data: { reason?: string }) => data.reason!.toUpperCase()
      const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined)

      expect(await said(new ApiError(409, 'Conflict', null), refused)).toEqual(['Could not delete'])
      expect(await said(new ApiError(409, 'Conflict', ''), refused)).toEqual(['Could not delete'])
      expect(await said(new ApiError(409, 'Conflict', new Blob(['x'])), refused)).toEqual(['Could not delete'])
      expect(await said(new ApiError(409, 'Taken', { message: 'Taken' }), refused)).toEqual(['Taken'])

      expect(await attempt(reject(new ApiError(409, 'Conflict', {})), 'Could not delete', refused)).toBeUndefined()
      spy.mockRestore()
    })

    test('tells a code from a short message: only underscored words or digits are codes', async () => {
      expect(await said(new ApiError(403, 'ACCESS DENIED', 'ACCESS DENIED'))).toEqual(['ACCESS DENIED'])
      expect(await said(new ApiError(409, 'FULL', 'FULL'))).toEqual(['FULL'])
      expect(await said(new ApiError(403, 'Forbidden', 'Forbidden'))).toEqual(['Forbidden'])
      expect(await said(new ApiError(403, 'FORBIDDEN', 'FORBIDDEN'))).toEqual(['FORBIDDEN'])
      expect(await said(new ApiError(404, '4040', '4040'))).toEqual(['Could not delete'])
      expect(await said(new ApiError(409, 'OK', { message: 'OK' }))).toEqual(['OK'])
      expect(await said(new ApiError(404, 'E_CODE_1', 'E_CODE_1'))).toEqual(['Could not delete'])
      expect(await said(new ApiError(404, '404', '404'))).toEqual(['Could not delete'])
    })

    test('reports a `refused` that throws with console.error, and still toasts `failure`', async () => {
      const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
      const boom = new TypeError('bad read')
      const refused = (): string => {
        throw boom
      }

      try {
        expect(await said(new ApiError(409, 'Conflict', {}), refused)).toEqual(['Could not delete'])
        expect(spy).toHaveBeenCalledTimes(1)
        expect(spy.mock.calls[0]).toContain(boom)
      }
      finally {
        spy.mockRestore()
      }
    })

    test('resolves to undefined, and an ActionError keeps reading as before', async () => {
      expect(await attempt(reject(new ApiError(409, 'Taken', 'Taken')), 'Could not delete')).toBeUndefined()
      expect(await said(new ActionError(400, '', {}, { reason: 'Still referenced' }), data => data.reason)).toEqual(['Still referenced'])
    })
  })
})

describe('messageOf', () => {
  test('reads the words of a route\'s refusal as `attempt` does, else the fallback', () => {
    expect(messageOf(new ApiError(409, 'Taken', { message: 'Name taken' }), 'Could not save')).toBe('Name taken')
    expect(messageOf(new ApiError(403, 'ACCESS DENIED', 'ACCESS DENIED'), 'Could not save')).toBe('ACCESS DENIED')
    expect(messageOf(new ApiError(0, 'Failed to fetch'), 'Could not save')).toBe('Could not save')
    expect(messageOf(new ApiError(500, 'Boom', 'Boom'), 'Could not save')).toBe('Could not save')
    expect(messageOf(new ApiError(404, 'NOT_FOUND', 'NOT_FOUND'), 'Could not save')).toBe('Could not save')
    expect(messageOf(new ApiError(502, 'x', '<html></html>'), 'Could not save')).toBe('Could not save')
  })

  test('reads an action\'s schema refusal, and gives the fallback for any other throw', () => {
    expect(messageOf(new ActionError(429, '', { '': 'Too many tries' }), 'Could not save')).toBe('Too many tries')
    expect(messageOf(new Error('secret internals'), 'Could not save')).toBe('Could not save')
    expect(messageOf(undefined, 'Could not save')).toBe('Could not save')
    expect(messageOf('<script>', 'Could not save')).toBe('Could not save')
  })
})

describe('callAction reading a refusal without `refused`', () => {
  const form = { querySelectorAll: () => [] } as unknown as HTMLFormElement
  const fail = (data: unknown, errors: Record<string, string> = {}) => async () => Promise.reject(new ActionError(409, '', errors, data))

  async function run(data: unknown, refused?: (data: never) => Record<string, string> | string | undefined) {
    toasts.set([])
    await callAction(form, fail(data) as never, signal<Record<string, string>>({}), 'Could not save', refused as never)

    return shown().map(({ message }) => message)
  }

  test('toasts a string, or a string error or message, that reads as one', async () => {
    expect(await run('Name taken')).toEqual(['Name taken'])
    expect(await run({ error: 'Branch is behind' })).toEqual(['Branch is behind'])
    expect(await run({ message: 'Locked' })).toEqual(['Locked'])
  })

  test('falls back to `failure` for a code, several lines, markup or no words', async () => {
    expect(await run({ error: 'NOT_FOUND' })).toEqual(['Could not save'])
    expect(await run({ error: 'a\nb' })).toEqual(['Could not save'])
    expect(await run('<html>')).toEqual(['Could not save'])
    expect(await run({ error: 'x'.repeat(201) })).toEqual(['Could not save'])
    expect(await run({ error: 5 })).toEqual(['Could not save'])
  })

  test('`refused` overrides the data, and one saying nothing leaves it', async () => {
    expect(await run({ error: 'Raw' }, () => 'Mine')).toEqual(['Mine'])
    expect(await run({ error: 'Raw' }, () => undefined)).toEqual(['Raw'])
    expect(await run({ error: 'Raw' }, () => '')).toEqual(['Raw'])
  })
})

describe('onDismiss', () => {
  test('hears timeout, user, action and api, once, after the toast has gone', () => {
    jest.useFakeTimers()

    try {
      const heard: string[] = []
      const onDismiss = (reason: string) => heard.push(`${reason}:${toasts().length}`)

      toast.info('timed', { duration: '1s', onDismiss })
      jest.advanceTimersByTime(1000)
      dismissToast(toast.info('closed', { onDismiss }), 'user')
      dismissToast(toast.info('acted', { onDismiss }), 'action')
      dismissToast(toast.info('by app', { onDismiss }))
      dismissToast(999)

      expect(heard).toEqual(['timeout:0', 'user:0', 'action:0', 'api:0'])
    }
    finally {
      jest.useRealTimers()
    }
  })

  test('one that throws is logged and the toast still goes', () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined)

    dismissToast(toast.info('x', { onDismiss: () => {
      throw new Error('boom')
    } }))

    expect(toasts()).toEqual([])
    expect(error).toHaveBeenCalledTimes(1)
    error.mockRestore()
  })
})

describe('toast.update', () => {
  test('changes the message, tone, description and action of an open toast, keeping its id', () => {
    const id = toast.info('Saving', { duration: false })

    expect(toast.update(id, { message: 'Saved', tone: 'success', description: 'Two files', action: { label: 'Undo', href: '/undo' } })).toBe(true)
    expect(toasts()).toMatchObject([{ id, message: 'Saved', tone: 'success', type: 'success', description: 'Two files', action: { label: 'Undo', href: '/undo' } }])

    toast.update(id, { action: undefined })

    expect(toasts()[0]!.action).toBeUndefined()
  })

  test('answers false for a toast that went, and starts the clock afresh when the tone changes', () => {
    jest.useFakeTimers()

    try {
      expect(toast.update(404, { message: 'x' })).toBe(false)

      const id = toast.info('Working', { duration: false })

      jest.advanceTimersByTime(60_000)
      toast.update(id, { tone: 'success' })
      jest.advanceTimersByTime(5999)

      expect(toasts()).toHaveLength(1)

      jest.advanceTimersByTime(1)

      expect(toasts()).toHaveLength(0)
    }
    finally {
      jest.useRealTimers()
    }
  })

  test('takes markup as the message', () => {
    const message = () => 'markup'
    const id = toast.info('plain')

    toast.update(id, { message })

    expect(toasts()[0]!.message).toBe(message)
  })
})

describe('toast.promise', () => {
  test('shows a loading toast, then settles the same one to success', async () => {
    const { promise, resolve } = Promise.withResolvers<number>()
    const done = toast.promise(promise, { loading: 'Saving', success: value => `Saved ${value}`, error: 'Failed' })

    expect(toasts()).toMatchObject([{ message: 'Saving', loading: true }])

    const id = toasts()[0]!.id

    resolve(3)

    expect(await done).toBe(3)
    expect(toasts()).toMatchObject([{ id, message: 'Saved 3', tone: 'success', loading: false }])
  })

  test('settles to a danger toast that stays, and resolves to undefined with no catch needed', async () => {
    const done = await toast.promise(async () => Promise.reject(new Error('nope')), { loading: 'Saving', error: thrown => `Failed: ${(thrown as Error).message}` })

    expect(done).toBeUndefined()
    expect(toasts()).toMatchObject([{ message: 'Failed: nope', tone: 'danger', type: 'error' }])
  })

  test('without success the loading toast just closes, and a closed one still gets the outcome', async () => {
    await toast.promise(Promise.resolve(1), { loading: 'Saving', error: 'Failed' })

    expect(toasts()).toEqual([])

    const { promise, reject } = Promise.withResolvers<number>()
    const done = toast.promise(promise, { loading: 'Saving', error: 'Failed' })

    dismissToast(toasts()[0]!.id, 'user')
    reject(new Error('x'))
    await done

    expect(toasts()).toMatchObject([{ message: 'Failed', tone: 'danger' }])
  })
})
