import type { Signal } from './core'
import { isSignal, untrack } from './reactive'

// The compiler's output contract, not API: what generated code imports, free to change with any release.
export { actionStub, formAction, formChecked, formDescribed, formError, formInvalid, formMarked, formProtection, formValue, isAction, registerActions, reviveActions } from './action'
export { registerImage } from './image'
export { registerPlaceholder } from './placeholder'

// Takes the rejection of a server value an `await` block renders by name right where it is declared, so no later statement of the fence can leave it unhandled; any other promise is held by the server until its block takes it.
export function autoDefer<T>(value: T): T {
  if (value instanceof Promise)
    void Promise.allSettled([value])

  return value
}

type Keyed = Record<PropertyKey, unknown>

// What a write to a place holding `T` takes: the value of a signal, anything else as it is.
type Written<T> = T extends Signal<infer Value> ? Value : T

// What a signal of any value is, to tell it from a function of its type's other members.
type Writable = (() => unknown) & { set: unknown }

// The value a signal holds, `never` for anything else.
type Held<S> = S extends Signal<infer Value> ? Value : never

// What a `let` holds once written: the signal it held, else the value.
type Kept<Current, Value> = Current extends Signal<infer Held> ? Signal<Held> : Value

// The signal a property holds, found without running an accessor: a getter alone is read, since assigning to it would throw, while a setter is the property's own way to be written.
function heldAt(object: unknown, key: PropertyKey): Signal<unknown> | undefined {
  for (let at = object; at != null; at = Object.getPrototypeOf(at)) {
    const descriptor = Object.getOwnPropertyDescriptor(at, key)

    if (!descriptor)
      continue

    const value: unknown = 'value' in descriptor || descriptor.set !== undefined ? descriptor.value : descriptor.get?.call(object)

    return isSignal(value) ? value : undefined
  }

  return undefined
}

// An assignment to `object[key]` whose target may hold a signal (a function, a signal included, replaces it, since a signal holds none), which `kay dev` and `kay build` run no types to learn: a signal is written, anything else is assigned as written. Type checking reads the same signature, so the target is typed by what it holds.
export function writeTo<Target, Key extends keyof Target, Value extends Written<Target[Key]> | Target[Key]>(object: Target, key: Key, value: Value): Value {
  const held = heldAt(object, key)

  if (held !== undefined && typeof value !== 'function')
    held.set(value)
  else
    (object as Keyed)[key] = value

  return value
}

// `object[key] += 1` and `object[key]++`: `update` gives the next value from the current one, `post` makes the expression the number it had, and `logical` (`||=`, `??=`) writes nothing when the value stays.
export function updateTo<Target, Key extends keyof Target>(object: Target, key: Key, update: (current: Written<Target[Key]>) => Written<Target[Key]>, form?: 'post' | 'logical'): Written<Target[Key]> {
  const held = heldAt(object, key)
  const before = held === undefined ? (object as Keyed)[key] : untrack(held)
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
export function writeBack<Current, Value extends Current>(current: Current, value: Value): Value
export function writeBack<Current extends Writable>(current: Current, value: Held<Current>): Current
export function writeBack(current: unknown, value: unknown): unknown {
  if (!isSignal(current) || typeof value === 'function')
    return value

  current.set(value)

  return current
}

// The same for `variable += 1` and `variable++`.
export function updateBack<Current, Next>(current: Current, update: (current: Written<Current>) => Next): Kept<Current, Next> {
  if (!isSignal(current))
    return update(current as Written<Current>) as Kept<Current, Next>

  const next = update(untrack(current) as Written<Current>)

  if (typeof next !== 'function')
    current.set(next)

  return (typeof next === 'function' ? next : current) as Kept<Current, Next>
}
