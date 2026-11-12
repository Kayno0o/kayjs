import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { child } from '../src/runtime/html'
import { island, IslandPropsError } from '../src/runtime/island.server'

let when: typeof import('../src/runtime/hydrate-when')

beforeAll(async () => {
  GlobalRegistrator.register()
  when = await import('../src/runtime/hydrate-when')
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const rect = (width: number, height: number, top = 0, left = 0) => ({ width, height, top, left }) as DOMRectReadOnly

const fire = (callback: IntersectionObserverCallback, entries: object[]) => callback(entries as unknown as IntersectionObserverEntry[], {} as IntersectionObserver)

describe('hydrate="interaction"', () => {
  it('hydrates once on the first pointer event inside, and not before', () => {
    document.body.innerHTML = '<slot><button>A</button></slot>'

    const slot = document.querySelector('slot')!
    let runs = 0

    when.whenInteraction(slot, async () => void runs++)
    slot.dispatchEvent(new Event('mouseover', { bubbles: true }))
    expect(runs).toBe(0)
    slot.querySelector('button')!.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    slot.querySelector('button')!.dispatchEvent(new Event('keydown', { bubbles: true }))
    slot.querySelector('button')!.dispatchEvent(new Event('focusin', { bubbles: true }))
    expect(runs).toBe(1)
  })

  it.each(['focusin', 'keydown', 'touchstart'])('hydrates on %s', (type) => {
    document.body.innerHTML = '<slot><input></slot>'

    let runs = 0

    when.whenInteraction(document.querySelector('slot')!, async () => void runs++)
    document.querySelector('input')!.dispatchEvent(new Event(type, { bubbles: true }))
    expect(runs).toBe(1)
  })
})

describe('hydrate="media(...)"', () => {
  const stub = (matches: boolean) => {
    const listeners = new Set<() => void>()
    const list = { matches, addEventListener: (_: string, listener: () => void) => listeners.add(listener), removeEventListener: (_: string, listener: () => void) => listeners.delete(listener) }

    globalThis.matchMedia = (() => list) as unknown as typeof matchMedia

    return { list, listeners }
  }

  it('reads a bare feature as one in brackets, and a full query as it is', () => {
    const asked: string[] = []

    globalThis.matchMedia = ((query: string) => {
      asked.push(query)

      return { matches: true, media: query.startsWith('(') || query.includes(' and ') ? query : 'not all' }
    }) as unknown as typeof matchMedia

    const nothing = async () => undefined

    when.whenMedia('max-width: 40rem', nothing)
    when.whenMedia('screen and (min-width: 1px)', nothing)
    expect(asked).toEqual(['max-width: 40rem', '(max-width: 40rem)', 'screen and (min-width: 1px)'])
  })

  it('hydrates at once when the query matches', () => {
    stub(true)

    let runs = 0

    when.whenMedia('(max-width: 40rem)', async () => void runs++)
    expect(runs).toBe(1)
  })

  it('waits for the query to match, then hydrates once and stops listening', () => {
    const { list, listeners } = stub(false)
    let runs = 0

    when.whenMedia('(max-width: 40rem)', async () => void runs++)
    expect(runs).toBe(0)

    for (const listener of listeners)
      listener()

    expect(runs).toBe(0)
    list.matches = true

    for (const listener of listeners)
      listener()

    expect(runs).toBe(1)
    expect(listeners.size).toBe(0)
  })
})

describe('whenVisible on an island with no box', () => {
  it('watches the parent once every child reports no box, and hydrates when it nears', () => {
    const watched: Element[] = []
    let callback!: IntersectionObserverCallback
    let disconnected = 0

    globalThis.IntersectionObserver = class {
      constructor(given: IntersectionObserverCallback) {
        callback = given
      }

      observe(target: Element) {
        watched.push(target)
      }

      disconnect() {
        disconnected++
      }
    } as unknown as typeof IntersectionObserver

    document.body.innerHTML = '<section><slot><p>A</p><p>B</p></slot></section>'

    const slot = document.querySelector('slot')!
    const section = document.querySelector('section')!
    const [first, second] = [...slot.children]
    let runs = 0

    when.whenVisible(slot, async () => void runs++)
    expect(watched).toEqual([first!, second!])

    // A child with a box, even off screen, is reason enough not to watch the parent.
    fire(callback, [{ isIntersecting: false, target: first!, boundingClientRect: rect(0, 0) }, { isIntersecting: false, target: second!, boundingClientRect: rect(10, 10, 500) }])
    expect(watched).toHaveLength(2)

    fire(callback, [{ isIntersecting: false, target: second!, boundingClientRect: rect(0, 0) }])
    expect(watched).toEqual([first!, second!, section])

    // Watched once.
    fire(callback, [{ isIntersecting: false, target: first!, boundingClientRect: rect(0, 0) }])
    expect(watched).toHaveLength(3)

    fire(callback, [{ isIntersecting: true, target: section, boundingClientRect: rect(100, 100) }])
    expect(runs).toBe(1)
    expect(disconnected).toBe(1)
  })
})

describe('server markup of the new modes', () => {
  const Counter = island('counter.kay', () => null)

  it('writes the mode on the slot, escaping the query', () => {
    expect(child(Counter({ hydrate: 'interaction' }))).toContain('data-hydrate="interaction"')
    expect(child(Counter({ hydrate: 'media(max-width: 40rem)' }))).toContain('data-hydrate="media(max-width: 40rem)"')
    expect(child(Counter({ hydrate: 'media(a"b)' }))).toContain('data-hydrate="media(a&quot;b)"')
  })

  it('refuses a media with no query', () => {
    expect(() => child(Counter({ hydrate: 'media()' }))).toThrow(IslandPropsError)
    expect(() => child(Counter({ hydrate: 'media( )' }))).toThrow(IslandPropsError)
    expect(() => child(Counter({ hydrate: 'media(max-width: 1px' as 'media(x)' }))).toThrow(IslandPropsError)
  })
})
