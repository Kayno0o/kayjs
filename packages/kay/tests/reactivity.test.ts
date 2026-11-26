import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { batch, computed, effect, onCleanup, onMount, root, selector, signal, snapshot, store } from '../src/index'
import { createOwner, disposeOwner, renderOnServer, runWithOwner } from '../src/reactivity/index'
import { _storeDepsSize } from '../src/reactivity/store'
import { testApp } from '../src/test/index'

// A source's subscriber list, read to see whether a computed still holds on to it.
const subscribed = (source: object): boolean => (source as { s?: unknown }).s !== undefined

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

  test('a computed read outside any effect leaves its source and stays memoized', () => {
    const s = signal(1)
    let runs = 0
    const double = computed(() => {
      runs++
      return s.value * 2
    })
    expect(double.value).toBe(2)
    expect(subscribed(s)).toBe(false)
    expect(double.value).toBe(2)
    s.value = 2
    expect(double.value).toBe(4)
    expect(runs).toBe(2)
    const quad = computed(() => computed(() => s.value * 2).value * 2)
    expect(quad.value).toBe(8)
    expect(subscribed(s)).toBe(false)
    expect((s as unknown as { ls?: unknown }).ls).toBeUndefined()
  })

  test('peek() or a throwing first run inside an observed effect leaves sources unsubscribed', () => {
    const s = signal(1)
    const peeked = computed(() => s.value * 2)
    const stopPeek = effect(() => {
      expect(peeked.peek()).toBe(2)
    })
    expect(subscribed(s)).toBe(false)
    stopPeek()
    expect(subscribed(s)).toBe(false)

    const inner = computed(() => s.value + 1)
    const failing = computed(() => {
      void inner.value
      throw new Error('boom')
    })
    const stopThrow = effect(() => {
      try {
        void failing.value
      }
      catch {}
    })
    expect([subscribed(s), subscribed(inner)]).toEqual([false, false])
    stopThrow()
    expect([subscribed(s), subscribed(inner)]).toEqual([false, false])
  })

  test('an unobserved computed clears subscriber neighbor pointers when detached', () => {
    const s = signal(1)
    const stop1 = effect(() => { void s.value })
    const c = computed(() => s.value * 2)
    const stopC = effect(() => { void c.value })
    const stop2 = effect(() => { void s.value })
    stopC()
    const link = (c as unknown as { d?: { ps?: unknown, ns?: unknown } }).d!
    expect([link.ps, link.ns]).toEqual([undefined, undefined])
    stop1()
    stop2()
  })

  test('a computed whose last effect is disposed releases its sources and follows them again when observed', () => {
    const s = signal(1)
    const double = computed(() => s.value * 2)
    const outer = computed(() => double.value + 1)
    const seen: number[] = []
    const stop = effect(() => {
      seen.push(outer.value)
    })
    expect(subscribed(s)).toBe(true)
    stop()
    expect([subscribed(s), subscribed(double)]).toEqual([false, false])
    s.value = 2
    const again = effect(() => {
      seen.push(outer.value)
    })
    s.value = 3
    expect(seen).toEqual([3, 5, 7])
    again()
  })

  test.each([
    ['drops it on a re-run', (c: { value: number }, use: ReturnType<typeof signal<boolean>>, _: () => void) => { use.value = false; void c.value }],
    ['is disposed', (_c: { value: number }, _use: ReturnType<typeof signal<boolean>>, dispose: () => void) => dispose()],
  ])('an effect keeps following a source an unobserved computed %s', (_, release) => {
    const s = signal(1)
    const use = signal(true)
    const seen: number[] = []
    let c!: { value: number }
    const dispose = root((d) => {
      c = computed(() => use.value ? s.value : 0)
      return d
    })
    expect(c.value).toBe(1)
    const stop = effect(() => {
      seen.push(s.value)
    })
    release(c, use, dispose)
    s.value = 2
    expect(seen).toEqual([1, 2])
    stop()
  })

  test.each([
    ['directly', (fn: () => void) => fn()],
    ['through a component owner', (fn: () => void) => runWithOwner(createOwner(), fn)],
  ])('a parent effect runs before a child created in it %s, even when the child subscribed first', (_, within) => {
    const open = signal(true)
    const user = signal<{ name: string } | null>({ name: 'Ada' })
    const seen: string[] = []
    const dispose = root((d) => {
      effect(() => {
        if (open.value) {
          within(() => effect(() => {
            seen.push(user.value!.name)
          }))
        }
      })
      return d
    })
    batch(() => {
      user.value = null
      open.value = false
    })
    expect(seen).toEqual(['Ada'])
    dispose()
  })

  test('a parent effect whose cleanup throws runs once when queued after its child', () => {
    const open = signal(true)
    const user = signal(1)
    let parentRuns = 0
    const dispose = root((d) => {
      effect(() => {
        parentRuns++
        if (open.value) {
          effect(() => { void user.value })
        }
        return () => {
          if (parentRuns === 1)
            throw new Error('cleanup boom')
        }
      })
      return d
    })
    expect(() => batch(() => {
      user.value = 2
      open.value = false
    })).toThrow('cleanup boom')
    expect(parentRuns).toBe(1)
    dispose()
  })

  test('a self-retriggering parent queued after its child runs its second pass in the next round', () => {
    const a = signal(0)
    const b = signal(0)
    const log: string[] = []
    const dispose = root((d) => {
      effect(() => {
        const av = a.value
        log.push(`parent:${av}`)
        if (av === 0) {
          effect(() => {
            log.push(`child:${b.value}`)
          })
        }
        if (av === 1)
          a.value = 2
      })
      effect(() => {
        log.push(`sibling:${a.value}:${b.value}`)
      })
      return d
    })
    log.length = 0
    batch(() => {
      b.value = 1
      a.value = 1
    })
    expect(log).toEqual(['parent:1', 'sibling:2:1', 'parent:2'])
    dispose()
  })

  test('an effect created while a computed runs and an onCleanup with no owner warn in dev', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const c = computed(() => {
        effect(() => {})
        return 1
      })
      expect(c.value).toBe(1)
      onCleanup(() => {})
      effect(() => {})()
      root(() => {
        effect(() => {})
        onCleanup(() => {})
      })
      expect(warn.mock.calls.map(call => call[0])).toEqual([
        'kay: effect() created while a computed runs has no owner and is never disposed. Create it in a component or an effect.',
        'kay: onCleanup() called outside a component or effect never runs.',
      ])
    }
    finally {
      warn.mockRestore()
    }
  })

  test('an error thrown in batch survives an effect failing in its flush', () => {
    const s = signal(0)
    const error = spyOn(console, 'error').mockImplementation(() => {})
    const stop = effect(() => {
      if (s.value === 1)
        throw new Error('effect')
    })
    try {
      expect(() => batch(() => {
        s.value = 1
        throw new Error('handler')
      })).toThrow('handler')
      expect(error.mock.calls.map(call => (call[0] as Error).message)).toEqual(['effect'])
    }
    finally {
      error.mockRestore()
      stop()
    }
  })

  test('a reactive cycle keeps the errors its flush collected', () => {
    const a = signal(0)
    let thrown = false
    const dispose = root((d) => {
      effect(() => {
        if (a.value > 0 && !thrown) {
          thrown = true
          throw new Error('boom')
        }
      })
      effect(() => {
        if (a.value > 0)
          a.value = a.value + 1
      })
      return d
    })
    let caught: unknown
    try {
      a.value = 1
    }
    catch (err) {
      caught = err
    }
    expect((caught as AggregateError).errors.map(e => (e as Error).message)).toEqual(['boom', 'kay: reactive cycle'])
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

  test.each([
    ['splice', (l: number[]) => l.splice(0, 1), '2,3,4'],
    ['unshift', (l: number[]) => l.unshift(0), '0,1,2,3,4'],
    ['shift', (l: number[]) => l.shift(), '2,3,4'],
    ['reverse', (l: number[]) => l.reverse(), '4,3,2,1'],
    ['sort', (l: number[]) => l.sort((a, b) => b - a), '4,3,2,1'],
    ['fill', (l: number[]) => l.fill(0, 1), '1,0,0,0'],
    ['copyWithin', (l: number[]) => l.copyWithin(0, 2), '3,4,3,4'],
  ])('a store array %s reaches its readers once, never half-done', (_, mutate, after) => {
    const list = store([1, 2, 3, 4])
    const seen: string[] = []
    const stop = effect(() => {
      seen.push(list.join(','))
    })
    mutate(list)
    expect(seen).toEqual(['1,2,3,4', after])
    stop()
  })

  test('a store assigned into another store comes back as the same proxy', () => {
    const inner = store({ n: 1 })
    const outer = store({ child: { n: 0 } })
    outer.child = inner
    expect(outer.child).toBe(inner)
    expect(Object.getPrototypeOf(snapshot(outer).child)).toBe(Object.prototype)
  })
})

