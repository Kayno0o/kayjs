import type { Action } from '../src/runtime'
import { describe, expect, it, jest, spyOn } from 'bun:test'
import { stringify } from 'devalue'
import { batch, effect, every, flush, linked, memo, onCleanup, onMount, root, selection, signal, untrack } from '../src/runtime'
import { ActionError, actionStub } from '../src/runtime/action'
import { createSignal, recordSignals, renderEffect, renderOnServer, undoable, unrecorded } from '../src/runtime/reactive'

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

describe('linked', () => {
  it('takes the source\'s value, keeps an edit until the source changes, then follows it again', () => {
    const board = signal({ title: 'First' })
    const title = linked(() => board().title)
    const seen: string[] = []

    root(() => effect(() => void seen.push(title())))
    flush()
    title.set('Edited')
    flush()
    expect(title()).toBe('Edited')
    title.set(current => `${current}!`)
    expect(title()).toBe('Edited!')
    board.set({ title: 'Second' })
    flush()
    expect(title()).toBe('Second')
    expect(seen).toEqual(['First', 'Edited', 'Second'])
  })

  it('drops an edit once the source changed, even when it comes back to the value the edit was made over', () => {
    const page = signal('/')
    const note = linked(() => page())

    note.set('edited')
    page.set('/second')
    expect(note()).toBe('/second')
    page.set('/')
    expect(note()).toBe('/')
  })
})

describe('optimistic changes', () => {
  it('undo what they wrote, but not what was written since', () => {
    const count = signal(1)
    const label = signal('a')
    const undo = undoable(() => {
      count.set(2)
      count.set(3)
      label.set('b')
    })

    label.set('c')
    undo()
    expect(count()).toBe(1)
    expect(label()).toBe('c')
  })

  it('undo what they wrote before throwing, the call never posting nor staying pending', async () => {
    const move = actionStub('/_kay/action/test/throws') as unknown as Action<{ to: number }, number>
    const at = signal(0)
    const fetched = spyOn(globalThis, 'fetch')

    try {
      await expect(move({ to: 1 }, {
        optimistic: () => {
          at.set(1)

          throw new Error('no such tier')
        },
      })).rejects.toThrow('no such tier')
      expect(at()).toBe(0)
      expect(move.pending()).toBe(false)
      expect(fetched).not.toHaveBeenCalled()
    }
    finally {
      fetched.mockRestore()
    }
  })

  it('name the page they are called from, which the action reads its params off', async () => {
    const rename = actionStub('/_kay/action/test/rename') as unknown as Action<object, null>
    const fetched = spyOn(globalThis, 'fetch').mockImplementation((async () => new Response(null)) as unknown as typeof fetch)
    const had = Object.getOwnPropertyDescriptor(globalThis, 'location')

    try {
      Object.defineProperty(globalThis, 'location', { value: { pathname: '/orgs/acme', search: '?tab=1' }, configurable: true })
      await rename({})
      expect(new Headers(fetched.mock.calls[0]![1]!.headers).get('x-kay-page')).toBe('/orgs/acme?tab=1')
    }
    finally {
      fetched.mockRestore()

      if (had)
        Object.defineProperty(globalThis, 'location', had)
      else
        Reflect.deleteProperty(globalThis, 'location')
    }
  })

  it('roll back when the action call fails, and stand once it went through', async () => {
    const move = actionStub('/_kay/action/test/move') as unknown as Action<{ to: number }, number>
    const at = signal(0)
    const answers = [new Response(stringify({ errors: { '': 'Locked' } }), { status: 409, headers: { 'x-kay-failure': '1' } }), new Response(stringify(2))]
    const fetched = spyOn(globalThis, 'fetch').mockImplementation((async () => answers.shift()!) as unknown as typeof fetch)

    try {
      await expect(move({ to: 1 }, { optimistic: () => at.set(1) })).rejects.toBeInstanceOf(ActionError)
      expect(at()).toBe(0)
      expect(await move({ to: 2 }, { optimistic: () => at.set(2) })).toBe(2)
      expect(at()).toBe(2)
    }
    finally {
      fetched.mockRestore()
    }
  })
})

describe('every', () => {
  it('runs every interval until its root goes, starting and stopping as its condition turns', () => {
    jest.useFakeTimers()

    try {
      const active = signal(false)
      let runs = 0
      const dispose = root((dispose) => {
        every(100, () => runs++, { while: active })

        return dispose
      })

      flush()
      jest.advanceTimersByTime(250)
      expect(runs).toBe(0)

      active.set(true)
      flush()
      jest.advanceTimersByTime(250)
      expect(runs).toBe(2)

      active.set(false)
      flush()
      jest.advanceTimersByTime(250)
      expect(runs).toBe(2)

      active.set(true)
      flush()
      dispose()
      jest.advanceTimersByTime(250)
      expect(runs).toBe(2)
    }
    finally {
      jest.useRealTimers()
    }
  })

  it('starts no timer while the server renders', () => {
    jest.useFakeTimers()

    try {
      let runs = 0

      renderOnServer(() => every(100, () => runs++))
      flush()
      jest.advanceTimersByTime(250)
      expect([runs, jest.getTimerCount()]).toEqual([0, 0])
    }
    finally {
      jest.useRealTimers()
    }
  })

  it('skips a tick while the last run is pending, and reads no signal of the run as a dependency', async () => {
    jest.useFakeTimers()

    try {
      const count = signal(0)
      let finish: (() => void) | undefined
      let started = 0
      const dispose = root((dispose) => {
        every(100, async () => {
          started++
          count.set(count() + 1)
          await new Promise<void>((resolve) => {
            finish = resolve
          })
        })

        return dispose
      })

      flush()
      jest.advanceTimersByTime(350)
      expect(started).toBe(1)

      finish?.()
      await Promise.resolve()
      await Promise.resolve()
      jest.advanceTimersByTime(100)
      flush()
      expect([started, count()]).toEqual([2, 2])
      dispose()
    }
    finally {
      jest.useRealTimers()
    }
  })
})
