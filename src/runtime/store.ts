import { kept, ownDep, tracking, untrack } from './reactive'
import { warnOnce } from './warn-once'

// A dependency on one key or on an object's set of keys: it notifies on every write and holds nothing.
interface Dep {
  observers: () => number
  read: () => void
  write: () => void
}

interface Meta {
  keys: Map<unknown, Dep>
  shape: Dep | undefined
}

const MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin'])
const proxies = new WeakMap<object, object>()
const raws = new WeakMap<object, object>()
const metas = new WeakMap<object, Meta>()
const mutators = new Map<string, (this: unknown[], ...args: unknown[]) => unknown>()

export function plain(value: unknown): value is object {
  if (typeof value !== 'object' || value === null)
    return false

  if (Array.isArray(value))
    return true

  const proto = Object.getPrototypeOf(value)

  return proto === Object.prototype || proto === null
}

export const unwrap = <T>(value: T): T => (typeof value === 'object' && value !== null ? raws.get(value) as T | undefined : undefined) ?? value

// Deps that lost their last observer, checked once the current run ends: a computation re-reading its sources in another order leaves one for a moment and takes it back.
let idle: (() => void)[] = []

function sweep(): void {
  const pending = idle

  idle = []

  for (const drop of pending)
    drop()
}

// `shape` is the object's key set. An unobserved dep leaves `meta` so an id read once and gone does not stay in the map for the life of the store.
function dep(meta: Meta, key: unknown, shape = false): Dep {
  const made: Dep = ownDep(() => {
    idle.push(() => {
      if (made.observers() > 0)
        return

      if (shape) {
        if (meta.shape === made)
          meta.shape = undefined
      }
      else if (meta.keys.get(key) === made) {
        meta.keys.delete(key)
      }
    })

    if (idle.length === 1)
      queueMicrotask(sweep)
  })

  return made
}

// How many deps a store object holds, for tests.
export function trackedCount(value: object): number {
  const meta = metas.get(unwrap(value))

  return meta ? meta.keys.size + (meta.shape ? 1 : 0) : 0
}

function metaOf(target: object): Meta {
  let meta = metas.get(target)

  if (!meta)
    metas.set(target, meta = { keys: new Map(), shape: undefined })

  return meta
}

// Subscribes the running computation to `key`, made only when something is listening so a write with no reader costs nothing.
export function trackKey(target: object, key: unknown): void {
  if (!tracking())
    return

  const meta = metaOf(target)
  let one = meta.keys.get(key)

  if (!one)
    meta.keys.set(key, one = dep(meta, key))

  one.read()
}

export function trackShape(target: object): void {
  if (!tracking())
    return

  const meta = metaOf(target)

  meta.shape ??= dep(meta, undefined, true)
  meta.shape.read()
}

export function touch(target: object, key: unknown): void {
  metas.get(target)?.keys.get(key)?.write()
}

export function touchShape(target: object): void {
  metas.get(target)?.shape?.write()
}

// Pops, splices and the rest read the array they change: untracked, so an effect calling one is not subscribed to it.
function mutator(name: string): (this: unknown[], ...args: unknown[]) => unknown {
  let wrapped = mutators.get(name)

  if (!wrapped) {
    const original = (Array.prototype as unknown as Record<string, (...args: unknown[]) => unknown>)[name]!

    wrapped = function (this: unknown[], ...args) {
      return untrack(() => original.apply(this, args))
    }
    mutators.set(name, wrapped)
  }

  return wrapped
}

