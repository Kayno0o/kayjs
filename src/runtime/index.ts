import type { Setter, SignalOptions } from 'solid-js'
import { createSignal } from 'solid-js'

export interface Signal<T> {
  (): T
  set: Setter<T>
}

type PlainValue<T> = Exclude<T, (...args: never[]) => unknown>

// Solid reads a function argument as a computation; signal() narrows its input to plain values, so this one overload is all it reaches.
const createValueSignal = createSignal as unknown as <T>(value: T, options?: SignalOptions<T>) => [read: () => T, set: Setter<T>]

// A signal read as `count()` and written as `count.set(1)` or `count.set(c => c + 1)`.
export function signal<T>(): Signal<T | undefined>
export function signal<T>(value: PlainValue<T>, options?: SignalOptions<T>): Signal<T>
export function signal<T>(value?: PlainValue<T>, options?: SignalOptions<T | undefined>): Signal<T | undefined> {
  const [read, set] = createValueSignal<T | undefined>(value, options)

  return Object.assign(read, { set })
}