describe('owned list disposal', () => {
  test('a cleanup disposing its sibling still lets every other sibling dispose, newest first', () => {
    const log: string[] = []
    const dispose = root((d) => {
      effect(() => onCleanup(() => log.push('E1')))
      const other = createOwner()
      runWithOwner(other, () => onCleanup(() => log.push('other')))
      effect(() => onCleanup(() => {
        log.push('E2')
        disposeOwner(other)
      }))
      effect(() => onCleanup(() => log.push('E3')))
      return d
    })
    dispose()
    expect(log).toEqual(['E3', 'E2', 'other', 'E1'])
  })

  test('an effect created under a disposed owner never runs, and its cleanups run at once', () => {
    const owner = createOwner(undefined)
    disposeOwner(owner)
    let runs = 0
    let cleaned = 0
    runWithOwner(owner, () => {
      effect(() => {
        runs++
      })
      onCleanup(() => cleaned++)
    })
    expect(runs).toBe(0)
    expect(cleaned).toBe(1)
  })
})

describe('effect on the server (#3614)', () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const d of dirs)
      rmSync(d, { recursive: true, force: true })
  })

  test('an island\'s effect neither runs nor leaves a timer behind during SSR', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-ssr-effect-'))
    dirs.push(dir)
    const files: Record<string, string> = {
      'src/components/Poller.tsx': `
        import { effect, signal } from '@kayjs/kay'
        export function Poller() {
          const ticks = signal(0)
          effect(() => {
            const seen = globalThis as { kayEffectRuns?: number }
            seen.kayEffectRuns = (seen.kayEffectRuns ?? 0) + 1
            const id = setInterval(() => { ticks.value++ }, 10)
            return () => clearInterval(id)
          })
          return <button onClick={() => { ticks.value++ }}>Ticks {ticks.value}</button>
        }
      `,
      'src/routes/index.tsx': 'import { Poller } from \'../components/Poller\'\nexport default function Home() { return <main><Poller /></main> }\n',
    }
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(join(dir, file, '..'), { recursive: true })
      writeFileSync(join(dir, file), text)
    }
    const app = await testApp({ root: dir })
    try {
      const html = await (await app.get('/')).text()
      expect(html).toContain('<kay-island')
      expect(html).toContain('Ticks <!---->0')
      expect((globalThis as { kayEffectRuns?: number }).kayEffectRuns).toBeUndefined()
    }
    finally {
      await app.app.dispose?.()
    }
  })
})

