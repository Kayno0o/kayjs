import type { Signal } from './core'
import { createSignal, getOwner, isSignal, liveOwner, renderEffect, runWithOwner, unrecorded, untrack } from './reactive'

// The compiler's output contract, not API: what generated code imports, free to change with any release.
export { actionStub, formAction, formChecked, formDescribed, formError, formInvalid, formMarked, formProtection, formValue, isAction, registerActions, reviveActions } from './action'
export { registerImage } from './image'
export { registerPlaceholder } from './placeholder'
export { uiRecipe } from './recipe'

// Takes the rejection of a server value an `await` block renders by name right where it is declared, so no later statement of the fence can leave it unhandled; any other promise is held by the server until its block takes it.
export function autoDefer<T>(value: T): T {
  if (value instanceof Promise)
    void Promise.allSettled([value])

  return value
}

type Keyed = Record<PropertyKey, unknown>

// What a write to a place holding `T` takes: the value of a signal, anything else as it is.
type Written<T> = T extends Signal<infer Value> ? Value : T

// What a `let` holds once written: the signal it held, else the value.
type Kept<Current, Value> = Current extends Signal<infer Held> ? Signal<Held> : Value

// The signal a property holds, found without running an accessor: a getter alone is read, since assigning to it would throw, while a setter is the property's own way to be written. `read` answers what that getter returned, so a caller needing the value does not run it twice.
function heldAt(object: unknown, key: PropertyKey): { held: Signal<unknown> | undefined, read: boolean, value?: unknown } {
  for (let at = object; at != null; at = Object.getPrototypeOf(at)) {
    const descriptor = Object.getOwnPropertyDescriptor(at, key)

    if (!descriptor)
      continue

    const read = !('value' in descriptor) && descriptor.set === undefined
    const value: unknown = read ? descriptor.get?.call(object) : descriptor.value

    return { held: isSignal(value) ? value : undefined, read, value }
  }

  return { held: undefined, read: false }
}

// An assignment to `object[key]` whose target may hold a signal (a function, a signal included, replaces it, since a signal holds none), which `kay dev` and `kay build` run no types to learn: a signal is written, anything else is assigned as written. Type checking reads the same signature, so the target is typed by what it holds.
export function writeTo<Target, Key extends keyof Target, Value extends Written<Target[Key]> | Target[Key]>(object: Target, key: Key, value: Value): Value {
  const { held } = heldAt(object, key)

  if (held !== undefined && typeof value !== 'function')
    held.set(value)
  else
    (object as Keyed)[key] = value

  return value
}

// `object[key] += 1` and `object[key]++`: `update` gives the next value from the current one, `post` makes the expression the number it had, and `logical` (`||=`, `??=`) writes nothing when the value stays.
export function updateTo<Target, Key extends keyof Target>(object: Target, key: Key, update: (current: Written<Target[Key]>) => Written<Target[Key]>, form?: 'post' | 'logical'): Written<Target[Key]> {
  const { held, read, value } = heldAt(object, key)
  let before: unknown

  if (held !== undefined)
    before = untrack(held)
  else
    before = read ? value : (object as Keyed)[key]

  const next = update(before as Written<Target[Key]>)

  if (form !== 'logical' || !Object.is(next, before)) {
    if (held !== undefined && typeof next !== 'function')
      held.set(next)
    else
      (object as Keyed)[key] = next
  }

  // `++` answers the number it read, not the string or the object it was.
  return form === 'post' ? (typeof before === 'bigint' ? before : Number(before)) as Written<Target[Key]> : next
}

// A `let` assigned a signal's place, `variable = writeBack(variable, value)`: a signal is written and stays the variable's value, anything else is replaced. What type checking cannot tell a plain `let` from is left unchecked.
// The type of the variable can be given as `Current`, since the argument is narrowed where a plain assignment is typed by the declaration.
export function writeBack<Current, Value extends Current | Written<Current> = Current | Written<Current>>(current: Current, value: Value): Kept<Current, Value>
export function writeBack(current: unknown, value: unknown): unknown {
  if (!isSignal(current) || typeof value === 'function')
    return value

  current.set(value)

  return current
}

// The same for `variable += 1` and `variable++`.
export function updateBack<Current, Next = Current | Written<Current>>(current: Current, update: (current: Written<Current>) => Next): Kept<Current, Next> {
  if (!isSignal(current))
    return update(current as Written<Current>) as Kept<Current, Next>

  const next = update(untrack(current) as Written<Current>)

  if (typeof next !== 'function')
    current.set(next)

  return (typeof next === 'function' ? next : current) as Kept<Current, Next>
}

// The props of a component with `Bindable` props: a write goes through the parent's setter when it bound the prop with `bind:`, else it is kept here, read back in place of the parent's value until that value changes.
export function bindable<Props extends object>(props: Props, keys: readonly string[]): Props {
  const names = new Set<PropertyKey>(keys)
  const local = new Map<PropertyKey, Local>()
  const home = getOwner()
  const held = (key: PropertyKey) => {
    let kept = local.get(key)

    if (!kept) {
      const [version, bump] = unrecorded(() => createSignal(0))

      kept = { version, bump, count: 0, watching: false, override: undefined }
      local.set(key, kept)
    }

    return kept
  }

  const proxy: Props = new Proxy(props, {
    get(target, key, receiver) {
      const parent = Reflect.get(target, key, receiver)

      if (!names.has(key))
        return parent

      const kept = held(key)

      kept.version()

      if (kept.override && !Object.is(parent, kept.override.from))
        kept.override = undefined

      return kept.override ? kept.override.value : parent
    },
    set(target, key, value) {
      if (!names.has(key) || Object.getOwnPropertyDescriptor(target, key)?.set)
        return Reflect.set(target, key, value)

      const kept = held(key)

      kept.override = { value, from: untrack(() => Reflect.get(target, key)) }
      kept.bump(++kept.count)

      // Watches the parent's value from the first write on, so the override ends when the value moves even if nothing reads the prop before it moves back.
      if (!kept.watching) {
        kept.watching = true
        runWithOwner(liveOwner(home), () => renderEffect(() => {
          const parent = Reflect.get(target, key)

          if (kept.override && !Object.is(parent, kept.override.from)) {
            kept.override = undefined
            kept.bump(++kept.count)
          }
        }))
      }

      return true
    },
    // `omit` and `merge` copy descriptors, so `...rest` and a props spread hand on the prop as this component reads and writes it, not the parent's original.
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key)

      if (!descriptor || !names.has(key) || descriptor.configurable === false)
        return descriptor

      return { configurable: true, enumerable: descriptor.enumerable ?? true, get: () => Reflect.get(proxy, key), set: (value: unknown) => void Reflect.set(proxy, key, value) }
    },
  })

  return proxy
}

// What a child wrote to a prop, with the value the parent held then, and the version readers track for the writes.
interface Local {
  version: () => number
  bump: (next: number) => void
  count: number
  watching: boolean
  override: { value: unknown, from: unknown } | undefined
}
