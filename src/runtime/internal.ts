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

// An assignment to `object[key]` whose target may hold a signal (a function, a signal included, replaces it, since a signal holds none), which `kay dev` and `kay build` run no types to learn: a signal is written, anything else is assigned as written. Type checking reads the same signature, so the target is typed by what it holds.
export function writeTo<Target, Key extends keyof Target>(object: Target, key: Key, value: Written<Target[Key]>): Written<Target[Key]> {
  const current = (object as Keyed)[key]

  if (isSignal(current) && typeof value !== 'function')
    current.set(value)
  else
    (object as Keyed)[key] = value

  return value
}

// `object[key] += 1` and `object[key]++`: `update` gives the next value from the current one, and `post` makes the expression the value it had.
export function updateTo<Target, Key extends keyof Target>(object: Target, key: Key, update: (current: Written<Target[Key]>) => Written<Target[Key]>, post = false): Written<Target[Key]> {
  const current = (object as Keyed)[key]

  if (isSignal(current)) {
    const before = untrack(current) as Written<Target[Key]>
    const next = update(before)

    current.set(next)

    return post ? before : next
  }

  const next = update(current as Written<Target[Key]>);

  (object as Keyed)[key] = next

  return post ? current as Written<Target[Key]> : next
}

// A `let` assigned a signal's place, `variable = writeBack(variable, value)`: a signal is written and stays the variable's value, anything else is replaced. What type checking cannot tell a plain `let` from is left unchecked.
export function writeBack<Current>(current: Current, value: Current extends Signal<infer Value> ? Value : unknown): Current {
  if (!isSignal(current) || typeof value === 'function')
    return value as Current

  current.set(value)

  return current
}

// The same for `variable += 1` and `variable++`.
export function updateBack<Current>(current: Current, update: (current: Written<Current>) => unknown): Current {
  if (!isSignal(current))
    return update(current as Written<Current>) as Current

  current.set(update(untrack(current) as Written<Current>))

  return current
}
