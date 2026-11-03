import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

type Navigation = typeof import('../src/runtime/navigation')
type State = typeof import('../src/runtime/navigation-state')
type Reactive = typeof import('../src/runtime/reactive')

let navigation: Navigation
let state: State
let reactive: Reactive
let ApiError: typeof import('../src/runtime/api-error').ApiError

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/docs/' })
  navigation = await import('../src/runtime/navigation')
  state = await import('../src/runtime/navigation-state')
  reactive = await import('../src/runtime/reactive')
  ;({ ApiError } = await import('../src/runtime/api-error'))
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

// The URLs a swap passes are the ones it fetches: under the base, with the site's trailing slash and locale prefix already on.
const TARGETS = [new URL('http://localhost/app/docs/'), new URL('http://localhost/app/fr/docs/guide/')]

// Runs `body` in an island's root, giving back what ends it.
function island(body: () => void): () => void {
  return reactive.root((dispose) => {
    body()

    return dispose
  })
}

describe('onBeforeNavigate', () => {
  it.each(TARGETS)('is asked with the URL %s and keeps the page when it answers false, sync or async', async (to) => {
    const asked: string[] = []
    const dispose = island(() => {
      state.onBeforeNavigate(({ url, from }) => {
        asked.push(`${url.href} from ${from.href}`)

        return false
      })
    })

    expect(await navigation.mayLeave(to)).toBe(false)
    dispose()
    expect(asked).toEqual([`${to.href} from ${location.href}`])

    const later = island(() => {
      state.onBeforeNavigate(async () => false)
    })

    expect(await navigation.mayLeave(to)).toBe(false)
    later()
  })

  it('lets the visit go on for no answer, true or a promise of nothing', async () => {
    const dispose = island(() => {
      state.onBeforeNavigate(() => undefined)
      state.onBeforeNavigate(async () => true)
    })

    expect(await navigation.mayLeave(TARGETS[0]!)).toBe(true)
    dispose()
  })

  it('logs a handler that throws and lets the visit go on', async () => {
    const logged: unknown[] = []
    const original = console.error

    console.error = (...args: unknown[]) => logged.push(...args)

    const dispose = island(() => {
      state.onBeforeNavigate(() => {
        throw new Error('boom')
      })
    })

    try {
      expect(await navigation.mayLeave(TARGETS[0]!)).toBe(true)
    }
    finally {
      console.error = original
      dispose()
    }

    expect(logged).toHaveLength(1)
  })

  it('stops with its island, or when its disposer runs, and leaves no hook behind', async () => {
    let stop: () => void = () => undefined
    const dispose = island(() => {
      stop = state.onBeforeNavigate(() => false)
    })

    expect(navigation.navigation.before).toBeDefined()
    stop()
    expect(navigation.navigation.before).toBeUndefined()
    expect(await navigation.mayLeave(TARGETS[0]!)).toBe(true)

    const second = island(() => {
      state.onBeforeNavigate(() => false)
    })

    second()
    expect(navigation.navigation.before).toBeUndefined()
    dispose()
  })

  it('keeps the same function registered by two islands until both end', async () => {
    const refuse = () => false
    const first = island(() => {
      state.onBeforeNavigate(refuse)
    })
    const second = island(() => {
      state.onBeforeNavigate(refuse)
    })

    first()
    expect(navigation.navigation.before).toBeDefined()
    expect(await navigation.mayLeave(TARGETS[0]!)).toBe(false)
    second()
    expect(navigation.navigation.before).toBeUndefined()
    expect(await navigation.mayLeave(TARGETS[0]!)).toBe(true)
  })

  it('is not asked for a page kay does not swap in place, where the guards still ask', async () => {
    const asked: string[] = []
    const dispose = island(() => {
      state.onBeforeNavigate(() => asked.push('hook') > 0 && false)
      navigation.leaveGuards.add({ dirty: () => true, confirm: () => asked.push('guard') > 0 })
    })

    expect(await navigation.mayLeave(TARGETS[0]!, false)).toBe(true)
    expect(asked).toEqual(['guard'])
    navigation.leaveGuards.clear()
    dispose()
  })

  it('answers before a leave guard, which is not asked when it refuses', async () => {
    const asked: string[] = []
    const dispose = island(() => {
      state.onBeforeNavigate(() => false)
      navigation.leaveGuards.add({ dirty: () => true, confirm: () => asked.push('guard') > 0 })
    })

    expect(await navigation.mayLeave(TARGETS[0]!)).toBe(false)
    expect(asked).toEqual([])
    navigation.leaveGuards.clear()
    dispose()
  })
})

