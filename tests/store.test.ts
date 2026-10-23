import { describe, expect, it } from 'bun:test'
import { batch, flush, root, signal } from '../src/runtime'
import { renderEffect } from '../src/runtime/reactive'
import { snapshot, store } from '../src/runtime/store'

// Runs `read` now and again whenever what it read changed, counting its runs; `stop` ends it.
function watching<T>(read: () => T) {
  const seen: T[] = []
  const stop = root((dispose) => {
    renderEffect(() => void seen.push(read()))

    return dispose
  })

  return { seen, stop }
}

describe('store', () => {
  it('tracks a nested property read, and only that one', () => {
    const game = store({ coins: 0, world: { depth: 1, name: 'a' } })
    const coins = watching(() => game.coins)
    const depth = watching(() => game.world.depth)

    game.coins += 5
    flush()
    expect(coins.seen).toEqual([0, 5])
    expect(depth.seen).toEqual([1])

    game.world.depth = 2
    flush()
    expect(coins.seen).toEqual([0, 5])
    expect(depth.seen).toEqual([1, 2])
    coins.stop()
    depth.stop()
  })

  it('does not re-run a reader of a sibling property', () => {
    const game = store({ a: 1, b: 1 })
    const a = watching(() => game.a)

    game.b = 2
    flush()
    expect(a.seen).toEqual([1])
    a.stop()
  })

  it('keeps one proxy for one object, wherever it is reached from', () => {
    const shared = { n: 1 }
    const game = store({ left: shared, right: shared })

    expect(game.left).toBe(game.right)
    expect(store(game)).toBe(game)
  })

  it('tracks array push, splice, index writes and length', () => {
    const list = store({ items: [1, 2, 3] })
    const length = watching(() => list.items.length)
    const first = watching(() => list.items[0])
    const joined = watching(() => list.items.join(','))
    const sum = watching(() => list.items.reduce((total, item) => total + item, 0))

    list.items.push(4)
    flush()
    expect(length.seen).toEqual([3, 4])
    expect(first.seen).toEqual([1])
    expect(joined.seen).toEqual(['1,2,3', '1,2,3,4'])

    list.items.splice(0, 2, 9)
    flush()
    expect(list.items.slice()).toEqual([9, 3, 4])
    expect(length.seen).toEqual([3, 4, 3])
    expect(first.seen).toEqual([1, 9])
    expect(sum.seen.at(-1)).toBe(16)

    list.items[5] = 1
    flush()
    expect(length.seen.at(-1)).toBe(6)

    list.items.length = 1
    flush()
    expect(list.items).toEqual([9])
    expect(length.seen.at(-1)).toBe(1)
    for (const one of [length, first, joined, sum])
      one.stop()
  })

  it('does not subscribe an effect to the array it pushes into', () => {
    const list = store({ items: [] as number[] })
    let runs = 0
    const stop = root((dispose) => {
      renderEffect(() => {
        runs++
        list.items.push(runs)
      })

      return dispose
    })

    flush()
    expect(runs).toBe(1)
    stop()
  })

  it('skips a write of the value a key already holds', () => {
    const game = store({ coins: 1, miner: { x: 1 } })
    const coins = watching(() => game.coins)
    const miner = watching(() => game.miner)

    game.coins = 1
    const same = game.miner

    game.miner = same
    flush()
    expect(coins.seen).toEqual([1])
    expect(miner.seen).toHaveLength(1)
    coins.stop()
    miner.stop()
  })

  it('notifies a reader of a key that is deleted, and of the keys it lists', () => {
    const game = store<{ flags: Record<string, boolean> }>({ flags: { a: true, b: true } })
    const a = watching(() => game.flags.a)
    const keys = watching(() => Object.keys(game.flags).join())
    const has = watching(() => 'b' in game.flags)

    delete game.flags.a
    flush()
    expect(a.seen).toEqual([true, undefined])
    expect(keys.seen).toEqual(['a,b', 'b'])
    expect(has.seen).toEqual([true])

    delete game.flags.zzz
    flush()
    expect(keys.seen).toHaveLength(2)
    a.stop()
    keys.stop()
    has.stop()
  })

  it('tracks a key read before it exists', () => {
    const game = store<{ later?: { n: number }, other?: number }>({})
    const later = watching(() => game.later?.n)

    game.other = 1
    flush()
    expect(later.seen).toEqual([undefined])

    game.later = { n: 4 }
    flush()
    expect(later.seen).toEqual([undefined, 4])

    game.later.n = 5
    flush()
    expect(later.seen).toEqual([undefined, 4, 5])
    later.stop()
  })

  it('runs a reader once for the writes of a batch', () => {
    const game = store({ coins: 0, gems: 0 })
    const both = watching(() => game.coins + game.gems)

    batch(() => {
      game.coins = 1
      game.coins = 2
      game.gems = 3
    })
    expect(both.seen).toEqual([0, 5])

    game.coins = 6
    game.gems = 6
    flush()
    expect(both.seen).toEqual([0, 5, 12])
    both.stop()
  })

  it('snapshots a plain deep copy, no proxy and no link left', () => {
    const game = store({ coins: 1, miners: [{ id: 1, tags: ['a'] }], when: new Date(0) })
    const copy = snapshot(game)

    expect(copy).toEqual({ coins: 1, miners: [{ id: 1, tags: ['a'] }], when: new Date(0) })
    expect(copy).not.toBe(game)
    expect(copy.miners).not.toBe(game.miners)
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype)
    expect(Array.isArray(copy.miners)).toBe(true)
    expect(structuredClone(copy)).toEqual(copy)

    game.miners[0]!.tags.push('b')
    expect(copy.miners[0]!.tags).toEqual(['a'])
    expect(JSON.stringify(game)).toBe(JSON.stringify(snapshot(game)))
  })

  it('snapshots without subscribing, and keeps a cycle', () => {
    const node: { self?: unknown, n: number } = { n: 1 }

    node.self = node

    const game = store(node)
    const seen = watching(() => snapshot(game).n)

    game.n = 2
    flush()
    expect(seen.seen).toEqual([1])

    const copy = snapshot(game)

    expect(copy.self).toBe(copy)
    seen.stop()
  })

  it('stores the raw object when a store is assigned into another', () => {
    const a = store({ inner: { n: 1 } })
    const b = store<{ held?: { n: number } }>({})

    b.held = a.inner
    expect(snapshot(b)).toEqual({ held: { n: 1 } })
    expect(b.held).toBe(a.inner)
  })

  it('leaves Map, Set, Date, class instances and functions untracked and as written', () => {
    class Box {
      n = 1
    }

    const map = new Map([[1, 2]])
    const fn = () => 3
    const box = new Box()
    const game = store({ map, set: new Set([1]), when: new Date(0), box, fn })

    expect(game.map).toBe(map)
    expect(game.box).toBe(box)
    expect(game.fn).toBe(fn)
    expect(game.when.getTime()).toBe(0)
    expect(game.set.has(1)).toBe(true)
  })

  it('hands a store to a child, whose reads track it too', () => {
    const game = store({ pops: [{ hp: 3 }], title: 't' })
    const child = (props: { game: typeof game }) => watching(() => props.game.pops[0]!.hp)
    const reader = child({ game })

    game.title = 'u'
    flush()
    expect(reader.seen).toEqual([3])

    game.pops[0]!.hp = 2
    flush()
    expect(reader.seen).toEqual([3, 2])
    reader.stop()
  })

  it('reads as plain values with nothing listening, as a server render does', () => {
    const game = store({ coins: 2, miners: [{ id: 1 }] })

    expect(game.coins).toBe(2)
    expect(game.miners.map(miner => miner.id)).toEqual([1])
    expect(JSON.stringify(game)).toBe('{"coins":2,"miners":[{"id":1}]}')
    expect(Object.entries(game).map(([key]) => key)).toEqual(['coins', 'miners'])
  })

  it('lets a 20 Hz loop re-run only the readers of the properties it changed', () => {
    const game = store({ coins: 0, tick: 0, miners: Array.from({ length: 50 }, (_, id) => ({ id, ore: 0 })), log: [] as string[] })
    const runs = { coins: 0, tick: 0, first: 0, last: 0, log: 0 }
    const stop = root((dispose) => {
      renderEffect(() => void (game.coins, runs.coins++))
      renderEffect(() => void (game.tick, runs.tick++))
      renderEffect(() => void (game.miners[0]!.ore, runs.first++))
      renderEffect(() => void (game.miners[49]!.ore, runs.last++))
      renderEffect(() => void (game.log.length, runs.log++))

      return dispose
    })

    for (let tick = 1; tick <= 100; tick++) {
      batch(() => {
        game.tick = tick
        game.miners[0]!.ore += 1

        if (tick % 10 === 0)
          game.coins += 10

        if (tick === 50)
          game.log.push('half')
      })
    }

    expect(runs).toEqual({ coins: 11, tick: 101, first: 101, last: 1, log: 2 })
    stop()
  })

  it('works alongside signals in one effect', () => {
    const game = store({ n: 1 })
    const factor = signal(2)
    const product = watching(() => game.n * factor())

    game.n = 3
    factor.set(4)
    flush()
    expect(product.seen).toEqual([2, 12])
    product.stop()
  })
})

