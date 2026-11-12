import { describe, expect, it } from 'bun:test'
import { flush, root } from '../src/runtime'
import { renderEffect } from '../src/runtime/reactive'
import { reactiveMap, reactiveSet } from '../src/runtime/reactive-collections'
import { snapshot, store, trackedCount } from '../src/runtime/store'

// Runs `read` now and again whenever what it read changed; `stop` ends it.
function watching<T>(read: () => T) {
  const seen: T[] = []
  const stop = root((dispose) => {
    renderEffect(() => void seen.push(read()))

    return dispose
  })

  return { seen, stop }
}

describe('reactiveMap', () => {
  it('is a Map built from an iterable', () => {
    const map = reactiveMap([['a', 1], ['b', 2]])

    expect(map).toBeInstanceOf(Map)
    expect(map.get('b')).toBe(2)
    expect(map.size).toBe(2)
    expect(new Map(map)).toEqual(new Map([['a', 1], ['b', 2]]))
    expect(structuredClone(map)).toEqual(new Map([['a', 1], ['b', 2]]))
  })

  it('tracks key, size and iteration', () => {
    const map = reactiveMap<string, { n: number }>([['a', { n: 1 }]])
    const a = watching(() => map.get('a')?.n)
    const b = watching(() => map.has('b'))
    const size = watching(() => map.size)
    const keys = watching(() => [...map.keys()].join())
    const values = watching(() => [...map.values()].map(item => item.n).join())
    const entries = watching(() => [...map].map(([key, item]) => key + item.n).join(''))
    const each = watching(() => {
      let text = ''

      // eslint-disable-next-line kaynooo/array-foreach -- a Map's own forEach
      map.forEach((item, key) => (text += key + item.n))

      return text
    })

    map.set('b', { n: 2 })
    flush()
    expect(a.seen).toEqual([1])
    expect(b.seen).toEqual([false, true])
    expect(size.seen).toEqual([1, 2])
    expect(keys.seen).toEqual(['a', 'a,b'])
    expect(values.seen).toEqual(['1', '1,2'])
    expect(entries.seen).toEqual(['a1', 'a1b2'])
    expect(each.seen).toEqual(['a1', 'a1b2'])

    map.get('a')!.n = 5
    flush()
    expect(a.seen).toEqual([1, 5])
    expect(b.seen).toEqual([false, true])

    map.set('b', map.get('b')!)
    map.delete('zzz')
    flush()
    expect(size.seen).toHaveLength(2)

    map.delete('a')
    flush()
    expect(a.seen).toEqual([1, 5, undefined])
    expect(size.seen).toEqual([1, 2, 1])
    expect(keys.seen.at(-1)).toBe('b')

    map.clear()
    flush()
    expect(b.seen).toEqual([false, true, false])
    expect(size.seen.at(-1)).toBe(0)

    for (const one of [a, b, size, keys, values, entries, each])
      one.stop()
  })

  it('tells the readers of a replaced value and the iterators, not the size or keys', () => {
    const map = reactiveMap([['a', 1]])
    const a = watching(() => map.get('a'))
    const size = watching(() => map.size)
    const keys = watching(() => [...map.keys()].join())
    const values = watching(() => [...map.values()].join())

    map.set('a', 2)
    flush()
    expect(a.seen).toEqual([1, 2])
    expect(values.seen).toEqual(['1', '2'])
    expect(size.seen).toEqual([1])
    expect(keys.seen).toEqual(['a'])

    for (const one of [a, size, keys, values])
      one.stop()
  })

  it('hands object keys and values back as store objects, and finds a key as read', () => {
    const key = { id: 1 }
    const map = reactiveMap<object, Set<number>>([[key, new Set([1])]])
    const [fromKeys] = [...map.keys()]
    const fromEntries = [...map][0]![0]
    let fromEach: unknown

    // eslint-disable-next-line kaynooo/array-foreach -- a Map's own forEach
    map.forEach((_set, one) => (fromEach = one))
    expect(fromEntries).toBe(fromKeys!)
    expect(fromEach).toBe(fromKeys!)
    expect(map.get(fromKeys!)).toBeInstanceOf(Set)
    expect(map.delete(fromKeys!)).toBe(true)
    expect(map.size).toBe(0)
  })

  it('leaves nothing tracked once a reader is disposed', async () => {
    const map = reactiveMap<number, number>()
    const watcher = watching(() => map.has(7))

    expect(trackedCount(map)).toBe(1)
    watcher.stop()
    await Promise.resolve()
    expect(trackedCount(map)).toBe(0)
  })

  it('is copied to a plain Map by snapshot, deeply and in a store', () => {
    const map = reactiveMap([['a', { n: 1 }]])
    const data = store({ map })
    const copy = snapshot(data)

    expect(copy.map).toEqual(new Map([['a', { n: 1 }]]))
    expect(copy.map).not.toBe(map)
    expect(Object.getPrototypeOf(copy.map)).toBe(Map.prototype)
    map.get('a')!.n = 2
    expect(copy.map.get('a')).toEqual({ n: 1 })
  })
})

