import { afterEach, describe, expect, it } from 'bun:test'
import { mediaQuery, reducedMotion } from '../src/runtime/media-query'
import { flush, root } from '../src/runtime/reactive'

type Listener = (event: { matches: boolean }) => void

// A `matchMedia` whose answers the test changes, as a visitor changing a setting does.
function fakeMedia(initial: Record<string, boolean>) {
  const state = { ...initial }
  const listeners = new Map<string, Set<Listener>>()

  globalThis.matchMedia = ((query: string) => ({
    get matches() {
      return state[query] ?? false
    },
    addEventListener(_type: string, listener: Listener) {
      listeners.set(query, (listeners.get(query) ?? new Set()).add(listener))
    },
    removeEventListener(_type: string, listener: Listener) {
      listeners.get(query)?.delete(listener)
    },
  })) as unknown as typeof matchMedia

  return {
    set(query: string, matches: boolean) {
      state[query] = matches

      for (const listener of listeners.get(query) ?? [])
        listener({ matches })
    },
    count: (query: string) => listeners.get(query)?.size ?? 0,
  }
}

const REDUCE = '(prefers-reduced-motion: reduce)'
const original = globalThis.matchMedia

afterEach(() => {
  globalThis.matchMedia = original
})

describe('mediaQuery', () => {
  it('reads its fallback where there is no matchMedia, as the server does', () => {
    globalThis.matchMedia = undefined as unknown as typeof matchMedia

    root(() => {
      expect(mediaQuery('(max-width: 40rem)')()).toBe(false)
      expect(mediaQuery('(max-width: 40rem)', true)()).toBe(true)
      expect(reducedMotion(true)()).toBe(true)
    })
    flush()
  })

  it('follows the query once mounted and stops listening when its island ends', () => {
    const media = fakeMedia({ '(max-width: 40rem)': true })

    root((dispose) => {
      const narrow = mediaQuery('(max-width: 40rem)')

      expect(narrow()).toBe(false)
      flush()
      expect(narrow()).toBe(true)

      media.set('(max-width: 40rem)', false)
      expect(narrow()).toBe(false)
      expect(media.count('(max-width: 40rem)')).toBe(1)

      dispose()
      expect(media.count('(max-width: 40rem)')).toBe(0)
    })
  })

  it('has reducedMotion follow prefers-reduced-motion while the page is open', () => {
    const media = fakeMedia({})

    root(() => {
      const reduced = reducedMotion()

      flush()
      expect(reduced()).toBe(false)

      media.set(REDUCE, true)
      expect(reduced()).toBe(true)

      media.set(REDUCE, false)
      expect(reduced()).toBe(false)
    })
  })
})
