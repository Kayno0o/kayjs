import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { hydrateIslands } from '../src/runtime/client'
import { untilHolds } from './helpers/until-holds'

interface Observed { callback: IntersectionObserverCallback, target: Element }

const observed: Observed[] = []
const original = { IntersectionObserver: globalThis.IntersectionObserver }

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' })

  globalThis.IntersectionObserver = class {
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      observed.push({ callback: this.callback, target })
    }

    disconnect = () => undefined
  } as unknown as typeof IntersectionObserver
})

afterAll(async () => {
  globalThis.IntersectionObserver = original.IntersectionObserver
  await GlobalRegistrator.unregister()
})

afterEach(() => {
  observed.length = 0
  Reflect.deleteProperty(navigator, 'connection')
  document.head.innerHTML = ''
})

const slot = (name: string, attributes = '') => `<slot data-component="${name}.kay" data-props="[{}]"${attributes}><button>${name}</button></slot>`
const wait = async (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

// Waits for the islands to be observed, which happens after an import a loaded host takes longer than a fixed wait over.
async function observing(count: number): Promise<void> {
  await untilHolds(() => observed.length >= count)
}

// A quiet window past the `IDLE_FALLBACK_MS` (200 ms) a hydration waits for the idle callback happy-dom lacks, for what is expected not to happen.
const QUIET_MS = 250

// The components loaded, in the order the browser asked for them: `expected` of them are waited for, and none is shown not to come within `quiet` ms.
async function hydrated(markup: string, expected = 0, quiet = 20): Promise<string[]> {
  const loaded: string[] = []
  const registry: Record<string, () => Promise<{ default: () => null }>> = {}

  for (const name of markup.matchAll(/data-component="([^"]+)\.kay"/g)) {
    registry[`${name[1]}.kay`] = async () => {
      loaded.push(name[1]!)

      return { default: () => null }
    }
  }

  document.body.innerHTML = markup
  await hydrateIslands(registry)

  if (expected > 0)
    await untilHolds(() => loaded.length >= expected)
  else
    await wait(quiet)

  return loaded
}

function saving(): void {
  Object.defineProperty(navigator, 'connection', { value: { saveData: true }, configurable: true })
}

function intersect(name: string): void {
  const entry = observed.find(({ target }) => target.closest('slot')?.getAttribute('data-component') === `${name}.kay`)!

  entry.callback([{ isIntersecting: true, target: entry.target } as IntersectionObserverEntry], {} as IntersectionObserver)
}

describe('an island with no hydrate of its own', () => {
  it('hydrates at once for a visitor not asking to save data, with nothing observed', async () => {
    expect(await hydrated(slot('a') + slot('b'), 2)).toEqual(['a', 'b'])
    expect(observed).toEqual([])
  })

  it('hydrates at once with the connection reporting Save-Data off', async () => {
    Object.defineProperty(navigator, 'connection', { value: { saveData: false }, configurable: true })

    expect(await hydrated(slot('a'), 1)).toEqual(['a'])
    expect(observed).toEqual([])
  })

  it('waits until it scrolls near for a visitor whose connection reports Save-Data', async () => {
    saving()

    expect(await hydrated(slot('a') + slot('b'))).toEqual([])
    await observing(2)
    expect(observed.map(({ target }) => target.textContent).toSorted()).toEqual(['a', 'b'])
  })

  it('hydrates one that scrolls near, and only that one', async () => {
    saving()

    const loaded: string[] = []
    const registry = Object.fromEntries(['a', 'b'].map(name => [`${name}.kay`, async () => {
      loaded.push(name)

      return { default: () => null }
    }]))

    document.body.innerHTML = slot('a') + slot('b')
    await hydrateIslands(registry)
    await observing(2)
    intersect('b')
    await untilHolds(() => loaded.length > 0)
    // Nothing happens: the other island stays unloaded.
    await wait()

    expect(loaded).toEqual(['b'])
  })

  it('waits under prefers-reduced-data, where no header is sent', async () => {
    const matches = spyOn(window, 'matchMedia').mockImplementation(((query: string) => ({ matches: query === '(prefers-reduced-data: reduce)' })) as unknown as typeof matchMedia)

    try {
      expect(await hydrated(slot('a'))).toEqual([])
      await observing(1)
      expect(observed).toHaveLength(1)
    }
    finally {
      matches.mockRestore()
    }
  })

  it('hydrates at once when the config turned the behavior off, the visitor asking or not', async () => {
    saving()
    document.head.innerHTML = '<meta name="kay-save-data" content="off">'

    expect(await hydrated(slot('a'), 1)).toEqual(['a'])
    expect(observed).toEqual([])
  })
})

describe('an island with a strategy of its own, for a visitor asking to save data', () => {
  it('keeps hydrate="load" written out', async () => {
    saving()

    expect(await hydrated(slot('a', ' data-hydrate="load"') + slot('b'), 1)).toEqual(['a'])
    await observing(1)
    expect(observed.map(({ target }) => target.textContent)).toEqual(['b'])
  })

  it('keeps hydrate="idle" on the idle callback, not the viewport', async () => {
    saving()

    expect(await hydrated(slot('a', ' data-hydrate="idle"'), 1)).toEqual(['a'])
    expect(observed).toEqual([])
  })

  it('keeps hydrate="visible" on the viewport', async () => {
    saving()

    expect(await hydrated(slot('a', ' data-hydrate="visible"'), 0, QUIET_MS)).toEqual([])
    await observing(1)
    expect(observed).toHaveLength(1)
  })

  it('renders a client-only island at once, as it has no markup to wait on', async () => {
    saving()

    expect(await hydrated(slot('a', ' data-client'), 1)).toEqual(['a'])
    expect(observed).toEqual([])
  })

  it('reads nothing but the fixed strategies off the attribute', async () => {
    saving()

    expect(await hydrated(slot('a', ' data-hydrate="constructor"') + slot('b', ' data-hydrate="__proto__"') + slot('c', ' data-hydrate=""'), 3)).toEqual(['a', 'b', 'c'])
  })
})

describe('a deferred server island', () => {
  const server = '<slot data-kay-server="0" inert></slot>'

  // The fetches made: `expected` of them are waited for, and none is shown not to come within the quiet window.
  async function fetches(expected: number): Promise<number> {
    const answer = spyOn(globalThis, 'fetch').mockImplementation((async () => new Response('<p>Fresh</p>')) as unknown as typeof fetch)

    try {
      document.body.innerHTML = server
      await hydrateIslands({})

      if (expected > 0)
        await untilHolds(() => answer.mock.calls.length >= expected)
      else
        await wait(QUIET_MS)

      return answer.mock.calls.length
    }
    finally {
      answer.mockRestore()
    }
  }

  it('is fetched when the browser is idle, or when it nears the viewport', async () => {
    expect(await fetches(1)).toBe(1)
    await observing(1)
    expect(observed).toHaveLength(1)
  })

  it('is fetched only when it nears the viewport for a visitor asking to save data', async () => {
    saving()

    expect(await fetches(0)).toBe(0)
    await observing(1)
    expect(observed).toHaveLength(1)
  })
})
