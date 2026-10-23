import { ownSignal, tracking, untrack } from './reactive'

// A dependency on one key or on an object's set of keys: a signal that notifies on every write and holds nothing.
interface Dep {
  read: () => number
  write: (next: number) => void
}

interface Meta {
  keys: Map<string, Dep>
  shape: Dep | undefined
}

const MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin'])
const proxies = new WeakMap<object, object>()
const raws = new WeakMap<object, object>()
const metas = new WeakMap<object, Meta>()
const mutators = new Map<string, (this: unknown[], ...args: unknown[]) => unknown>()

function plain(value: unknown): value is object {
  if (typeof value !== 'object' || value === null)
    return false

  if (Array.isArray(value))
    return true

  const proto = Object.getPrototypeOf(value)

  return proto === Object.prototype || proto === null
}

const unwrap = <T>(value: T): T => (typeof value === 'object' && value !== null ? raws.get(value) as T | undefined : undefined) ?? value

function dep(): Dep {
  const [read, write] = ownSignal(0, { equals: false })

  return { read, write }
}

function metaOf(target: object): Meta {
  let meta = metas.get(target)

  if (!meta)
    metas.set(target, meta = { keys: new Map(), shape: undefined })

  return meta
}

// Subscribes the running computation to `key`, made only when something is listening so a write with no reader costs nothing.
function trackKey(target: object, key: string): void {
  if (!tracking())
    return

  const { keys } = metaOf(target)
  let one = keys.get(key)

  if (!one)
    keys.set(key, one = dep())

  one.read()
}

function trackShape(target: object): void {
  if (!tracking())
    return

  const meta = metaOf(target)

  meta.shape ??= dep()
  meta.shape.read()
}

function touch(target: object, key: string): void {
  metas.get(target)?.keys.get(key)?.write(0)
}

function touchShape(target: object): void {
  metas.get(target)?.shape?.write(0)
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

    if (!own || !plain(value))
      return value

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

function wrap<T extends object>(target: T): T {
  let proxy = proxies.get(target)

  if (!proxy) {
    proxy = new Proxy(target, handler)
    proxies.set(target, proxy)
    raws.set(proxy, target)
  }

  return proxy as T
}

// State mutated in place that a read tracks per property: `game.coins += 1` re-runs what read `game.coins` and nothing else.
// Plain objects and arrays are tracked, deeply; a Map, a Set, a Date or a class instance is kept as written and is not.
export function store<T extends object>(value: T): T {
  return plain(value) ? wrap(unwrap(value)) : value
}

// A plain deep copy of a store, or of any plain value, with no proxy in it and nothing tracked by reading it: what to save or send.
export function snapshot<T>(value: T): T {
  return copy(value, new Map()) as T
}

function copy(value: unknown, seen: Map<object, unknown>): unknown {
  const source = unwrap(value)

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
