import { describe, expect, test } from 'bun:test'
import { batch, computed, effect, onCleanup, root, selector, signal, snapshot, store } from '../src/index'

describe('reactivity kernel', () => {
  test('signal read, write, and synchronous effect flush', () => {
    const count = signal(0)
    const seen: number[] = []
    const stop = effect(() => {
      seen.push(count.value)
    })

    expect(seen).toEqual([0])
    count.value = 1
    expect(seen).toEqual([0, 1])
    count.value = 1 // Object.is no-op
    expect(seen).toEqual([0, 1])
    count.value++
    expect(seen).toEqual([0, 1, 2])
    stop()
    count.value = 10
    expect(seen).toEqual([0, 1, 2])
  })

  test('glitch-free diamond computed graph', () => {
    const a = signal(1)
    const b = computed(() => a.value * 2)
    const c = computed(() => a.value * 3)
    const d = computed(() => b.value + c.value)

    const seen: number[] = []
    const stop = effect(() => {
      seen.push(d.value)
    })

    expect(seen).toEqual([5])
    a.value = 2
    expect(seen).toEqual([5, 10])
    stop()
  })

  test('computed skips downstream when output is unchanged', () => {
    const n = signal(1)
    const isEven = computed(() => n.value % 2 === 0)
    let runs = 0

    const stop = effect(() => {
      isEven.value
      runs++
    })

    expect(runs).toBe(1)
    n.value = 3 // still odd -> isEven stays false
    expect(runs).toBe(1)
    n.value = 4 // now even -> isEven becomes true
    expect(runs).toBe(2)
    stop()
  })

  test('dynamic dependency pruning unsubscribes stale branches', () => {
    const flag = signal(true)
    const a = signal('A')
    const b = signal('B')
    const seen: string[] = []

    const stop = effect(() => {
      seen.push(flag.value ? a.value : b.value)
    })

    expect(seen).toEqual(['A'])
    b.value = 'B2' // not tracked
    expect(seen).toEqual(['A'])

    flag.value = false
    expect(seen).toEqual(['A', 'B2'])

    a.value = 'A2' // pruned!
    expect(seen).toEqual(['A', 'B2'])
    stop()
  })

  test('batch coalesces multiple writes into one flush', () => {
    const a = signal(1)
    const b = signal(2)
    let runs = 0

    const stop = effect(() => {
      a.value + b.value
      runs++
    })

    expect(runs).toBe(1)
    batch(() => {
      a.value = 10
      b.value = 20
    })
    expect(runs).toBe(2)
    stop()
  })

  test('root disposes nested effects and cleanups', () => {
    const count = signal(0)
    let cleaned = 0
    let runs = 0

    const dispose = root((d) => {
      effect(() => {
        count.value
        runs++
        return () => {
          cleaned++
        }
      })
      onCleanup(() => {
        cleaned += 10
      })
      return d
    })

    expect(runs).toBe(1)
    count.value = 1
    expect(runs).toBe(2)
    expect(cleaned).toBe(1)

    dispose()
    expect(cleaned).toBe(12)
    count.value = 2
    expect(runs).toBe(2)
  })

  test('selector notifies only affected keys in O(1)', () => {
    const selected = signal<number | null>(null)
    const sel = selector(() => selected.value)
    const hits = new Map<number, number>()

    const dispose = root((d) => {
      for (let i = 1; i <= 5; i++) {
        effect(() => {
          sel.is(i)
          hits.set(i, (hits.get(i) ?? 0) + 1)
        })
      }
      return d
    })

    for (let i = 1; i <= 5; i++)
      expect(hits.get(i)).toBe(1)

    selected.value = 3
    expect(hits.get(3)).toBe(2)
    expect(hits.get(1)).toBe(1)
    expect(hits.get(2)).toBe(1)

    selected.value = 5
    expect(hits.get(3)).toBe(3)
    expect(hits.get(5)).toBe(2)
    expect(hits.get(1)).toBe(1)

    dispose()
  })

  test('store tracks deep mutations and produces clean snapshot', () => {
    const state = store({ count: 0, nested: { label: 'hi' } })
    const seen: string[] = []

    const stop = effect(() => {
      seen.push(`${state.count}:${state.nested.label}`)
    })

    expect(seen).toEqual(['0:hi'])
    state.count++
    expect(seen).toEqual(['0:hi', '1:hi'])
    state.nested.label = 'bye'
    expect(seen).toEqual(['0:hi', '1:hi', '1:bye'])
    expect(snapshot(state)).toEqual({ count: 1, nested: { label: 'bye' } })
    stop()
  })

  test('an effect that throws does not stop the effects queued behind it', () => {
    const s = signal(0)
    const seen: number[] = []
    const dispose = root((d) => {
      effect(() => {
        if (s.value === 1)
          throw new Error('boom')
      })
      effect(() => {
        seen.push(s.value)
      })
      return d
    })

    expect(() => { s.value = 1 }).toThrow('boom')
    s.value = 2
    s.value = 3
    expect(seen).toEqual([0, 1, 2, 3])
    dispose()
  })

  test('every effect error of one flush reaches the caller', () => {
    const s = signal(0)
    const dispose = root((d) => {
      effect(() => {
        if (s.value === 1)
          throw new Error('first')
      })
      effect(() => {
        if (s.value === 1)
          throw new Error('second')
      })
      return d
    })

    let caught: unknown
    try {
      s.value = 1
    }
    catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors.map(e => (e as Error).message)).toEqual(['first', 'second'])
    dispose()
  })

  test('cleanups and effects created inside an effect are disposed before it re-runs', () => {
    const s = signal(0)
    const inner = signal(0)
    const log: string[] = []
    const dispose = root((d) => {
      effect(() => {
        const run = s.value
        onCleanup(() => log.push(`cleanup ${run}`))
        effect(() => {
          log.push(`inner ${run}:${inner.value}`)
        })
      })
      return d
    })

    s.value = 1
    inner.value = 1
    expect(log).toEqual(['inner 0:0', 'cleanup 0', 'inner 1:0', 'inner 1:1'])
    dispose()
    expect(log.at(-1)).toBe('cleanup 1')
  })

  test('push and splice on a store array notify length readers', () => {
    const state = store({ items: [1, 2] })
    const lengths: number[] = []
    const stop = effect(() => {
      lengths.push(state.items.length)
    })

    state.items.push(3)
    state.items.splice(0, 1)
    expect(lengths).toEqual([2, 3, 2])
    stop()
  })
})
