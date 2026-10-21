import { describe, expect, it, mock } from 'bun:test'
import { callHook } from '../src/runtime/hook'

const EVENT = { user: 'ada', profile: 'p' }

describe('callHook', () => {
  it('gives a destructuring hook the event and a positional one its arguments', () => {
    expect(callHook(({ user }: { user: string }) => `new ${user}`, EVENT, ['ada', 'p'])).toBe('new ada')
    expect(callHook(async ({ user }: { user: string }) => `new ${user}`, EVENT, ['ada', 'p'])).resolves.toBe('new ada')
    expect(callHook((user: string, profile: string) => `old ${user} ${profile}`, EVENT, ['ada', 'p'])).toBe('old ada p')
    expect(callHook((user: string) => `old ${user}`, EVENT, ['ada', 'p'])).toBe('old ada')
    expect(callHook(user => `old ${user as string}`, EVENT, ['ada', 'p'])).toBe('old ada')
  })

  it('reads methods, function expressions and hooks with no parameter', () => {
    const options = {
      onSignUp({ user }: { user: string }) {
        return `method ${user}`
      },
    }

    // eslint-disable-next-line ts/unbound-method -- The hook is read from its source text, not called on its object.
    expect(callHook(options.onSignUp, EVENT, ['ada'])).toBe('method ada')
    expect(callHook(({ user }: { user: string }) => {
      return `function ${user}`
    }, EVENT, ['ada'])).toBe('function ada')
    expect(callHook(() => 'none', EVENT, ['ada'])).toBe('none')
  })
})

describe('callHook shapes', () => {
  it('reads rest and default parameters, and a destructuring of other fields, as positional', () => {
    expect(callHook((...args: unknown[]) => args, EVENT, ['ada', 'p'])).toEqual(['ada', 'p'])
    expect(callHook((user = 'x') => user, EVENT, ['ada'])).toBe('ada')
    expect(callHook(({ id }: { id: number }) => id, EVENT, [{ id: 7 }])).toBe(7)
    expect(callHook(({ user, ...rest }: { user: string }) => `${user} ${Object.keys(rest).join()}`, EVENT, [{}])).toBe('ada profile')
  })

  it('reads a mock or a bound function as taking the event', () => {
    const mocked = mock(({ user }: { user: string }) => user)
    const bound = function ({ user }: { user: string }) {
      return user
    }

    expect(callHook(mocked, EVENT, ['x'])).toBe('ada')
    expect(callHook(bound, EVENT, ['x'])).toBe('ada')
  })
})
