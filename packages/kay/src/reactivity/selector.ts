// O(1) row selection primitive: zero WeakSet overhead per row.

import type { Signal } from './index'
import { effect, isObserving, isTracking, watchedSignal } from './index'

export interface Selector<K> {
  is(key: K): boolean
}

export function selector<K>(source: () => K): Selector<K> {
  const subs = new Map<K, Signal<boolean>>()
  let current: K | undefined
  let active = false

  effect(() => {
    const next = source()
    if (active && Object.is(current, next))
      return

    if (active) {
      const prev = subs.get(current as K)
      if (prev !== undefined)
        prev.value = false
    }

    active = true
    current = next
    const nextSub = subs.get(next)
    if (nextSub !== undefined)
      nextSub.value = true
  })

  return {
    is(key: K): boolean {
      if (!active)
        return Object.is(source(), key)
      if (!isObserving())
        return isTracking() ? Object.is(source(), key) : Object.is(current, key)

      let sub = subs.get(key)
      if (sub === undefined) {
        sub = watchedSignal(Object.is(current, key), () => {
          if (subs.get(key) === sub)
            subs.delete(key)
        })
        subs.set(key, sub)
      }
      return sub.value
    },
  }
}
