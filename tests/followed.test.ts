import { describe, expect, it } from 'bun:test'
import { accessorParameters } from '../src/compiler/items'
import { effect, flush, root, signal } from '../src/runtime'
import { followed, param, slotCall } from '../src/runtime/reactive'

interface Item { id: number, name: string }

describe('followed', () => {
  it('draws an object once and hands the block\'s parameter the current item, the one it was called with until then', () => {
    const list = signal<Item[]>([{ id: 1, name: 'a' }])
    const seen: unknown[] = []
    let draws = 0

    root(() => {
      effect(() => {
        followed(() => list()[0]!, (item) => {
          draws++
          seen.push(item, param(item)())
        })
      })
    })

    flush()

    const first = list()[0]!

    expect(param(first)()).toBe(first)

    const copy = { id: 1, name: 'b' }

    list.set([copy])
    flush()
    expect(draws).toBe(1)
    expect(seen).toEqual([first, first])
  })

  it('reads the replacement where the block asks for it after the draw', () => {
    const list = signal<Item[]>([{ id: 1, name: 'a' }])
    let read: (() => Item) | undefined

    root(() => followed(() => list()[0]!, (item) => {
      read = param(item)
    }))

    const copy = { id: 1, name: 'b' }

    list.set([copy])
    expect(read!()).toBe(copy)
  })

  it('reads an item that left the list as it was last seen', () => {
    const list = signal<Item[]>([{ id: 1, name: 'a' }])
    const first = list()[0]!
    let read: (() => Item) | undefined

    root(() => followed(() => list()[0], (item) => {
      read = param<Item | undefined>(item) as () => Item
    }))

    list.set([])
    expect(read!()).toBe(first)
  })

  it('keeps nested follows apart and restores the outer one', () => {
    const outer = signal<Item>({ id: 1, name: 'a' })
    const inner = signal<Item>({ id: 2, name: 'b' })
    const reads: (() => Item)[] = []

    root(() => followed(outer, (a) => {
      followed(inner, (b) => {
        reads.push(param(b))
      })
      reads.push(param(a))
    }))

    const next = { id: 2, name: 'c' }

    inner.set(next)
    expect(reads[0]!()).toBe(next)
    expect(reads[1]!().id).toBe(1)
    expect(param(outer())().id).toBe(1)
  })

  it('draws a value that is no object again when it changes, as a call does', () => {
    const count = signal(1)
    const seen: number[] = []

    root(() => effect(() => {
      followed(count, (value) => {
        seen.push(value)
      })
    }))
    flush()
    count.set(2)
    flush()
    expect(seen).toEqual([1, 2])
  })

  it('does nothing for a slot without a block, and hands a block the item and the other arguments', () => {
    const item = signal<Item>({ id: 1, name: 'a' })
    const calls: unknown[][] = []

    expect(slotCall(undefined, item)).toBeUndefined()
    root(() => slotCall((...args: unknown[]) => calls.push(args), item, () => 5))
    expect(calls).toEqual([[item(), 5]])
  })
})

const names = (params: string) => accessorParameters(params)?.map(({ name }) => name)

describe('a slot called with more than the item', () => {
  it('reads the other arguments in place for a block that takes them through param, by their place', () => {
    const item = signal<Item>({ id: 1, name: 'a' })
    const index = signal(0)
    let draws = 0
    let reads: [() => Item, () => number] | undefined

    root(() => effect(() => {
      slotCall((card: Item, at: number) => {
        draws++
        reads = [param(card), param(at, 1)]
      }, item, index)
    }))
    flush()
    index.set(1)
    item.set({ id: 1, name: 'b' })
    flush()
    expect(draws).toBe(1)
    expect([reads![0]().name, reads![1]()]).toEqual(['b', 1])
  })

  it('finds the item wherever the block takes it', () => {
    const item = signal<Item>({ id: 1, name: 'a' })
    let read: (() => Item) | undefined

    root(() => followed(item, (card) => {
      read = param(card, 1)
    }))
    item.set({ id: 1, name: 'b' })
    expect(read!().name).toBe('b')
  })

  it('draws the block again when an argument it did not take through param changes', () => {
    const item = signal<Item>({ id: 1, name: 'a' })
    const index = signal(0)
    const seen: number[] = []

    root(() => effect(() => {
      slotCall((_card: Item, at: number) => {
        seen.push(at)
      }, item, index)
    }))
    flush()
    index.set(1)
    flush()
    expect(seen).toEqual([0, 1])
  })

  it('leaves a block drawn inside the block with its own arguments, the same value at the same place included', () => {
    const item = signal<Item>({ id: 1, name: 'a' })
    const index = signal(1)
    let inner: (() => number) | undefined

    root(() => slotCall((card: Item, at: number) => {
      param(card)
      param(at, 1)
      inner = param(1, 1)
    }, item, index))
    index.set(2)
    expect(inner!()).toBe(1)
  })
})

describe('accessorParameters', () => {
  it('gives each name its place in the list, a pattern keeping its own', () => {
    expect(accessorParameters('card, i')).toEqual([{ name: 'card', position: 0 }, { name: 'i', position: 1 }])
    expect(accessorParameters('{ id }, rest')).toEqual([{ name: 'rest', position: 1 }])
  })

  it('names the plain parameters, typed or not, and leaves patterns, rests and defaults as written', () => {
    expect(names('row, column')).toEqual(['row', 'column'])
    expect(names('row: Row<Item>, index?: number')).toEqual(['row', 'index'])
    expect(names('{ id }, rest: (a: number, b: number) => void')).toEqual(['rest'])
    expect(names('row, ...others')).toEqual(['row'])
    expect(names('row = 1, other')).toEqual(['other'])
    expect(names('{ id }')).toBeUndefined()
  })

  it('reads a comma or a bracket in a string of a type as no part of the list', () => {
    expect(names('a: \'x, y: z\', b')).toEqual(['a', 'b'])
    expect(names('a: "<(", b')).toEqual(['a', 'b'])
  })
})