describe('navigation', () => {
  it('reads idle with no swap, and follows the steps a swap reports', () => {
    const seen: string[] = []
    const dispose = island(() => {
      reactive.effect(() => {
        seen.push(`${state.navigation.status()} ${state.navigation.pending()} ${state.navigation.to()?.pathname ?? '-'} ${state.navigation.error()?.message ?? '-'}`)
      })
    })

    reactive.flush()
    expect(seen).toEqual(['idle false - -'])

    const [first, second] = TARGETS as [URL, URL]

    navigation.navigation.phase!('loading', first)
    reactive.flush()
    // Another navigation took over: the target moves and no idle comes between.
    navigation.navigation.phase!('loading', second)
    reactive.flush()
    navigation.navigation.phase!('swapping', second)
    reactive.flush()
    navigation.navigation.phase!('idle')
    reactive.flush()
    expect(seen.at(-1)).toBe('idle false - -')
    expect(seen.join('|')).toContain('loading true /app/fr/docs/guide/ -')
    expect(seen.join('|')).toContain('swapping true /app/fr/docs/guide/ -')

    // A swap that gave up reports the reason, kept after the state is idle again, until the next navigation starts.
    const cause = new TypeError('Failed to fetch')

    navigation.navigation.phase!('idle', first, new Error('gave up', { cause }))
    navigation.navigation.phase!('idle')
    reactive.flush()
    expect(seen.at(-1)).toBe('idle false - gave up')
    expect(state.navigation.error()).toBeInstanceOf(ApiError)
    expect(state.navigation.error()).toMatchObject({ status: 0, message: 'gave up', cause })
    navigation.navigation.phase!('loading', first)
    reactive.flush()
    navigation.navigation.phase!('idle')
    reactive.flush()
    expect(seen.at(-1)).toBe('idle false - -')
    dispose()
  })
})

describe('onNavigate', () => {
  it('logs a handler that throws or rejects and calls the others', async () => {
    const logged: unknown[] = []
    const original = console.error
    const urls: string[] = []

    console.error = (...args: unknown[]) => logged.push(...args)

    const dispose = island(() => {
      state.onNavigate(() => {
        throw new Error('sync')
      })
      state.onNavigate(async () => {
        throw new Error('async')
      })
      state.onNavigate(({ url }) => urls.push(url.href))
    })

    try {
      document.dispatchEvent(new CustomEvent('kay:navigate', { detail: { url: TARGETS[0]!.href } }))
      await Bun.sleep(5)
    }
    finally {
      console.error = original
      dispose()
    }

    expect(logged.map(error => (error as Error).message)).toEqual(['sync', 'async'])
    expect(urls).toEqual([TARGETS[0]!.href])
  })

  it('is called with the URL of each swapped page until its disposer or island ends it', () => {
    const urls: string[] = []
    let stop: () => void = () => undefined
    const dispose = island(() => {
      stop = state.onNavigate(({ url }) => urls.push(url.href))
    })

    document.dispatchEvent(new CustomEvent('kay:navigate', { detail: { url: TARGETS[1]!.href } }))
    stop()
    document.dispatchEvent(new CustomEvent('kay:navigate', { detail: { url: TARGETS[0]!.href } }))
    expect(urls).toEqual([TARGETS[1]!.href])
    dispose()
  })
})
