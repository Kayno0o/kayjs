// Deep reactive proxy store (tree-shakable: 0 B if unused).

import type { Signal } from './index'
import { batch, isTracking, signal, untrack } from './index'

const RAW = Symbol('kay.store.raw')
const OWN_KEYS = Symbol('kay.store.keys')

// An array method that moves several entries writes each one in turn; batched, its readers see only the finished array, and untracked, an effect calling it does not subscribe to what it writes.
const batchedMutators = new Map<PropertyKey, (this: unknown[], ...args: unknown[]) => unknown>(
  (['copyWithin', 'fill', 'pop', 'push', 'reverse', 'shift', 'sort', 'splice', 'unshift'] as const).map((name) => {
    const method = Array.prototype[name] as (...args: unknown[]) => unknown
    return [name, function (this: unknown[], ...args: unknown[]) {
      return batch(() => untrack(() => method.apply(this, args)))
    }]
  }),
)

const proxyCache = new WeakMap<object, object>()
const depsCache = new WeakMap<object, Map<PropertyKey, Signal<number>>>()

function isPlain(value: unknown): value is Record<PropertyKey, unknown> {
  if (typeof value !== 'object' || value === null)
    return false
  if (Array.isArray(value))
    return true
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

// The target behind a store proxy, or the value itself.
function unwrap<T>(value: T): T {
  return typeof value === 'object' && value !== null && RAW in value ? (value as Record<symbol, T>)[RAW]! : value
}

function getDep(target: object, key: PropertyKey): Signal<number> {
  let map = depsCache.get(target)
  if (map === undefined) {
    map = new Map()
    depsCache.set(target, map)
  }
  let dep = map.get(key)
  if (dep === undefined) {
    dep = signal(0)
    map.set(key, dep)
  }
  return dep
}

function notifyKey(target: object, key: PropertyKey): void {
  const dep = depsCache.get(target)?.get(key)
  if (dep !== undefined)
    dep.value = dep.peek() + 1
}

function deleteDep(target: object, key: PropertyKey): void {
  const map = depsCache.get(target)
  const dep = map?.get(key)
  if (dep !== undefined) {
    dep.value = dep.peek() + 1
    map!.delete(key)
    if (map!.size === 0)
      depsCache.delete(target)
  }
}

function evictTruncated(target: object, nextLen: number, prevLen: number): void {
  const map = depsCache.get(target)
  if (map === undefined)
    return
  for (const [k, dep] of map) {
    if (typeof k === 'string') {
      const idx = Number(k)
      if ((idx >>> 0) === idx && idx >= nextLen && idx < prevLen && String(idx) === k) {
        dep.value = dep.peek() + 1
        map.delete(k)
      }
    }
  }
  if (map.size === 0)
    depsCache.delete(target)
}

function wrap<T extends object>(target: T): T {
  const existing = proxyCache.get(target)
  if (existing !== undefined)
    return existing as T

  const proxy = new Proxy(target, {
    get(obj, key, receiver) {
      if (key === RAW)
        return obj
      const mutator = Array.isArray(obj) ? batchedMutators.get(key) : undefined
      if (mutator !== undefined)
        return mutator
      if (isTracking()) {
        getDep(obj, key).value
        // A reader of an array's length is walking it (a list loop reads entries untracked), so any entry write reaches it.
        if (key === 'length' && Array.isArray(obj))
          getDep(obj, OWN_KEYS).value
      }
      const value = Reflect.get(obj, key, receiver)
      return isPlain(value) ? wrap(value) : value
    },
    set(obj, key, value, receiver) {
      const rawValue = unwrap(value)
      const had = Object.prototype.hasOwnProperty.call(obj, key)
      const prev = Reflect.get(obj, key, obj)
      const isArr = Array.isArray(obj)
      const prevLength = isArr ? obj.length : 0
      const ok = Reflect.set(obj, key, rawValue, receiver)
      if (!ok)
        return false
      const changed = !had || !Object.is(prev, rawValue)
      const lenChanged = isArr && obj.length !== prevLength
      if (changed || lenChanged) {
        batch(() => {
          if (changed) {
            notifyKey(obj, key)
            if (!had || isArr)
              notifyKey(obj, OWN_KEYS)
          }
          // Writing past the end grows the array without a later `length` write that differs; truncating drops trailing elements.
          if (lenChanged) {
            if (key !== 'length')
              notifyKey(obj, 'length')
            else if (obj.length < prevLength)
              evictTruncated(obj, obj.length, prevLength)
          }
        })
      }
      return true
    },
    deleteProperty(obj, key) {
      const had = Object.prototype.hasOwnProperty.call(obj, key)
      const ok = Reflect.deleteProperty(obj, key)
      if (had && ok) {
        batch(() => {
          deleteDep(obj, key)
          notifyKey(obj, OWN_KEYS)
        })
      }
      return ok
    },
    has(obj, key) {
      if (key === RAW)
        return true
      if (isTracking())
        getDep(obj, key).value
      return Reflect.has(obj, key)
    },
    ownKeys(obj) {
      if (isTracking())
        getDep(obj, OWN_KEYS).value
      return Reflect.ownKeys(obj)
    },
  })

  proxyCache.set(target, proxy)
  return proxy
}

export function store<T extends object>(initial: T): T {
  if (!isPlain(initial))
    return initial
  return wrap(initial)
}

export function snapshot<T>(value: T): T {
  return untrack(() => cloneRaw(value, new Map()))
}

/** @internal Test helper: number of tracked dependency keys currently cached for `target`. */
export function _storeDepsSize(target: object): number {
  return depsCache.get(unwrap(target))?.size ?? 0
}

function cloneRaw<T>(value: T, seen: Map<object, unknown>): T {
  const raw = unwrap(value)
  if (typeof raw !== 'object' || raw === null)
    return raw
  const cached = seen.get(raw)
  if (cached !== undefined)
    return cached as T
  if (Array.isArray(raw)) {
    const copy: unknown[] = []
    copy.length = raw.length
    seen.set(raw, copy)
    for (let i = 0; i < raw.length; i++) {
      if (i in raw)
        copy[i] = cloneRaw(raw[i], seen)
    }
    return copy as unknown as T
  }
  if (isPlain(raw)) {
    const copy: Record<string, unknown> = {}
    seen.set(raw, copy)
    for (const [k, v] of Object.entries(raw)) {
      // Assigning `__proto__` would set the copy's prototype; JSON.parse makes it an own key, so it stays one.
      if (k === '__proto__')
        Object.defineProperty(copy, k, { value: cloneRaw(v, seen), writable: true, enumerable: true, configurable: true })
      else
        copy[k] = cloneRaw(v, seen)
    }
    return copy as T
  }
  return raw as T
}