describe('reactivity regressions (#3628)', () => {
  test('1. ComputedNode stays dirty after throwing and recovers when upstream changes', () => {
    const s = signal(0)
    let runs = 0
    const unobs = computed(() => {
      runs++
      if (s.value === 0)
        throw new Error('zero')
      return s.value * 10
    })

    // First read throws; subsequent reads (.value and .peek()) must rethrow instead of returning undefined
    expect(() => unobs.value).toThrow('zero')
    expect(() => unobs.value).toThrow('zero')
    expect(() => unobs.peek()).toThrow('zero')
    expect(runs).toBe(3)

    // Recovers once upstream signal changes
    s.value = 2
    expect(unobs.value).toBe(20)
    expect(runs).toBe(4)

    // Observed chain s -> c1 -> c2 -> effect: succeeds, throws, rethrows on direct read, then recovers automatically
    const src = signal(1)
    const c1 = computed(() => {
      if (src.value === 0)
        throw new Error('bad src')
      return src.value * 2
    })
    const c2 = computed(() => c1.value + 1)
    const seen: number[] = []
    const stop = effect(() => {
      seen.push(c2.value)
    })

    expect(seen).toEqual([3])
    expect(() => { src.value = 0 }).toThrow('bad src')
    // Must not silently return stale value 2 or 3
    expect(() => c1.value).toThrow('bad src')
    expect(() => c1.peek()).toThrow('bad src')
    expect(() => c2.value).toThrow('bad src')

    // Fixing src must re-propagate through the previously dirty/check computed chain and update the effect
    src.value = 5
    expect(seen).toEqual([3, 11])
    stop()
  })

  test('2. self-disposing effect or computed never leaks into subscriber lists', () => {
    const a = signal(1)
    const b = signal(2)
    const c = signal(3)
    const derived = computed(() => c.value * 2)

    // Initial run self-disposing via root owner
    root((dispose) => {
      effect(() => {
        void a.value
        dispose()
        // Reading signals & fresh computeds after self-disposal must not re-attach
        void b.value
        void derived.value
      })
    })
    expect([subscribed(a), subscribed(b), subscribed(c), subscribed(derived)]).toEqual([false, false, false, false])

    // Re-run self-disposing via effect's own stop() handle
    let stop!: () => void
    stop = effect(() => {
      if (a.value > 1) {
        stop()
        void b.value
        void derived.value
      }
    })
    a.value = 2
    expect([subscribed(a), subscribed(b), subscribed(c), subscribed(derived)]).toEqual([false, false, false, false])

    // A computed whose own body disposes its owner must not leak subsequent signal reads
    let comp!: ReturnType<typeof computed<number>>
    root((dispose) => {
      comp = computed(() => {
        const v = a.value
        dispose()
        return v + b.value
      })
      void comp.value
    })
    expect([subscribed(a), subscribed(b)]).toEqual([false, false])

    // A computed (not itself disposed) whose body disposes the observing outer effect must unobserve itself
    const d = signal(10)
    let disposeOuter!: () => void
    const killer = computed(() => {
      const v = d.value
      disposeOuter()
      return v
    })
    root((dispose) => {
      disposeOuter = dispose
      effect(() => {
        void killer.value
      })
    })
    expect([subscribed(d), subscribed(killer)]).toEqual([false, false])
  })

  test('3. releaseOwned runs every remaining child disposal and cleanup when one throws', () => {
    const s1 = signal(0)
    const s2 = signal(0)
    const log: string[] = []
    let e1Runs = 0

    const dispose = root((d) => {
      onCleanup(() => log.push('root-c1'))
      onCleanup(() => {
        log.push('root-c2-throws')
        throw new Error('root boom')
      })
      onCleanup(() => log.push('root-c3'))
      effect(() => {
        void s1.value
        e1Runs++
        return () => log.push('child-e1')
      })
      effect(() => {
        void s2.value
        return () => {
          log.push('child-e2-throws')
          throw new Error('child boom')
        }
      })
      return d
    })

    let caught: unknown
    try {
      dispose()
    }
    catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors.map(e => (e as Error).message)).toEqual(['child boom', 'root boom'])
    // Every child and root cleanup ran despite both throws, and both child effects are unsubscribed
    expect(log).toEqual(['child-e2-throws', 'child-e1', 'root-c3', 'root-c2-throws', 'root-c1'])
    expect([subscribed(s1), subscribed(s2)]).toEqual([false, false])
    s1.value = 1
    expect(e1Runs).toBe(1)

    // Single throwing cleanup rethrows that exact error (not wrapped in AggregateError)
    const singleLog: string[] = []
    const disposeSingle = root((d) => {
      onCleanup(() => singleLog.push('first'))
      onCleanup(() => {
        singleLog.push('second-throws')
        throw new Error('only one')
      })
      return d
    })
    expect(() => disposeSingle()).toThrow('only one')
    expect(singleLog).toEqual(['second-throws', 'first'])
  })

  test('4. nested computeds and effects do not clobber dep.le into duplicate links', () => {
    const countSubLinks = (dep: object): number => {
      let n = 0
      for (let l = (dep as { s?: { ns?: unknown } }).s; l; l = (l as { ns?: { ns?: unknown } }).ns)
        n++
      return n
    }
    const countDepLinks = (sub: object): number => {
      let n = 0
      for (let l = (sub as { d?: { nd?: unknown } }).d; l; l = (l as { nd?: { nd?: unknown } }).nd)
        n++
      return n
    }

    const a = signal(1)
    const inner = computed(() => a.value * 2)
    let outerRuns = 0
    const stop = effect(() => {
      outerRuns++
      void a.value
      void inner.value
      void a.value
    })
    // a.s must have exactly 2 links (outer + inner), NOT 3
    expect(countSubLinks(a)).toBe(2)
    a.value = 2
    expect(outerRuns).toBe(2)
    expect(countSubLinks(a)).toBe(2)
    stop()
    expect(countSubLinks(a)).toBe(0)

    // Nested effect inside outer effect reading `a` before and after
    const disposeNested = root((d) => {
      effect(() => {
        void a.value
        effect(() => {
          void a.value
        })
        void a.value
      })
      return d
    })
    expect(countSubLinks(a)).toBe(2)
    a.value = 3
    expect(countSubLinks(a)).toBe(2)
    disposeNested()
    expect(countSubLinks(a)).toBe(0)

    // Unobserved computed reading `a`, nested computed reading `a`, and `a` again
    const outerComp = computed(() => a.value + inner.value + a.value)
    expect(outerComp.value).toBe(12)
    expect(countDepLinks(outerComp)).toBe(2)
  })

  test('5. onMount skips during renderOnServer even when document exists', async () => {
    const prevDoc = (globalThis as { document?: unknown }).document
    const hadDoc = Object.prototype.hasOwnProperty.call(globalThis, 'document')
    if (prevDoc === undefined)
      (globalThis as { document?: unknown }).document = {}
    let ssrRan = false
    let clientRan = false
    try {
      renderOnServer(() => {
        onMount(() => {
          ssrRan = true
        })
      })
      onMount(() => {
        clientRan = true
      })
      await Promise.resolve()
      expect(ssrRan).toBe(false)
      expect(clientRan).toBe(true)
    }
    finally {
      if (!hadDoc)
        delete (globalThis as { document?: unknown }).document
      else
        (globalThis as { document?: unknown }).document = prevDoc
    }
  })

  test('6. selector works in SSR, updates computed() after co-effect disposes, and avoids leaks', () => {
    // SSR: current must reflect source() even though effect() is skipped
    renderOnServer(() => {
      const selected = signal(3)
      const sel = selector(() => selected.value)
      expect(sel.is(3)).toBe(true)
      expect(sel.is(1)).toBe(false)
      const c = computed(() => sel.is(3))
      expect(c.value).toBe(true)
    })

    // Co-subscribing effect + observed computed: disposing effect must NOT sever computed updates
    const selected = signal(1)
    const sel = selector(() => selected.value)
    const isOne = computed(() => sel.is(1))
    const seen: boolean[] = []

    const stopEffect = effect(() => {
      void sel.is(1)
    })
    const stopComputedEffect = effect(() => {
      seen.push(isOne.value)
    })
    expect(seen).toEqual([true])

    stopEffect()
    selected.value = 2
    expect(seen).toEqual([true, false])
    selected.value = 1
    expect(seen).toEqual([true, false, true])

    // Disposing the last subscriber detaches the entry; reading isOne later still sees fresh updates
    stopComputedEffect()
    selected.value = 2
    expect(isOne.value).toBe(false)
    selected.value = 1
    expect(isOne.value).toBe(true)

    // Unobserved computed reading selector updates and does not leak key references
    const keySel = selector(() => selected.value as unknown)
    const refs: WeakRef<object>[] = []
    for (let i = 0; i < 50; i++) {
      const key = { id: i }
      refs.push(new WeakRef(key))
      const c = computed(() => keySel.is(key))
      expect(c.value).toBe(false)
    }
    Bun.gc(true)
    expect(refs.some(r => r.deref() === undefined)).toBe(true)
  })

  test('7. store batches writes/deletes, notifies truncated array elements, evicts deleted deps, and handles circular snapshots', () => {
    // 7a. Batched single flush for add, array growth, and delete
    const obj = store<Record<string, number>>({ a: 1 })
    let objRuns = 0
    const stopObj = effect(() => {
      void obj.b
      void Object.keys(obj)
      objRuns++
    })
    expect(objRuns).toBe(1)
    obj.b = 2
    expect(objRuns).toBe(2) // single flush, not 2
    delete obj.b
    expect(objRuns).toBe(3) // single flush, not 2
    stopObj()

    const list = store<string[]>(['a', 'b'])
    let growRuns = 0
    const stopGrow = effect(() => {
      void list[4]
      void list.length
      void Object.keys(list)
      growRuns++
    })
    expect(growRuns).toBe(1)
    list[4] = 'e'
    expect(growRuns).toBe(2) // single flush, not 3
    stopGrow()

    // 7b. Array truncation via .length = n notifies element readers in a single flush
    const items = store(['x', 'y', 'z'])
    const seenElem: (string | undefined)[] = []
    const stopTrunc = effect(() => {
      seenElem.push(items[2])
    })
    expect(seenElem).toEqual(['z'])
    items.length = 1
    expect(seenElem).toEqual(['z', undefined])
    stopTrunc()

    // 7c. Deleted keys and truncated array indices are evicted from depsCache
    const cache = store<Record<string, number>>({})
    for (let i = 0; i < 100; i++) {
      const k = `k${i}`
      cache[k] = i
      const stop = effect(() => { void cache[k] })
      stop()
      delete cache[k]
    }
    expect(_storeDepsSize(cache)).toBe(0)

    const truncArr = store([1, 2, 3, 4])
    const s2 = effect(() => { void truncArr[2] })
    const s3 = effect(() => { void truncArr[3] })
    s2()
    s3()
    expect(_storeDepsSize(truncArr)).toBe(2)
    truncArr.length = 1
    expect(_storeDepsSize(truncArr)).toBe(0)

    // Still-watching effect re-subscribes cleanly after delete + re-add
    const watched = store<{ x?: string }>({ x: 'init' })
    const watchedLog: (string | undefined)[] = []
    const stopWatched = effect(() => {
      watchedLog.push(watched.x)
    })
    delete watched.x
    watched.x = 'back'
    expect(watchedLog).toEqual(['init', undefined, 'back'])
    stopWatched()

    // 7d. Circular objects and arrays in snapshot() do not overflow the stack
    interface Node { name: string, self?: Node, peer?: Node }
    const a: Node = { name: 'a' }
    const b: Node = { name: 'b', peer: a }
    a.self = a
    a.peer = b
    const sNode = store(a)
    const snapNode = snapshot(sNode)
    expect(snapNode.name).toBe('a')
    expect(snapNode.self).toBe(snapNode)
    expect(snapNode.peer!.name).toBe('b')
    expect(snapNode.peer!.peer).toBe(snapNode)
    expect(snapNode).not.toBe(a)
    expect(snapNode).not.toBe(sNode)

    const cycArr: unknown[] = [1]
    cycArr.push(cycArr)
    const sArr = store(cycArr)
    const snapArr = snapshot(sArr)
    expect(snapArr[0]).toBe(1)
    expect(snapArr[1]).toBe(snapArr)
    expect(snapArr).not.toBe(cycArr)
  })
})
