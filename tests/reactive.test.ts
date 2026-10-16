import type { Action, Failure, NoInputAction } from '../src/runtime'
import { describe, expect, it, jest, spyOn } from 'bun:test'
import { stringify } from 'devalue'
import { batch, debounced, effect, every, flush, linked, listen, memo, onCleanup, onMount, root, selection, signal, untrack, watch } from '../src/runtime'
import { ActionError, ActionRedirect, actionStub } from '../src/runtime/action'
import { navigation } from '../src/runtime/navigation'
import { createSignal, hydrationEnded, hydrationStarted, ownSignal, recordSignals, renderEffect, renderOnServer, undoable, unrecorded, whenHydrated } from '../src/runtime/reactive'
import { inServerScope } from '../src/server/scope'

describe('signals', () => {
  it('read the last value written, a function written being an updater', () => {
    const count = signal(1)

    count.set(2)
    expect(count()).toBe(2)
    count.set(c => c * 10)
    expect(count()).toBe(20)
  })

  it('are tracked once by a memo reading them more than once, whatever their number', () => {
    const all = Array.from({ length: 500 }, (_, index) => signal(index))
    let runs = 0
    const total = memo(() => {
      runs++

      return all.reduce((sum, one) => sum + one() + one(), 0)
    })

    expect(total()).toBe(2 * (499 * 500 / 2))
    all[3]!.set(10)
    expect(total()).toBe(2 * (499 * 500 / 2) + 14)
    expect(runs).toBe(2)
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

describe('server scopes', () => {
  it('keep what each request writes to a shared signal to that request, two of them overlapping across awaits', async () => {
    const shared = createSignal('module')
    const report = () => undefined
    const request = async (value: string, before: number, after: number) => inServerScope(new Request('http://localhost/'), report, async () => {
      await Bun.sleep(before)
      shared[1](value)
      await Bun.sleep(after)

      return shared[0]()
    })

    expect(await Promise.all([request('first', 0, 30), request('second', 10, 5)])).toEqual(['first', 'second'])
    expect(shared[0]()).toBe('module')
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

describe('whenHydrated', () => {
  it('runs every function deferred until the islands hydrated, one throwing included', () => {
    const error = spyOn(console, 'error').mockImplementation(() => undefined)
    const ran: number[] = []

    try {
      hydrationStarted()
      whenHydrated(() => ran.push(1))
      whenHydrated(() => {
        throw new Error('broken')
      })
      whenHydrated(() => ran.push(3))
      hydrationEnded()

      expect(ran).toEqual([1, 3])
      expect(error).toHaveBeenCalledTimes(1)
    }
    finally {
      error.mockRestore()
    }
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

describe('selection in a server scope', () => {
  it('answers the key a request sets through its value and untracked is(key), and the initial key outside the request', () => {
    const selected = selection<number>(1)

    const inside = inServerScope(new Request('http://localhost/'), () => undefined, () => {
      selected.set(2)

      return [selected(), selected.is(2), selected.is(1)]
    })

    expect(inside).toEqual([2, true, false])
    expect(selected()).toBe(1)
    expect(selected.is(1)).toBe(true)
    expect(selected.is(2)).toBe(false)
  })
})

describe('selection in an optimistic change', () => {
  it('reads its old key again through its value and is(key) once the change is undone, a flag made meanwhile included', () => {
    const selected = selection<number>(1)
    const seen: boolean[][] = []
    const dispose = root((dispose) => {
      effect(() => {
        seen.push([selected.is(1), selected.is(2)])
      })

      return dispose
    })

    flush()

    let stop: (() => void) | undefined
    const meanwhile: boolean[] = []
    const undo = undoable(() => {
      selected.set(2)
      // A reader made while the change shows, so its flag is made then.
      stop = root((stop) => {
        effect(() => {
          meanwhile.push(selected.is(3))
        })
        effect(() => {
          meanwhile.push(selected.is(2))
        })

        return stop
      })
    })

    flush()
    expect(selected()).toBe(2)
    expect(selected.is(1)).toBe(false)
    expect(selected.is(2)).toBe(true)

    undo()
    flush()
    expect(selected()).toBe(1)
    expect(selected.is(1)).toBe(true)
    expect(selected.is(2)).toBe(false)
    expect(seen.at(-1)).toEqual([true, false])
    expect(meanwhile).toEqual([false, true, false])
    stop!()

    // The function form reads the key it was undone to.
    selected.set(current => (current ?? 0) + 10)
    expect(selected()).toBe(11)
    dispose()
  })

  it('undoes a first key and a cleared selection, for a reader made before the change', () => {
    const selected = selection<number>()
    const undo = undoable(() => selected.set(4))
    const reads: boolean[] = []
    const stop = root((stop) => {
      effect(() => {
        reads.push(selected.is(4))
      })

      return stop
    })

    flush()
    expect(reads).toEqual([true])
    undo()
    flush()
    expect(reads).toEqual([true, false])
    expect(selected()).toBeUndefined()

    const cleared = selection<number>(7)
    const undoClear = undoable(() => cleared.set(undefined))

    expect(cleared.is(7)).toBe(false)
    undoClear()
    expect(cleared()).toBe(7)
    expect(cleared.is(7)).toBe(true)
    stop()
  })

  it('undoes at once a selection set in a change that throws, and leaves one set since', () => {
    const selected = selection<string>('a')

    expect(() => undoable(() => {
      selected.set('b')

      throw new Error('no such tier')
    })).toThrow('no such tier')
    expect(selected()).toBe('a')
    expect(selected.is('a')).toBe(true)
    expect(selected.is('b')).toBe(false)

    const undo = undoable(() => selected.set('b'))

    selected.set('c')
    undo()
    expect(selected()).toBe('c')
    expect(selected.is('c')).toBe(true)
    expect(selected.is('b')).toBe(false)
    expect(selected.is('a')).toBe(false)
  })
})

describe('recordSignals', () => {
  it('gives an edited version the values of the signals its script made, in order, until one changes kind', () => {
    const first = recordSignals(() => {
      createSignal(1)[1](5)
      unrecorded(() => createSignal('row')[1]('changed row'))
      createSignal('text')[1]('typed')
      ownSignal(false)[1](true)
    })

    expect(first.values()).toEqual([5, 'typed'])

    const again = recordSignals(() => [createSignal(0)[0](), createSignal('')[0](), ownSignal(false)[0]()], first.values())

    expect(again.result).toEqual([5, 'typed', false])

    const reshaped = recordSignals(() => [createSignal(0)[0](), createSignal(0)[0](), createSignal('')[0]()], first.values())

    expect(reshaped.result).toEqual([5, 0, ''])
  })

  it('records again what the outer one records once an inner one throws', () => {
    const outer = recordSignals(() => {
      createSignal(1)

      try {
        recordSignals(() => {
          createSignal(2)

          throw new Error('the script broke')
        })
      }
      catch {}

      createSignal(3)
    })

    expect(outer.values()).toEqual([1, 3])
  })

  it('leaves out what unrecorded blocks make, nested or not, while one recording inside them records its own', () => {
    let inner: { values: () => unknown[] } | undefined
    const outer = recordSignals(() => {
      createSignal(1)
      unrecorded(() => {
        unrecorded(() => createSignal('nested'))
        createSignal('row')
        inner = recordSignals(() => createSignal('own'))
        createSignal('after')
      })
      createSignal(2)
    })

    expect(outer.values()).toEqual([1, 2])
    expect(inner!.values()).toEqual(['own'])
    expect(createSignal('outside')[0]()).toBe('outside')
  })

  it('records the signals an optimistic change makes, and keeps recording once it is undone', () => {
    const recorded = recordSignals(() => {
      const [, write] = createSignal(1)
      const undo = undoable(() => {
        write(2)
        createSignal('made in the change')
      })

      undo()
      createSignal(3)
    })

    expect(recorded.values()).toEqual([1, 'made in the change', 3])
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
  it('leave kay\'s own signals as they are, undoing what the change writes after one', () => {
    const [own, setOwn] = ownSignal(0)
    const a = signal(0)

    expect(() => undoable(() => {
      setOwn(1)
      a.set(1)

      throw new Error('no such tier')
    })).toThrow('no such tier')
    expect([own(), a()]).toEqual([1, 0])

    const undo = undoable(() => {
      setOwn(2)
      a.set(2)
    })

    undo()
    expect([own(), a()]).toEqual([2, 0])
  })

  it('undo a change made inside another with the outer one, and keep the outer one\'s undo once an inner change throws', () => {
    const count = signal(1)
    const label = signal('a')
    const done = signal(false)
    const undo = undoable(() => {
      count.set(2)

      try {
        undoable(() => {
          label.set('b')

          throw new Error('no such tier')
        })
      }
      catch {}

      expect(label()).toBe('a')
      label.set('c')
      undoable(() => done.set(true))
    })

    undo()
    expect([count(), label(), done()]).toEqual([1, 'a', false])
  })

  it('undo what a change made inside another wrote, three deep, whichever is undone first', () => {
    const a = signal(0)
    let middle: (() => void) | undefined
    let inner: (() => void) | undefined
    const outer = undoable(() => {
      a.set(1)
      middle = undoable(() => {
        a.set(2)
        inner = undoable(() => a.set(3))
      })
    })

    inner!()
    expect(a()).toBe(2)
    middle!()
    expect(a()).toBe(1)
    outer()
    expect(a()).toBe(0)

    const again = undoable(() => {
      a.set(1)
      middle = undoable(() => a.set(2))
    })

    middle!()
    again()
    expect(a()).toBe(0)
  })

  it('leave a signal the outer change wrote alone once something wrote it since, though an inner undo matched it by chance', () => {
    const a = signal(0)
    let inner: (() => void) | undefined
    const outer = undoable(() => {
      a.set(1)
      inner = undoable(() => a.set(2))
      a.set(3)
    })

    a.set(2)
    inner!()
    expect(a()).toBe(1)
    outer()
    expect(a()).toBe(1)
  })

  it('undo what a change made inside another wrote when the outer one throws after it', () => {
    const a = signal(0)
    const b = signal(0)

    expect(() => undoable(() => {
      a.set(1)
      undoable(() => b.set(1))

      throw new Error('no such tier')
    })).toThrow('no such tier')
    expect([a(), b()]).toEqual([0, 0])
  })

  it('undo an optimistic call made inside another\'s optimistic function, both failing, the inner one first', async () => {
    const outer = actionStub('/_kay/action/test/outer') as unknown as Action<object, null>
    const inner = actionStub('/_kay/action/test/inner') as unknown as Action<object, null>
    const a = signal(0)
    // Each call's request fails when the test says, the inner one first.
    const failing = new Map<string, () => void>()
    const fetched = spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => new Promise((_, reject) => {
      failing.set(String(input), () => reject(new TypeError('offline')))
    })) as unknown as typeof fetch)
    let nested: Promise<null> | undefined

    try {
      const call = outer({}, {
        optimistic: () => {
          a.set(1)
          nested = inner({}, { optimistic: () => a.set(2) })
        },
      })
      const settled = Promise.allSettled([nested!, call])

      expect(a()).toBe(2)
      await Bun.sleep(0)
      failing.get('/_kay/action/test/inner')!()
      await Bun.sleep(0)
      expect(a()).toBe(1)
      failing.get('/_kay/action/test/outer')!()
      expect((await settled).map(result => result.status)).toEqual(['rejected', 'rejected'])
      expect(a()).toBe(0)
    }
    finally {
      fetched.mockRestore()
    }
  })

  it('keeps an action called inside another\'s optimistic function pending until its own call settles, the outer one failing first', async () => {
    const outer = actionStub('/_kay/action/test/outer') as unknown as Action<object, null>
    const inner = actionStub('/_kay/action/test/inner') as unknown as Action<object, null>
    const a = signal(0)
    const failing = new Map<string, () => void>()
    const fetched = spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => new Promise((_, reject) => {
      failing.set(String(input), () => reject(new TypeError('offline')))
    })) as unknown as typeof fetch)
    let nested: Promise<null> | undefined

    try {
      const call = outer({}, {
        optimistic: () => {
          a.set(1)
          nested = inner({}, { optimistic: () => a.set(2) })
        },
      })
      const settled = Promise.allSettled([call, nested!])

      expect([inner.pending(), outer.pending()]).toEqual([true, true])
      await Bun.sleep(0)
      failing.get('/_kay/action/test/outer')!()
      await Bun.sleep(0)
      expect([a(), inner.pending(), outer.pending()]).toEqual([0, true, false])
      failing.get('/_kay/action/test/inner')!()
      expect((await settled).map(result => result.status)).toEqual(['rejected', 'rejected'])
      expect([a(), inner.pending()]).toEqual([0, false])
    }
    finally {
      fetched.mockRestore()
    }
  })

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

  it('roll back when the call is aborted, which rejects with the signal\'s reason and records no outcome', async () => {
    const move = actionStub('/_kay/action/test/aborted') as unknown as Action<{ to: number }, number>
    const at = signal(0)
    const controller = new AbortController()
    const fetched = spyOn(globalThis, 'fetch').mockImplementation((async (_: unknown, init?: RequestInit) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as unknown as typeof fetch)

    try {
      const moving = move({ to: 1 }, { optimistic: () => at.set(1), signal: controller.signal })

      expect(at()).toBe(1)
      controller.abort(new Error('the user left'))
      await expect(moving).rejects.toThrow('the user left')
      expect(at()).toBe(0)
      expect(move.pending()).toBe(false)
      expect(move.failed()).toBeUndefined()
    }
    finally {
      fetched.mockRestore()
    }
  })

  it('refresh the page when a call is aborted once sent, as the server may have run it, unless the call says refresh: false', async () => {
    const move = actionStub('/_kay/action/test/sent') as unknown as Action<{ to: number }, number>
    const refreshed = jest.fn(async () => undefined)
    const fetched = spyOn(globalThis, 'fetch').mockImplementation((async (_: unknown, init?: RequestInit) => {
      init?.signal?.throwIfAborted()

      return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))
    }) as unknown as typeof fetch)
    const aborted = async (options: { refresh?: false }) => {
      const controller = new AbortController()
      const moving = move({ to: 1 }, { ...options, signal: controller.signal })

      controller.abort(new Error('the user left'))
      await expect(moving).rejects.toThrow('the user left')
    }

    // As `startNavigation` registers it.
    navigation.refresh = refreshed

    try {
      await aborted({})
      expect(refreshed).toHaveBeenCalledTimes(1)
      await aborted({ refresh: false })
      expect(refreshed).toHaveBeenCalledTimes(1)
      await expect(move({ to: 1 }, { signal: AbortSignal.abort(new Error('never sent')) })).rejects.toThrow('never sent')
      expect(refreshed).toHaveBeenCalledTimes(1)
    }
    finally {
      delete navigation.refresh
      fetched.mockRestore()
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

describe('a tracked action call', () => {
  const fail = (status: number, body: unknown) => new Response(stringify(body), { status, headers: { 'x-kay-failure': '1' } })
  const saved = actionStub('/_kay/action/test/saved') as unknown as Action<{ id: number }, Failure<{ reason: string }> | string>
  const answering = (answer: (request: number) => Response | Promise<Response>) => {
    let count = 0

    return spyOn(globalThis, 'fetch').mockImplementation((async () => answer(count++)) as unknown as typeof fetch)
  }

  it('reads pending for its own calls alone, while the action reads every call the page made', async () => {
    const releases: ((response: Response) => void)[] = []
    const fetched = answering(async () => new Promise<Response>(resolve => releases.push(resolve)))

    try {
      const [one, two] = [saved.track(), saved.track()]
      const calling = one({ id: 1 })

      expect([one.pending(), two.pending(), saved.pending()]).toEqual([true, false, true])

      const other = two({ id: 2 })

      expect([one.pending(), two.pending()]).toEqual([true, true])
      releases[0]!(new Response(stringify('a')))
      expect(await calling).toEqual({ ok: true, data: 'a' })
      expect([one.pending(), two.pending(), saved.pending()]).toEqual([false, true, true])
      releases[1]!(new Response(stringify('b')))
      await other
      expect([two.pending(), saved.pending()]).toEqual([false, false])
    }
    finally {
      fetched.mockRestore()
    }
  })

  it('answers a refusal as a result, with its status, field errors and the data ctx.fail passed, and does not throw', async () => {
    const fetched = answering(request => request === 0 ? fail(409, { errors: { id: 'Taken' }, data: { reason: 'locked' } }) : fail(422, { errors: { id: 'Bad id' } }))

    try {
      const call = saved.track()

      const refused = await call({ id: 1 })

      // The refusal's data is typed as the handler passes it to ctx.fail.
      expect(refused.ok ? undefined : refused.data?.reason).toBe('locked')
      expect(refused).toEqual({ ok: false, status: 409, errors: { id: 'Taken' }, data: { reason: 'locked' } })
      expect(await call({ id: 2 })).toEqual({ ok: false, status: 422, errors: { id: 'Bad id' }, data: undefined })
      expect(call.pending()).toBe(false)
      // The action's own reading of its last call stays as it was.
      expect(saved.error('id')).toBe('Bad id')
    }
    finally {
      fetched.mockRestore()
    }
  })

  it('throws what is no refusal of this action, clearing pending: a network failure, an abort, a redirect', async () => {
    const aborted = new AbortController()
    const fetched = answering(async (request) => {
      if (request === 0)
        throw new TypeError('offline')

      if (request === 2)
        throw aborted.signal.reason

      if (request === 3)
        return new Response(null, { status: 303, headers: { 'x-kay-redirect': '/away' } })

      return fail(500, { errors: { '': 'Something went wrong' } })
    })

    try {
      const call = saved.track()
      const other = actionStub('/_kay/action/test/other') as unknown as Action<{ id: number }, string>

      await expect(call({ id: 1 })).rejects.toThrow('offline')
      expect(call.pending()).toBe(false)
      // A 500 is a refusal the server answered, so it comes back as one.
      expect(await call({ id: 1 })).toMatchObject({ ok: false, status: 500 })
      aborted.abort(new Error('left'))
      await expect(call({ id: 1 }, { signal: aborted.signal })).rejects.toThrow('left')
      expect(call.pending()).toBe(false)
      await expect(call({ id: 1 })).rejects.toBeInstanceOf(ActionRedirect)
      expect(call.pending()).toBe(false)
      // A handle follows its own action's refusals only.
      expect(other.track().pending()).toBe(false)
    }
    finally {
      fetched.mockRestore()
    }
  })

  it('is called with no argument for an action with no input', async () => {
    const ping = actionStub('/_kay/action/test/ping') as unknown as NoInputAction<string>
    const fetched = answering(() => new Response(stringify('pong')))

    try {
      expect(await ping.track()()).toEqual({ ok: true, data: 'pong' })
      // The type check is what asserts it: an action with fields still needs them.
      // @ts-expect-error -- an input is required
      const missing = async () => saved.track()()

      expect(missing).toBeFunction()
    }
    finally {
      fetched.mockRestore()
    }
  })

  it('passes the call options on, and a form\'s fields', async () => {
    const fetched = answering(() => new Response(stringify('ok')))

    try {
      const call = saved.track()
      const form = new FormData()

      form.set('id', '3')
      expect(await call(form)).toEqual({ ok: true, data: 'ok' })
      expect(new Headers(fetched.mock.calls[0]![1]!.headers).get('x-kay-action')).toBe('form')
      expect(await call({ id: 3 }, { refresh: false })).toEqual({ ok: true, data: 'ok' })
    }
    finally {
      fetched.mockRestore()
    }
  })
})

describe('every', () => {
  it('runs every interval until its root goes, starting and stopping as its condition turns', async () => {
    // Once a test before waited on a real timer, fake timers no longer settle a tick's await before the next tick: each step lets it.
    const advance = async (ms: number) => {
      for (let step = 0; step < ms; step += 50) {
        jest.advanceTimersByTime(50)
        await Promise.resolve()
      }
    }

    jest.useFakeTimers()

    try {
      const active = signal(false)
      let runs = 0
      const dispose = root((dispose) => {
        every(100, () => runs++, { while: active })

        return dispose
      })

      flush()
      await advance(250)
      expect(runs).toBe(0)

      active.set(true)
      flush()
      await advance(250)
      expect(runs).toBe(2)

      active.set(false)
      flush()
      await advance(250)
      expect(runs).toBe(2)

      active.set(true)
      flush()
      dispose()
      await advance(250)
      expect(runs).toBe(2)
    }
    finally {
      jest.useRealTimers()
    }
  })

  it('runs at once as its timer starts with `immediate`, each time its condition turns true', async () => {
    jest.useFakeTimers()

    try {
      const active = signal(true)
      let runs = 0
      const dispose = root((dispose) => {
        every(100, () => runs++, { while: active, immediate: true })

        return dispose
      })

      flush()
      expect(runs).toBe(1)

      await Promise.resolve()
      jest.advanceTimersByTime(100)
      await Promise.resolve()
      expect(runs).toBe(2)

      active.set(false)
      flush()
      active.set(true)
      flush()
      expect(runs).toBe(3)
      dispose()
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

describe('watch', () => {
  it('runs on each change, not the first read, handed the value before, until its root goes', () => {
    const turn = signal(1)
    const seen: [number, number][] = []
    const dispose = root((dispose) => {
      watch(turn, (next, previous) => {
        seen.push([next, previous])
      })

      return dispose
    })

    flush()
    expect(seen).toEqual([])

    turn.set(2)
    flush()
    turn.set(3)
    flush()
    expect(seen).toEqual([[2, 1], [3, 2]])

    dispose()
    turn.set(4)
    flush()
    expect(seen).toEqual([[2, 1], [3, 2]])
  })

  it('runs on the first read too with `immediate`, handed no value before', () => {
    const turn = signal(1)
    const seen: [number, number | undefined][] = []
    const dispose = root((dispose) => {
      watch(turn, (next, previous) => {
        seen.push([next, previous])
      }, { immediate: true })

      return dispose
    })

    flush()
    turn.set(2)
    flush()
    expect(seen).toEqual([[1, undefined], [2, 1]])
    dispose()
  })

  it('tracks only its source, runs nothing for an equal value, and keeps what the last run registered until the next', () => {
    const board = signal({ id: 1, name: 'a' })
    const other = signal(0)
    const runs: number[] = []
    const cleaned: number[] = []
    const dispose = root((dispose) => {
      watch(() => board().id, (id) => {
        runs.push(id + other())
        onCleanup(() => cleaned.push(id))
      })

      return dispose
    })

    flush()
    board.set({ id: 2, name: 'a' })
    flush()
    board.set({ id: 2, name: 'b' })
    other.set(10)
    flush()
    expect([runs, cleaned]).toEqual([[2], []])

    board.set({ id: 3, name: 'b' })
    flush()
    expect([runs, cleaned]).toEqual([[2, 13], [2]])

    dispose()
    expect(cleaned).toEqual([2, 3])
  })

  it('takes a write the script makes before its first read as part of it', () => {
    const turn = signal(1)
    const seen: [number, number][] = []
    const dispose = root((dispose) => {
      watch(turn, (next, previous) => {
        seen.push([next, previous])
      })
      turn.set(2)

      return dispose
    })

    flush()
    turn.set(3)
    flush()
    expect(seen).toEqual([[3, 2]])
    dispose()
  })

  it('keeps watching after a run throws, reporting it, and takes `immediate` from a boolean', () => {
    const turn = signal(1)
    const seen: number[] = []
    const reported = spyOn(console, 'error').mockImplementation(() => undefined)
    const immediate = turn() > 1
    const dispose = root((dispose) => {
      watch(turn, (next: number, previous: number | undefined) => {
        seen.push(next)

        if (previous === 1)
          throw new Error('failed')
      }, { immediate })

      return dispose
    })

    try {
      flush()
      turn.set(2)
      flush()
      turn.set(3)
      flush()
      expect([seen, reported.mock.calls.length]).toEqual([[2, 3], 1])
    }
    finally {
      reported.mockRestore()
      dispose()
    }
  })

  it('runs nothing while the server renders', () => {
    const turn = signal(1)
    let runs = 0

    renderOnServer(() => watch(turn, () => runs++, { immediate: true }))
    turn.set(2)
    flush()
    expect(runs).toBe(0)
  })
})

describe('debounced', () => {
  it('takes the value of its source once it stops changing for the delay, starting with its value now', () => {
    jest.useFakeTimers()

    try {
      const typed = signal('a')
      const { settled, dispose } = root(dispose => ({ settled: debounced(typed, 300), dispose }))

      expect(settled()).toBe('a')

      typed.set('ad')
      flush()
      jest.advanceTimersByTime(200)
      typed.set('ada')
      flush()
      jest.advanceTimersByTime(200)
      expect(settled()).toBe('a')

      jest.advanceTimersByTime(100)
      expect(settled()).toBe('ada')
      dispose()
    }
    finally {
      jest.useRealTimers()
    }
  })

  it('drops a pending value when its source comes back to the settled one, and its timer with its root', () => {
    jest.useFakeTimers()

    try {
      const typed = signal('a')
      const { settled, dispose } = root(dispose => ({ settled: debounced(typed, 300), dispose }))
      const seen: string[] = []

      root(() => watch(settled, next => seen.push(next)))
      flush()

      typed.set('b')
      flush()
      typed.set('a')
      flush()
      jest.advanceTimersByTime(400)
      flush()
      expect([settled(), seen, jest.getTimerCount()]).toEqual(['a', [], 0])

      typed.set('c')
      flush()
      dispose()
      expect(jest.getTimerCount()).toBe(0)
    }
    finally {
      jest.useRealTimers()
    }
  })

  it('starts no timer while the server renders', () => {
    jest.useFakeTimers()

    try {
      const typed = signal('a')
      const settled = renderOnServer(() => debounced(typed, 300))

      typed.set('b')
      flush()
      expect([settled(), jest.getTimerCount()]).toEqual(['a', 0])
    }
    finally {
      jest.useRealTimers()
    }
  })
})

describe('listen', () => {
  it('listens while its root lives, to the target its function returns as that changes, with the options given', () => {
    const first = new EventTarget()
    const second = new EventTarget()
    const target = signal<EventTarget | undefined>(first)
    const heard: string[] = []
    const dispose = root((dispose) => {
      listen(target, 'ping', event => heard.push(event.type))
      listen(first, 'once', event => heard.push(event.type), { once: true })

      return dispose
    })

    flush()
    first.dispatchEvent(new Event('ping'))
    first.dispatchEvent(new Event('once'))
    first.dispatchEvent(new Event('once'))
    target.set(second)
    flush()
    first.dispatchEvent(new Event('ping'))
    second.dispatchEvent(new Event('ping'))
    target.set(undefined)
    flush()
    second.dispatchEvent(new Event('ping'))
    target.set(first)
    flush()
    dispose()
    first.dispatchEvent(new Event('ping'))
    expect(heard).toEqual(['ping', 'once', 'ping'])
  })

  it('reads no target while the server renders', () => {
    let reads = 0

    renderOnServer(() => listen(() => {
      reads++

      return new EventTarget()
    }, 'ping', () => undefined))
    flush()
    expect(reads).toBe(0)
  })
})
