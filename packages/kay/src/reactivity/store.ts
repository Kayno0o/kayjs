// Deep reactive proxy store (tree-shakable: 0 B if unused).

import type { Signal } from './index'
import { batch, signal, untrack } from './index'

const RAW = Symbol('kay.store.raw')
const OWN_KEYS = Symbol('kay.store.keys')

// An array method that moves several entries writes each one in turn; batched, its readers see only the finished array.
const batchedMutators = new Map<PropertyKey, (this: unknown[], ...args: unknown[]) => unknown>(
  (['copyWithin', 'fill', 'pop', 'push', 'reverse', 'shift', 'sort', 'splice', 'unshift'] as const).map((name) => {
    const method = Array.prototype[name] as (...args: unknown[]) => unknown
    return [name, function (this: unknown[], ...args: unknown[]) {
      return batch(() => method.apply(this, args))
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

function wrap<T extends object>(target: T): T {
  const existing = proxyCache.get(target)
  if (existing !== undefined)
    return existing as T

  const proxy = new Proxy(target, {
    get(obj, key, receiver) {
      if (key === RAW)
        return obj
      if (Array.isArray(obj) && batchedMutators.has(key))
        return batchedMutators.get(key)
      getDep(obj, key).value
      // A reader of an array's length is walking it (a list loop reads entries untracked), so any entry write reaches it.
      if (key === 'length' && Array.isArray(obj))
        getDep(obj, OWN_KEYS).value
      const value = Reflect.get(obj, key, receiver)
      return isPlain(value) ? wrap(value) : value
    },
    set(obj, key, value, receiver) {
      const rawValue = typeof value === 'object' && value !== null && RAW in value
        ? (value as Record<symbol, unknown>)[RAW]
        : value
      const had = Object.prototype.hasOwnProperty.call(obj, key)
      const prev = Reflect.get(obj, key, receiver)
      const prevLength = Array.isArray(obj) ? obj.length : 0
      const ok = Reflect.set(obj, key, rawValue, receiver)
      if (!had || !Object.is(prev, rawValue)) {
        notifyKey(obj, key)
        if (!had || Array.isArray(obj))
          notifyKey(obj, OWN_KEYS)
      }
      // Writing past the end grows the array without a later `length` write that differs, so readers of length are told here.
      if (Array.isArray(obj) && key !== 'length' && obj.length !== prevLength)
        notifyKey(obj, 'length')
      return ok
    },
    deleteProperty(obj, key) {
      const had = Object.prototype.hasOwnProperty.call(obj, key)
      const ok = Reflect.deleteProperty(obj, key)
      if (had && ok) {
        notifyKey(obj, key)
        notifyKey(obj, OWN_KEYS)
      }
      return ok
    },
    has(obj, key) {
      if (key === RAW)
        return true
      getDep(obj, key).value
      return Reflect.has(obj, key)
    },
    ownKeys(obj) {
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
  return untrack(() => cloneRaw(value))
}

function cloneRaw<T>(value: T): T {
  if (typeof value !== 'object' || value === null)
    return value
  const raw = RAW in value ? (value as Record<symbol, unknown>)[RAW] : value
  if (Array.isArray(raw))
    return raw.map(item => cloneRaw(item)) as unknown as T
  if (isPlain(raw)) {
    const copy: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(raw))
      copy[k] = cloneRaw(v)
    return copy as T
  }
  return raw as T
}
