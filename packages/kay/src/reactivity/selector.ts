// O(1) row selection primitive: zero WeakSet overhead per row.

import type { Owner, Signal } from './index'
import { effect, getOwner, isTracking, onCleanup, signal } from './index'

export interface Selector<K> {
  is(key: K): boolean
}

interface Entry {
  s: Signal<boolean>
  owners: Set<Owner>
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
      const owner = getOwner()
      if (owner === undefined && !isTracking())
        return Object.is(current, key)

      let entry = subs.get(key)
      if (entry === undefined) {
        entry = { s: signal(Object.is(current, key)), owners: new Set() }
        subs.set(key, entry)
      }

      if (owner !== undefined && !entry.owners.has(owner)) {
        entry.owners.add(owner)
        const target = entry
        onCleanup(() => {
          target.owners.delete(owner)
          if (target.owners.size === 0)
            subs.delete(key)
        })
      }

      return entry.s.value
    },
  }
}