const handler: ProxyHandler<object> = {
  get(target, key, receiver) {
    if (typeof key === 'symbol')
      return Reflect.get(target, key, receiver) as unknown

    if (Array.isArray(target) && MUTATORS.has(key))
      return mutator(key)

    const own = Object.hasOwn(target, key)

    // What the prototype gives, such as an array's methods, never changes.
    if (own || !(key in target))
      trackKey(target, key)

    const value: unknown = Reflect.get(target, key, receiver)

    if (!own || !plain(value)) {
      if (process.env.NODE_ENV !== 'production' && own)
        warnUntracked(value, `\`${key}\``)

      return value
    }

    // A frozen property must read back as it is, which a proxy could not.
    const descriptor = Reflect.getOwnPropertyDescriptor(target, key)

    return descriptor?.configurable === false && descriptor.writable === false ? value : wrap(unwrap(value))
  },

  has(target, key) {
    if (typeof key === 'string')
      trackKey(target, key)

    return Reflect.has(target, key)
  },

  ownKeys(target) {
    trackShape(target)

    return Reflect.ownKeys(target)
  },

  set(target, key, value, receiver) {
    const next = unwrap(value)

    if (typeof key === 'symbol')
      return Reflect.set(target, key, next, receiver)

    const had = Object.hasOwn(target, key)
    const length = Array.isArray(target) ? target.length : 0
    const previous = (target as Record<string, unknown>)[key]

    if (!Reflect.set(target, key, next, receiver))
      return false

    if (had && Object.is(previous, next))
      return true

    touch(target, key)

    if (!had)
      touchShape(target)

    if (Array.isArray(target) && target.length !== length) {
      touch(target, 'length')
      touchShape(target)

      // Shrinking drops the elements past the new end, which readers of them see go.
      for (const tracked of metas.get(target)?.keys.keys() ?? []) {
        const index = Number(tracked)

        if (Number.isInteger(index) && index >= target.length && index < length)
          touch(target, tracked)
      }
    }

    return true
  },

  deleteProperty(target, key) {
    const had = typeof key === 'string' && Object.hasOwn(target, key)

    if (!Reflect.deleteProperty(target, key))
      return false

    if (had) {
      touch(target, key)
      touchShape(target)
    }

    return true
  },
}

export function wrap<T extends object>(target: T): T {
  let proxy = proxies.get(target)

  if (!proxy) {
    proxy = new Proxy(target, handler)
    proxies.set(target, proxy)
    raws.set(proxy, target)
  }

  return proxy as T
}

// State mutated in place that a read tracks per property: `game.coins += 1` re-runs what read `game.coins` and nothing else.
// How a collection that tracks its reads gives a plain copy of itself to `snapshot`, given the function that copies what it holds and the one that records the copy before it is filled, for a cycle.
export const SNAPSHOT = Symbol('snapshot')

// Development only: what a store keeps as written and does not track, named with what to use in its place.
function warnUntracked(value: unknown, where: string): void {
  if (typeof value !== 'object' || value === null || SNAPSHOT in value)
    return

  if (value instanceof Map || value instanceof Set)
    warnOnce(`store() holds a ${value instanceof Map ? 'Map' : 'Set'} at ${where}, which it does not track: a write to it notifies nothing. Use ${value instanceof Map ? 'reactiveMap' : 'reactiveSet'}() from 'kay' for one that does.`)
  else if (value instanceof Date)
    warnOnce(`store() holds a Date at ${where}, which it does not track: \`setHours\` and the other setters notify nothing. Assign a new Date to update readers.`)
}

// Plain objects and arrays are tracked, deeply; a Map, a Set, a Date or a class instance is kept as written and is not (`reactiveMap` and `reactiveSet` are the tracked collections).
// kept: free
export function store<T extends object>(value: T): T {
  if (plain(value))
    return wrap(kept(unwrap(value)))

  if (process.env.NODE_ENV !== 'production')
    warnUntracked(value, 'the top level')

  return value
}

// A plain deep copy of a store, or of any plain value, with no proxy in it and nothing tracked by reading it: what to save or send.
// kept: free
export function snapshot<T>(value: T): T {
  return copy(value, new Map()) as T
}

function copy(value: unknown, seen: Map<object, unknown>): unknown {
  const source = unwrap(value)
  const own = (source as { [SNAPSHOT]?: (copier: (item: unknown) => unknown, register: (made: unknown) => void) => unknown } | null | undefined)?.[SNAPSHOT]

  if (own) {
    return seen.has(source as object)
      ? seen.get(source as object)
      : own.call(source, item => copy(item, seen), made => seen.set(source as object, made))
  }

  if (!plain(source))
    return source

  if (seen.has(source))
    return seen.get(source)

  if (Array.isArray(source)) {
    const items: unknown[] = []

    seen.set(source, items)

    for (let index = 0; index < source.length; index++)
      items[index] = copy(source[index], seen)

    return items
  }

  const object: Record<string, unknown> = Object.getPrototypeOf(source) === null ? Object.create(null) as Record<string, unknown> : {}

  seen.set(source, object)

  for (const key of Object.keys(source))
    Object.defineProperty(object, key, { value: copy((source as Record<string, unknown>)[key], seen), writable: true, enumerable: true, configurable: true })

  return object
}
