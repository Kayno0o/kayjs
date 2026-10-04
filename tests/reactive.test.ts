import { describe, expect, it, spyOn } from 'bun:test'
import { batch, effect, flush, memo, onCleanup, onMount, root, selection, signal, untrack } from '../src/runtime'
import { createSignal, recordSignals, renderEffect, renderOnServer, unrecorded } from '../src/runtime/reactive'

describe('signals', () => {
  it('read the last value written, a function written being an updater', () => {
    const count = signal(1)

    count.set(2)
    expect(count()).toBe(2)
    count.set(c => c * 10)
    expect(count()).toBe(20)
  })

  it('skip a write of the same value, unless equals is false', () => {
    const plain = signal(1)
    const always = signal(1, { equals: false })
    const runs = { plain: 0, always: 0 }

    const dispose = root((dispose) => {
      renderEffect(() => void (plain(), runs.plain++))
      renderEffect(() => void (always(), runs.always++))

      return dispose
    })

    plain.set(1)
    always.set(1)
    flush()
    expect(runs).toEqual({ plain: 1, always: 2 })
    dispose()
  })
})

describe('memos', () => {
  it('compute once per change, however many depend on them, and only when read', () => {
    const count = signal(1)
    let computed = 0
    const double = memo(() => {
      computed++

      return count() * 2
    })
    const left = memo(() => double() + 1)
    const right = memo(() => double() - 1)

    expect(computed).toBe(0)
    expect(left() + right()).toBe(4)
    expect(computed).toBe(1)
    count.set(5)
    expect(left() + right()).toBe(20)
    expect(computed).toBe(2)
  })

  it('stop what read them from running again when their value stays the same', () => {
    const count = signal(1)
    const positive = memo(() => count() > 0)
    let runs = 0

    const dispose = root((dispose) => {
      renderEffect(() => void (positive(), runs++))

      return dispose
    })

    count.set(2)
    flush()
    expect(runs).toBe(1)
    count.set(-1)
    flush()
    expect(runs).toBe(2)
    dispose()
  })
})

describe('effects', () => {
  it('run after the current task, once per batch of writes, and right away through flush', async () => {
    const a = signal(1)
    const b = signal(1)
    const seen: number[] = []

    const dispose = root((dispose) => {
      effect(() => void seen.push(a() + b()))

      return dispose
    })

    expect(seen).toEqual([])
    await Promise.resolve()
    expect(seen).toEqual([2])
    a.set(2)
    b.set(2)
    await Promise.resolve()
    expect(seen).toEqual([2, 4])
    a.set(3)
    flush()
    expect(seen).toEqual([2, 4, 5])
    dispose()
  })

  it('apply a batch before it returns', () => {
    const a = signal(1)
    const seen: number[] = []

    const dispose = root((dispose) => {
      renderEffect(() => void seen.push(a()))

      return dispose
    })

    batch(() => {
      a.set(2)
      a.set(3)
    })
    expect(seen).toEqual([1, 3])
    dispose()
  })

  it('clean up what their last run made before running again, and stop once their root is disposed', () => {
    const count = signal(0)
    const log: string[] = []

    const dispose = root((dispose) => {
      renderEffect(() => {
        const value = count()

        log.push(`run ${value}`)
        renderEffect(() => void log.push(`inner ${value}`))
        onCleanup(() => log.push(`clean ${value}`))
      })

      return dispose
    })

    count.set(1)
    flush()
    dispose()
    count.set(2)
    flush()
    expect(log).toEqual(['run 0', 'inner 0', 'clean 0', 'run 1', 'inner 1', 'clean 1'])
  })

  it('do not depend on what they read untracked', () => {
    const tracked = signal(0)
    const quiet = signal(0)
    let runs = 0

    const dispose = root((dispose) => {
      renderEffect(() => {
        tracked()
        untrack(quiet)
        runs++
      })

      return dispose
    })

    quiet.set(1)
    flush()
    expect(runs).toBe(1)
    tracked.set(1)
    flush()
    expect(runs).toBe(2)
    dispose()
  })

  it('run again on the next change after a run that threw', () => {
    const errors = spyOn(console, 'error').mockImplementation(() => undefined)
    const item = signal<{ n: number } | undefined>(undefined)
    const seen: number[] = []
    const dispose = root((dispose) => {
      effect(() => void seen.push(item()!.n))

      return dispose
    })

    flush()
    item.set({ n: 1 })
    flush()
    errors.mockRestore()
    expect(seen).toEqual([1])
    dispose()
  })

  it('run again when they write what they read, until it settles', () => {
    const count = signal(0)
    const seen: number[] = []
    const dispose = root((dispose) => {
      effect(() => {
        seen.push(count())

        if (count() < 3)
          count.set(count() + 1)
      })

      return dispose
    })

    flush()
    expect(seen).toEqual([0, 1, 2, 3])
    dispose()
  })

  it('never run while an island renders on the server', async () => {
    let mounted = false

    renderOnServer(() => {
      onMount(() => {
        mounted = true
      })
    })
    await Promise.resolve()
    expect(mounted).toBe(false)
  })
})

describe('selection', () => {
  it('re-runs only the rows a change selects or unselects', () => {
    const selected = selection<number>(3)
    const runs = Array.from<number>({ length: 100 }).fill(0)
    const dispose = root((dispose) => {
      for (const row of runs.keys()) {
        effect(() => {
          selected.is(row)
          runs[row] = runs[row]! + 1
        })
      }

      return dispose
    })
    const ranAgain = (before: number[]) => runs.flatMap((count, row) => count === before[row] ? [] : [row])

    flush()
    expect(runs.every(count => count === 1)).toBe(true)

    let before = [...runs]

    selected.set(5)
    flush()
    expect(ranAgain(before)).toEqual([3, 5])

    before = [...runs]
    selected.set(current => (current ?? 0) + 2)
    flush()
    expect(ranAgain(before)).toEqual([5, 7])
    expect(selected()).toBe(7)

    before = [...runs]
    selected.set(7)
    selected.set(undefined)
    flush()
    expect(ranAgain(before)).toEqual([7])
    // Read outside any tracking scope, as in an event handler.
    expect(selected.is(7)).toBe(false)
    dispose()
  })
})

describe('recordSignals', () => {
  it('gives an edited version the values of the signals its script made, in order, until one changes kind', () => {
    const first = recordSignals(() => {
      createSignal(1)[1](5)
      unrecorded(() => createSignal('row')[1]('changed row'))
      createSignal('text')[1]('typed')
      createSignal(false, undefined, false)[1](true)
    })

    expect(first.values()).toEqual([5, 'typed'])

    const again = recordSignals(() => [createSignal(0)[0](), createSignal('')[0](), createSignal(false, undefined, false)[0]()], first.values())

    expect(again.result).toEqual([5, 'typed', false])

    const reshaped = recordSignals(() => [createSignal(0)[0](), createSignal(0)[0](), createSignal('')[0]()], first.values())

    expect(reshaped.result).toEqual([5, 0, ''])
  })
})
