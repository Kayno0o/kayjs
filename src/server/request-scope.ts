import { recordOf, requestRecord } from './request-record'

// `ctx.once`: the promise `load` made the first time the request asked for `key`, handed to every later ask, so loads running in parallel share one and a failure is shared too.
// eslint-disable-next-line ts/promise-function-async -- an async function would hand back a second promise for the held one
export function onceForRequest<T>(request: Request, key: string, load: () => T): Promise<Awaited<T>> {
  const record = requestRecord(request)
  const memo = record.memo ??= new Map()
  const held = memo.get(key)

  if (held !== undefined)
    return held as Promise<Awaited<T>>

  const started = Promise.try(load) as Promise<Awaited<T>>

  memo.set(key, started)

  return started
}

// `ctx.once` of a request, written the same at every place that makes a context.
export function onceOf(request: Request): <T>(key: string, load: () => T) => Promise<Awaited<T>> {
  // eslint-disable-next-line ts/promise-function-async -- an async arrow would wrap the held promise in a second one
  return (key, load) => onceForRequest(request, key, load)
}

// What a request forgets when its page renders again for the user a read needed: the answers loaded while the viewer was unknown.
export function forgetOnces(request: Request): void {
  const record = recordOf(request)

  if (record !== undefined)
    record.memo = undefined
}

const NO_VALUES = Object.freeze({})

// What the guards of a request handed on: empty until one returns an object, never undefined.
export function guardValues(request: Request): Record<string, unknown> {
  return recordOf(request)?.guardValues ?? NO_VALUES
}

// Starts the values a run of guards hands on; a request whose guards run again starts from none.
export function startGuardValues(request: Request): Record<string, unknown> {
  return requestRecord(request).guardValues = {}
}

// Lays what a guard returned over the values of the guards before it: only a plain object counts, and a key named `__proto__` is a key.
export function handOn(values: Record<string, unknown>, returned: unknown): void {
  if (typeof returned !== 'object' || returned === null)
    return

  const proto: unknown = Object.getPrototypeOf(returned)

  if (proto !== Object.prototype && proto !== null)
    return

  for (const [key, value] of Object.entries(returned))
    Object.defineProperty(values, key, { value, enumerable: true, writable: true, configurable: true })
}
