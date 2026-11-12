import { plain, SNAPSHOT, touch, touchShape, trackKey, trackShape, unwrap, wrap } from './store'

// What iteration reads: a write to any element touches it.
const ALL = Symbol('all')

// A plain object held is read as a store object, tracked per property, as in a `store`.
const view = (value: unknown): unknown => (plain(value) ? wrap(unwrap(value)) : value)

function changed(target: object, key: unknown, structural: boolean): void {
  touch(target, key)
  touch(target, ALL)

  if (structural)
    touchShape(target)
}

class ReactiveMap<K, V> extends Map<K, V> {
  override get size(): number {
    trackShape(this)

    return super.size
  }

  override has(key: K): boolean {
    const raw = unwrap(key)

    trackKey(this, raw)

    return super.has(raw)
  }

  override get(key: K): V | undefined {
    const raw = unwrap(key)

    trackKey(this, raw)

    return view(super.get(raw)) as V | undefined
  }

  override set(key: K, value: V): this {
    const raw = unwrap(key)
    const had = super.has(raw)

    if (!had || !Object.is(super.get(raw), unwrap(value))) {
      super.set(raw, unwrap(value))
      changed(this, raw, !had)
    }

    return this
  }

  override delete(key: K): boolean {
    const gone = super.delete(unwrap(key))

    if (gone)
      changed(this, unwrap(key), true)

    return gone
  }

  override clear(): void {
    for (const key of super.keys())
      this.delete(key)
  }

  override keys(): MapIterator<K> {
    trackShape(this)

    return Array.from(super.keys(), view as (key: K) => K).values()
  }

  override values(): MapIterator<V> {
    trackKey(this, ALL)

    return Array.from(super.values(), view as (value: V) => V).values()
  }

  override entries(): MapIterator<[K, V]> {
    trackKey(this, ALL)

    return Array.from(super.entries(), ([key, value]) => [view(key), view(value)] as [K, V]).values()
  }

  override [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries()
  }

  override forEach(callback: (value: V, key: K, map: Map<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.entries())
      callback.call(thisArg, value, key, this)
  }

  [SNAPSHOT](copy: (item: unknown) => unknown, register: (made: unknown) => void): Map<K, V> {
    const made = new Map<K, V>()

    register(made)

    for (const [key, value] of super.entries())
      made.set(copy(key) as K, copy(value) as V)

    return made
  }
}

class ReactiveSet<T> extends Set<T> {
  override get size(): number {
    trackShape(this)

    return super.size
  }

  override has(value: T): boolean {
    const raw = unwrap(value)

    trackKey(this, raw)

    return super.has(raw)
  }

  override add(value: T): this {
    const raw = unwrap(value)

    if (!super.has(raw)) {
      super.add(raw)
      changed(this, raw, true)
    }

    return this
  }

  override delete(value: T): boolean {
    const gone = super.delete(unwrap(value))

    if (gone)
      changed(this, unwrap(value), true)

    return gone
  }

  override clear(): void {
    for (const value of super.values())
      this.delete(value)
  }

  override values(): SetIterator<T> {
    trackKey(this, ALL)

    return Array.from(super.values(), view as (value: T) => T).values()
  }

  override keys(): SetIterator<T> {
    return this.values()
  }

  override entries(): SetIterator<[T, T]> {
    return Array.from(this.values(), value => [value, value] as [T, T]).values()
  }

  override [Symbol.iterator](): SetIterator<T> {
    return this.values()
  }

  override forEach(callback: (value: T, again: T, set: Set<T>) => void, thisArg?: unknown): void {
    for (const value of this.values())
      callback.call(thisArg, value, value, this)
  }

  [SNAPSHOT](copy: (item: unknown) => unknown, register: (made: unknown) => void): Set<T> {
    const made = new Set<T>()

    register(made)

    for (const value of super.values())
      made.add(copy(value) as T)

    return made
  }
}

// The native set algebra reads the set's own slots, so each one subscribes to the whole set first.
for (const name of ['union', 'intersection', 'difference', 'symmetricDifference', 'isSubsetOf', 'isSupersetOf', 'isDisjointFrom'] as const) {
  // eslint-disable-next-line ts/unbound-method -- called back with the set as `this`
  const native = Set.prototype[name] as ((this: Set<unknown>, other: ReadonlySetLike<unknown>) => unknown) | undefined

  if (native) {
    ReactiveSet.prototype[name] = function (this: ReactiveSet<unknown>, other: ReadonlySetLike<unknown>) {
      trackKey(this, ALL)

      return native.call(this, other)
    } as never
  }
}

// A Map whose reads are tracked, so an effect or a template re-runs only for what it read: `has(k)` and `get(k)` for `k`, `size` and `keys()` as entries come and go, and iteration, `values()`, `entries()` and `forEach` for any change.
// `set` and `delete` notify as they are written, a plain object value reads back tracked as in a `store`, and `snapshot` copies it to a plain Map. Held in a `store`, it is kept as it is.
// kept: free
export function reactiveMap<K, V>(entries?: Iterable<readonly [K, V]> | null): Map<K, V> {
  return new ReactiveMap<K, V>(entries)
}

// A Set whose reads are tracked: `has(v)` re-runs only when `v` comes or goes, `size` as values come and go, and iteration and `forEach` on any change.
// kept: free
export function reactiveSet<T>(values?: Iterable<T> | null): Set<T> {
  return new ReactiveSet<T>(values)
}