describe('snapshot of a collection', () => {
  it('follows a cycle and keeps a shared collection shared', () => {
    const map = reactiveMap<string, unknown>()
    const set = reactiveSet<unknown>()

    map.set('self', map)
    set.add(set)

    const copy = snapshot({ x: map, y: map, set })

    expect(copy.x.get('self')).toBe(copy.x)
    expect(copy.x).toBe(copy.y)
    expect(copy.set.has(copy.set)).toBe(true)
  })
})

describe('reactiveSet', () => {
  it('is a Set built from an iterable, with Set algebra', () => {
    const set = reactiveSet([1, 2])

    expect(set).toBeInstanceOf(Set)
    expect(set.union(new Set([3]))).toEqual(new Set([1, 2, 3]))
    expect(set.isSubsetOf(new Set([1, 2, 3]))).toBe(true)
    expect(structuredClone(set)).toEqual(new Set([1, 2]))
  })

  it('tracks has per value, size and iteration', () => {
    const set = reactiveSet<number>()
    const one = watching(() => set.has(1))
    const two = watching(() => set.has(2))
    const size = watching(() => set.size)
    const all = watching(() => [...set].join())
    const each = watching(() => [...set.keys()].join() + [...set.entries()].join(';'))

    set.add(1)
    set.add(1)
    flush()
    expect(one.seen).toEqual([false, true])
    expect(two.seen).toEqual([false])
    expect(size.seen).toEqual([0, 1])
    expect(all.seen).toEqual(['', '1'])
    expect(each.seen).toEqual(['', '11,1'])

    expect(set.delete(1)).toBe(true)
    expect(set.delete(1)).toBe(false)
    set.add(2)
    set.clear()
    flush()
    expect(one.seen).toEqual([false, true, false])
    expect(two.seen).toEqual([false, false])
    expect(size.seen.at(-1)).toBe(0)

    for (const watcher of [one, two, size, all, each])
      watcher.stop()
  })

  it('lets a Set drop its elements while iterating it, and runs forEach as a Set does', () => {
    const set = reactiveSet([1, 2, 3])

    for (const one of set)
      set.delete(one)

    expect(set.size).toBe(0)

    const seen: number[][] = []

    // eslint-disable-next-line kaynooo/array-foreach -- a Set's own forEach
    reactiveSet([4]).forEach((value, again) => seen.push([value, again]))
    expect(seen).toEqual([[4, 4]])
  })

  it('re-runs a reader of the Set algebra on any change', () => {
    const set = reactiveSet([1])
    const union = watching(() => set.union(new Set([9])).size)
    const subset = watching(() => set.isSubsetOf(new Set([1, 2])))

    set.add(3)
    flush()
    expect(union.seen).toEqual([2, 3])
    expect(subset.seen).toEqual([true, false])
    union.stop()
    subset.stop()
  })

  it('is copied to a plain Set by snapshot', () => {
    const copy = snapshot({ set: reactiveSet(['x']) })

    expect(copy.set).toEqual(new Set(['x']))
    expect(Object.getPrototypeOf(copy.set)).toBe(Set.prototype)
  })
})
