import { afterEach, describe, expect, it, jest } from 'bun:test'
import { signal, throttled } from '../src/runtime'
import { elementSize } from '../src/runtime/element-size'
import { inView } from '../src/runtime/in-view'
import { online } from '../src/runtime/online'
import { flush, renderOnServer, root } from '../src/runtime/reactive'
import { pageVisible } from '../src/runtime/visibility'

const globals = globalThis as unknown as Record<string, unknown>
const originals = new Map<string, unknown>()

// Sets a global for one test, restored after it.
function stub(name: string, value: unknown) {
  if (!originals.has(name))
    originals.set(name, globals[name])

  globals[name] = value
}

afterEach(() => {
  for (const [name, value] of originals)
    globals[name] = value

  originals.clear()
})

describe('online', () => {
  it('reads its fallback where there is no navigator, and the browser once mounted', () => {
    stub('navigator', undefined)
    root(() => expect(online()()).toBe(true))
    root(() => expect(online(false)()).toBe(false))
    flush()

    const win = new EventTarget()

    stub('window', win)
    stub('navigator', { onLine: false })

    root((dispose) => {
      const connected = online()

      expect(connected()).toBe(true)
      flush()
      expect(connected()).toBe(false)

      win.dispatchEvent(new Event('online'))
      expect(connected()).toBe(true)
      win.dispatchEvent(new Event('offline'))
      expect(connected()).toBe(false)

      dispose()
      win.dispatchEvent(new Event('online'))
      expect(connected()).toBe(false)
    })
  })
})

describe('pageVisible', () => {
  it('follows the tab and stops with its island', () => {
    const doc = Object.assign(new EventTarget(), { hidden: true })

    stub('document', doc)

    root((dispose) => {
      const shown = pageVisible()

      expect(shown()).toBe(true)
      flush()
      expect(shown()).toBe(false)

      doc.hidden = false
      doc.dispatchEvent(new Event('visibilitychange'))
      expect(shown()).toBe(true)

      dispose()
      doc.hidden = true
      doc.dispatchEvent(new Event('visibilitychange'))
      expect(shown()).toBe(true)
    })
  })
})

describe('throttled', () => {
  it('shows the first change at once and the last one when the wait ends', () => {
    jest.useFakeTimers()

    try {
      const source = signal(0)
      const { slow, dispose } = root(dispose => ({ slow: throttled(source, '100ms'), dispose }))

      flush()
      expect(slow()).toBe(0)

      source.set(1)
      flush()
      expect(slow()).toBe(1)

      source.set(2)
      flush()
      jest.advanceTimersByTime(40)
      source.set(3)
      flush()
      expect(slow()).toBe(1)

      jest.advanceTimersByTime(59)
      expect(slow()).toBe(1)
      jest.advanceTimersByTime(1)
      expect(slow()).toBe(3)

      source.set(4)
      flush()
      jest.advanceTimersByTime(10)
      dispose()
      jest.advanceTimersByTime(500)
      expect(slow()).toBe(3)
    }
    finally {
      jest.useRealTimers()
    }
  })

  it('keeps the first value while the server renders', () => {
    const source = signal('a')

    expect(renderOnServer(() => throttled(source, '100ms'))()).toBe('a')
  })
})

class FakeObserver {
  static instances: FakeObserver[] = []
  observed = new Set<Element>()
  disconnected = false

  constructor(readonly callback: (entries: never[]) => void) {
    FakeObserver.instances.push(this)
  }

  observe(element: Element) {
    this.observed.add(element)
  }

  unobserve(element: Element) {
    this.observed.delete(element)
  }

  disconnect() {
    this.disconnected = true
    this.observed.clear()
  }
}

const one = { id: 'one' } as unknown as Element
const two = { id: 'two' } as unknown as Element

describe('inView', () => {
  const report = (observer: FakeObserver, target: Element, isIntersecting: boolean) =>
    observer.callback([{ target, isIntersecting }] as never)

  it('is false with no IntersectionObserver, as on the server', () => {
    stub('IntersectionObserver', undefined)
    root(() => {
      const seen = inView()

      seen.ref(one)()
      expect(seen.visible()).toBe(false)
    })
  })

  it('is true while any element shows, and lets go of a removed one', () => {
    FakeObserver.instances = []
    stub('IntersectionObserver', FakeObserver)

    root((dispose) => {
      const seen = inView()
      const stopOne = seen.ref(one)
      const stopTwo = seen.ref(two)
      const [observer] = FakeObserver.instances

      expect(FakeObserver.instances).toHaveLength(1)
      expect(observer!.observed.size).toBe(2)

      report(observer!, one, true)
      expect(seen.visible()).toBe(true)
      report(observer!, two, true)
      report(observer!, one, false)
      expect(seen.visible()).toBe(true)

      stopTwo()
      expect(seen.visible()).toBe(false)
      expect(observer!.observed.has(two)).toBe(false)

      stopOne()
      dispose()
      expect(observer!.disconnected).toBe(true)
    })
  })

  it('stays true and stops watching once in view with `once`', () => {
    FakeObserver.instances = []
    stub('IntersectionObserver', FakeObserver)

    root(() => {
      const seen = inView({ once: true })

      seen.ref(one)

      const [observer] = FakeObserver.instances

      report(observer!, one, true)
      report(observer!, one, false)
      expect(seen.visible()).toBe(true)
      expect(observer!.disconnected).toBe(true)
    })
  })
})

describe('elementSize', () => {
  const measure = (observer: FakeObserver, target: Element, width: number, height: number) =>
    observer.callback([{ target, contentRect: { width, height } }] as never)

  it('reads 0 with no ResizeObserver, as on the server', () => {
    stub('ResizeObserver', undefined)
    root(() => {
      const size = elementSize()

      size.ref(one)()
      expect([size.width(), size.height()]).toEqual([0, 0])
    })
  })

  it('unobserves a removed element and follows the last one that remains', () => {
    FakeObserver.instances = []
    stub('ResizeObserver', FakeObserver)

    root((dispose) => {
      const size = elementSize()
      const stopOne = size.ref(one)
      const stopTwo = size.ref(two)
      const [observer] = FakeObserver.instances

      measure(observer!, one, 120, 40)
      expect([size.width(), size.height()]).toEqual([120, 40])
      measure(observer!, two, 77, 55)
      expect([size.width(), size.height()]).toEqual([77, 55])

      stopTwo()
      expect(observer!.observed.has(two)).toBe(false)
      expect([size.width(), size.height()]).toEqual([120, 40])

      stopOne()
      expect(observer!.observed.size).toBe(0)
      expect([size.width(), size.height()]).toEqual([0, 0])

      dispose()
      expect(observer!.disconnected).toBe(true)
    })
  })
})
