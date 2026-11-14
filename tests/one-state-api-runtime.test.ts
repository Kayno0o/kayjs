import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it, jest } from 'bun:test'

type Core = typeof import('../src/runtime/core')
type Reactive = typeof import('../src/runtime/reactive')
type Persisted = typeof import('../src/runtime/persisted')
type Navigation = typeof import('../src/runtime/navigation')
type NavigateApi = typeof import('../src/runtime/navigate-api')

let core: Core
let reactive: Reactive
let persisted: Persisted
let navigation: Navigation
let state: typeof import('../src/runtime/navigation-state')
let api: NavigateApi

const setURL = (url: string) => (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(url)

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/page' })
  core = await import('../src/runtime/core')
  reactive = await import('../src/runtime/reactive')
  persisted = await import('../src/runtime/persisted')
  navigation = await import('../src/runtime/navigation')
  state = await import('../src/runtime/navigation-state')
  api = await import('../src/runtime/navigate-api')
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

describe('queryParam', () => {
  it('reads the default when the param is left out, and the text of the URL otherwise', () => {
    setURL('http://localhost/page?q=cats')

    reactive.root(() => {
      expect(persisted.queryParam('q', { default: '' })()).toBe('cats')
      expect(persisted.queryParam('missing', { default: 'none' })()).toBe('none')
      expect(persisted.queryParam('missing')()).toBeUndefined()
    })
  })

  it('takes only the values it lists, falling back to the default or to undefined', () => {
    setURL('http://localhost/page?tab=logs&bad=x')

    reactive.root(() => {
      expect(persisted.queryParam('tab', { default: 'site', values: ['site', 'logs'] })()).toBe('logs')
      expect(persisted.queryParam('bad', { default: 'site', values: ['site', 'logs'] })()).toBe('site')
      expect(persisted.queryParam('bad', { values: ['site', 'logs'] })()).toBeUndefined()
    })
  })

  it('leaves a param equal to its default out of the URL once written', () => {
    setURL('http://localhost/page')

    reactive.root(() => {
      const tab = persisted.queryParam('tab', { default: 'site', values: ['site', 'logs'] })

      tab.set('logs')
      navigation.navigation.flush?.()
      expect(location.search).toBe('?tab=logs')

      tab.set('site')
      navigation.navigation.flush?.()
      expect(location.search).toBe('')
    })
  })

  it('is what the deprecated persisted.query gives', () => {
    setURL('http://localhost/page?n=3')

    reactive.root(() => {
      expect(persisted.persisted.query('n', 1, { values: [1, 2, 3] })()).toBe(3)
      expect(persisted.queryParam('n', { default: 1, values: [1, 2, 3] })()).toBe(3)
    })
  })
})

describe('navigate.query', () => {
  it('asks the before hook of navigation with the address its changes make, and keeps the page when refused', async () => {
    setURL('http://localhost/page?keep=1&drop=2')

    const asked: string[] = []
    const previous = navigation.navigation.hooks

    navigation.navigation.hooks = {} as never

    try {
      const stop = reactive.root((dispose) => {
        state.navigation.onBeforeNavigate(({ url }) => {
          asked.push(url.search)

          return false
        })

        return dispose
      })

      expect(await api.navigate.query({ page: 2, drop: null })).toBe(false)
      expect(asked).toEqual(['?keep=1&page=2'])
      stop()
    }
    finally {
      navigation.navigation.hooks = previous as never
    }
  })

  it('is the form navigate({ query }) still takes', async () => {
    setURL('http://localhost/page?a=1')

    const asked: string[] = []
    const previous = navigation.navigation.hooks

    navigation.navigation.hooks = {} as never

    try {
      const stop = reactive.root((dispose) => {
        state.navigation.onBeforeNavigate(({ url }) => {
          asked.push(url.search)

          return false
        })

        return dispose
      })

      expect(await api.navigate({ query: { b: 2 } })).toBe(false)
      expect(asked).toEqual(['?a=1&b=2'])
      stop()
    }
    finally {
      navigation.navigation.hooks = previous as never
    }
  })
})

describe('navigation.onNavigate', () => {
  it('is the hook the standalone onNavigate gives, called with the URL a swap shows and removed by its island', () => {
    const seen: string[] = []
    const dispose = reactive.root((stop) => {
      state.navigation.onNavigate(({ url }) => void seen.push(url.pathname))

      return stop
    })

    document.dispatchEvent(new CustomEvent('kay:navigate', { detail: { url: 'http://localhost/next' } }))
    expect(seen).toEqual(['/next'])

    dispose()
    document.dispatchEvent(new CustomEvent('kay:navigate', { detail: { url: 'http://localhost/after' } }))
    expect(seen).toEqual(['/next'])
  })
})

describe('{ signal } on an effect', () => {
  it('stops effect when it aborts, and starts nothing for one aborted already', () => {
    const controller = new AbortController()
    const count = core.signal(0)
    const seen: number[] = []

    reactive.root(() => {
      core.effect(() => void seen.push(count()), { signal: controller.signal })
      core.effect(() => void seen.push(-1), { signal: AbortSignal.abort() })
    })
    reactive.flush()
    count.set(1)
    reactive.flush()
    controller.abort()
    count.set(2)
    reactive.flush()
    expect(seen).toEqual([0, 1])
  })

  it('stops onMount before it runs when aborted first', () => {
    const controller = new AbortController()
    const ran: string[] = []

    reactive.root(() => {
      core.onMount(() => void ran.push('mounted'), { signal: controller.signal })
      core.onMount(() => void ran.push('late'), { signal: controller.signal })
    })
    controller.abort()
    reactive.flush()
    expect(ran).toEqual([])

    reactive.root(() => core.onMount(() => void ran.push('free')))
    reactive.flush()
    expect(ran).toEqual(['free'])
  })

  it.each(['debounced', 'throttled'] as const)('stops %s following its source when aborted', (name) => {
    jest.useFakeTimers()

    try {
      const controller = new AbortController()
      const typed = core.signal('a')
      const settled = reactive.root(() => core[name](typed, '100ms', { signal: controller.signal }))

      reactive.flush()
      controller.abort()
      typed.set('b')
      reactive.flush()
      jest.advanceTimersByTime(500)
      expect(settled()).toBe('a')
    }
    finally {
      jest.useRealTimers()
    }
  })
})
