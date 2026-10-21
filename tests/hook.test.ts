import { describe, expect, it } from 'bun:test'
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
