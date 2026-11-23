// O(1) row selection primitive: zero WeakSet overhead per row.

import type { Owner, Signal } from './index'
import { effect, getOwner, onCleanup, signal } from './index'

export interface Selector<K> {
  is(key: K): boolean
}

interface Entry {
  s: Signal<boolean>
  o: Owner | undefined
  r: number
}

export function selector<K>(source: () => K): Selector<K> {
  const subs = new Map<K, Entry>()
  let current: K | undefined

  effect(() => {
    const next = source()
    if (Object.is(current, next))
      return

    const prevEntry = subs.get(current as K)
    if (prevEntry !== undefined)
      prevEntry.s.value = false

    current = next
    const nextEntry = subs.get(next)
    if (nextEntry !== undefined)
      nextEntry.s.value = true
  })

  return {
    is(key: K): boolean {
      let entry = subs.get(key)
      if (entry === undefined) {
        entry = { s: signal(Object.is(current, key)), o: undefined, r: 0 }
        subs.set(key, entry)
      }

      const owner = getOwner()
      if (owner !== undefined && entry.o !== owner) {
        entry.o = owner
        entry.r++
        const target = entry
        onCleanup(() => {
          if (--target.r === 0)
            subs.delete(key)
        })
      }

      return entry.s.value
    },
  }
}
