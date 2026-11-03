import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

type Navigation = typeof import('../src/runtime/navigation')
type State = typeof import('../src/runtime/navigation-state')
type Reactive = typeof import('../src/runtime/reactive')

let navigation: Navigation
let state: State
let reactive: Reactive

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/docs/' })
  navigation = await import('../src/runtime/navigation')
  state = await import('../src/runtime/navigation-state')
  reactive = await import('../src/runtime/reactive')
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
      state.onBeforeNavigate((target) => {
        asked.push(target.href)

        return false
      })
    })

    expect(await navigation.mayLeave(to)).toBe(false)
    dispose()
    expect(asked).toEqual([to.href])

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
        seen.push(`${state.navigation.state()} ${state.navigation.to()?.pathname ?? '-'} ${state.navigation.error()?.message ?? '-'}`)
      })
    })

    reactive.flush()
    expect(seen).toEqual(['idle - -'])

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
    expect(seen.at(-1)).toBe('idle - -')
    expect(seen.join('|')).toContain('loading /app/fr/docs/guide/ -')
    expect(seen.join('|')).toContain('swapping /app/fr/docs/guide/ -')

    // A swap that gave up reports the reason, kept after the state is idle again, until the next navigation starts.
    navigation.navigation.phase!('idle', first, new Error('gave up'))
    navigation.navigation.phase!('idle')
    reactive.flush()
    expect(seen.at(-1)).toBe('idle - gave up')
    navigation.navigation.phase!('loading', first)
    reactive.flush()
    navigation.navigation.phase!('idle')
    reactive.flush()
    expect(seen.at(-1)).toBe('idle - -')
    dispose()
  })
})

describe('onNavigate', () => {
  it('is called with the URL of each swapped page until its disposer or island ends it', () => {
    const urls: string[] = []
    let stop: () => void = () => undefined
    const dispose = island(() => {
      stop = state.onNavigate(url => urls.push(url.href))
    })

    document.dispatchEvent(new CustomEvent('kay:navigate', { detail: { url: TARGETS[1]!.href } }))
    stop()
    document.dispatchEvent(new CustomEvent('kay:navigate', { detail: { url: TARGETS[0]!.href } }))
    expect(urls).toEqual([TARGETS[1]!.href])
    dispose()
  })
})