describe('store edge cases', () => {
  it('reads frozen data back as it is, nested stores included', () => {
    const frozen = store({ inner: Object.freeze({ deep: { a: 1 } }), list: Object.freeze([{ a: 1 }]) })

    expect(frozen.inner.deep.a).toBe(1)
    expect(frozen.list[0]!.a).toBe(1)

    const inner = store({ n: 1 })
    const outer = store({ inner })

    expect(outer.inner).toBe(inner)
  })

  it('snapshots an own __proto__ key as data, never as a prototype', () => {
    const copy = snapshot(store(JSON.parse('{"__proto__":{"admin":true},"a":1}') as Record<string, unknown>))

    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype)
    expect((copy as { admin?: boolean }).admin).toBeUndefined()
    expect(Object.keys(copy).sort()).toEqual(['__proto__', 'a'])
  })

  it('notifies readers of the indices sort, reverse, shift and pop move', () => {
    const list = store({ items: [3, 1, 2] })
    const first = watching(() => list.items[0])
    const last = watching(() => list.items[2])

    list.items.sort()
    flush()
    expect(first.seen).toEqual([3, 1])
    list.items.reverse()
    flush()
    expect(first.seen).toEqual([3, 1, 3])
    list.items.pop()
    flush()
    expect(last.seen.at(-1)).toBeUndefined()
    list.items.shift()
    flush()
    expect(first.seen.at(-1)).toBe(2)
    first.stop()
    last.stop()
  })

  it('shrinks a huge array without walking every index', () => {
    const list = store({ items: [] as number[] })

    list.items.length = 4_000_000_000
    list.items.length = 0
    expect(list.items).toHaveLength(0)
  })

  it('runs a setter on the store, so what it writes notifies', () => {
    const box = store({ _v: 1, set v(next: number) {
      this._v = next
    }, get v() {
      return this._v
    } })
    const seen = watching(() => box._v)

    box.v = 5
    flush()
    expect(seen.seen).toEqual([1, 5])
    seen.stop()
  })
})
