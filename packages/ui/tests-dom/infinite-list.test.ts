import type { Mounted } from 'kay/test'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mount, settle } from 'kay/test'
import { click } from './dom'

// Stand-ins for the observers happy-dom lacks or never fires: each one made is kept, to be fired by hand.
class Observer {
  static made: Observer[] = []
  observed: Element[] = []

  constructor(public callback: (entries: unknown[]) => void) {
    Observer.made.push(this)
  }

  observe(element: Element) {
    this.observed.push(element)
  }

  unobserve(element: Element) {
    this.observed = this.observed.filter(observed => observed !== element)
  }

  disconnect = () => undefined
}

const { IntersectionObserver, ResizeObserver, MutationObserver } = globalThis
let mounted: Mounted | undefined
const asked: number[] = []
let release: ((page: { id: number }[] | undefined) => void)[] = []

beforeEach(() => {
  Observer.made = []
  Object.assign(globalThis, { IntersectionObserver: Observer, ResizeObserver: Observer, MutationObserver: Observer })
})

afterEach(() => {
  mounted?.unmount()
  Object.assign(globalThis, { IntersectionObserver, ResizeObserver, MutationObserver })
  asked.length = 0
  release = []
})

async function list(props: Record<string, unknown> = {}) {
  mounted = await mount('src/components/infinite.kay', {
    size: 3,
    onLoad: async (offset: number) => {
      asked.push(offset)

      return new Promise<{ id: number }[] | undefined>(resolve => release.push(resolve))
    },
    ...props,
  })

  return mounted.root
}

const ids = (root: Element) => [...root.querySelectorAll('.row')].map(row => row.textContent)

// The sentinel comes into view.
function reach(root: Element): void {
  const sentinel = root.querySelector('.kui-when-visible')!

  Observer.made.find(made => made.observed.includes(sentinel))!.callback([{ isIntersecting: true }])
}

describe('LoadMore', () => {
  test('draws no sentinel for a list whose first page was short', async () => {
    const root = await list({ first: [{ id: 1 }] })

    expect(ids(root)).toEqual(['1'])
    expect(root.querySelector('.kui-when-visible')).toBeNull()
    expect(root.querySelector('.kui-load-more-failed')).toBeNull()
  })

  test('loads a page as the sentinel comes into view, shows a loading status meanwhile and drops duplicates', async () => {
    const root = await list()

    reach(root)
    await settle()

    expect(asked).toEqual([3])
    expect(root.querySelector('.kui-load-more-loading')?.getAttribute('role')).toBe('status')
    expect(root.querySelector('.kui-load-more-loading')?.textContent).toBe('Loading more…')

    release[0]!([{ id: 3 }, { id: 4 }, { id: 5 }])
    await settle()

    expect(ids(root)).toEqual(['1', '2', '3', '4', '5'])
    expect(root.querySelector('.kui-load-more-loading')?.textContent).toBe('')
  })

  test('a sentinel firing twice at once loads one page', async () => {
    const root = await list()

    reach(root)
    reach(root)
    await settle()

    expect(asked).toEqual([3])
  })

  test('a short page removes the sentinel', async () => {
    const root = await list()

    reach(root)
    release[0]!([{ id: 4 }])
    await settle()

    expect(ids(root)).toEqual(['1', '2', '3', '4'])
    expect(root.querySelector('.kui-when-visible')).toBeNull()
  })

  test('a failed page shows an alert with Try again in place of the sentinel, and Try again loads that page', async () => {
    const root = await list()

    reach(root)
    release[0]!(undefined)
    await settle()

    const failed = root.querySelector('.kui-load-more-failed')!

    expect(failed.getAttribute('role')).toBe('alert')
    expect(failed.textContent).toContain('Could not load more.')
    expect(root.querySelector('.kui-when-visible')).toBeNull()

    click(failed.querySelector('button'))
    await settle()

    expect(asked).toEqual([3, 3])
    expect(root.querySelector('.kui-load-more-failed button')?.getAttribute('aria-busy')).toBe('true')

    release[1]!([{ id: 4 }, { id: 5 }, { id: 6 }])
    await settle()

    expect(ids(root)).toEqual(['1', '2', '3', '4', '5', '6'])
    expect(root.querySelector('.kui-load-more-failed')).toBeNull()
    expect(root.querySelector('.kui-when-visible')).not.toBeNull()
  })

  test('the texts are replaced through their props', async () => {
    const root = await list({ loadingLabel: 'Chargement…', failureLabel: 'Echec', retryLabel: 'Reessayer' })

    reach(root)
    await settle()

    expect(root.querySelector('.kui-load-more-loading')?.textContent).toBe('Chargement…')

    release[0]!(undefined)
    await settle()

    expect(root.querySelector('.kui-load-more-failed')?.textContent).toContain('Echec')
    expect(root.querySelector('.kui-load-more-failed button')?.textContent).toContain('Reessayer')
  })

  test('a page landing after the list unmounted throws nothing', async () => {
    const root = await list()

    reach(root)
    mounted!.unmount()
    mounted = undefined
    release[0]!([{ id: 4 }])
    await settle()

    expect(asked).toEqual([3])
    expect(root.querySelector('.row')).toBeNull()
  })
})
