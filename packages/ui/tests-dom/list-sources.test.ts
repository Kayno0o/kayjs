import type { Mounted } from 'kay/test'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import ListCollections from '../tests/fixture/src/components/list-collections.kay'
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

  unobserve = () => undefined
  disconnect = () => undefined
}

const { IntersectionObserver, ResizeObserver, MutationObserver } = globalThis
let mounted: Mounted | undefined
let asked: number[] = []
let release: ((page: number[] | undefined) => void)[] = []

beforeEach(() => {
  Observer.made = []
  Object.assign(globalThis, { IntersectionObserver: Observer, ResizeObserver: Observer, MutationObserver: Observer })
})

afterEach(() => {
  mounted?.unmount()
  Object.assign(globalThis, { IntersectionObserver, ResizeObserver, MutationObserver })
  asked = []
  release = []
})

async function collection(kind: string) {
  mounted = await mountComponent(ListCollections, { kind, onLoad: async (offset: number) => {
    asked.push(offset)

    return new Promise<number[] | undefined>(resolve => release.push(resolve))
  } })
  await settle()

  return mounted.root
}

// The sentinel comes into view.
async function reach(root: Element) {
  const sentinel = root.querySelector('.kui-when-visible')!

  Observer.made.find(made => made.observed.includes(sentinel))!.callback([{ isIntersecting: true }])
  await settle()
}

describe.each(['virtual', 'masonry'])('%s', (kind) => {
  const texts = (root: Element) => [...root.querySelectorAll('.cell')].map(cell => cell.textContent)

  test('draws the rows of a list and loads the next page as the end comes into view', async () => {
    const root = await collection(kind)

    expect(texts(root)).toEqual(['Row 0', 'Row 1', 'Row 2'])
    expect(asked).toEqual([])

    await reach(root)
    expect(asked).toEqual([3])

    release[0]!([3, 4, 5])
    await settle()
    expect(texts(root)).toEqual(['Row 0', 'Row 1', 'Row 2', 'Row 3', 'Row 4', 'Row 5'])
  })

  test('shows a failed page as LoadMore\'s alert, whose retry loads it again', async () => {
    const root = await collection(kind)

    await reach(root)
    release[0]!(undefined)
    await settle()
    expect(root.querySelector('.kui-load-more-failed')?.getAttribute('role')).toBe('alert')

    click(root.querySelector('.kui-load-more-failed button'))
    await settle()
    expect(asked).toEqual([3, 3])
    release[1]!([3])
    await settle()
    expect(texts(root)).toEqual(['Row 0', 'Row 1', 'Row 2', 'Row 3'])
    expect(root.querySelector('.kui-load-more-failed')).toBeNull()
  })
})

describe('carousel and gallery', () => {
  const next = (root: Element) => click(root.querySelector('[data-side=next]'))
  const count = (root: Element, kind: string) => kind === 'carousel' ? root.querySelectorAll('[data-part=slide]').length : root.querySelectorAll('[data-part=thumb]').length

  test.each(['carousel', 'gallery'])('%s loads the next page as the reader nears its last item', async (kind) => {
    const root = await collection(kind)

    expect(count(root, kind)).toBe(3)
    expect(asked).toEqual([])

    next(root)
    await settle()
    expect(asked).toEqual([3])

    release[0]!([3, 4, 5])
    await settle()
    expect(count(root, kind)).toBe(6)
  })

  test.each(['carousel', 'gallery'])('%s shows a failed page as LoadMore\'s alert with its retry', async (kind) => {
    const root = await collection(kind)

    next(root)
    await settle()
    release[0]!(undefined)
    await settle()
    expect(root.querySelector('.kui-load-more-failed')?.getAttribute('role')).toBe('alert')

    click(root.querySelector('.kui-load-more-failed button'))
    await settle()
    expect(asked).toEqual([3, 3])
  })
})
