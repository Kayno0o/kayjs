import type { Deferred } from './checks'

// The compiler's output contract, not API: what generated code imports, free to change with any release.
export { actionStub, formAction, formChecked, formInvalid, formValue, isAction, registerActions } from './action'
export { registerImage } from './image'

export type AutoDeferred<T> = T extends PromiseLike<infer Value> ? Deferred<Value> : T

// A server value an `await` block renders: a promise is handled at once, as `defer()` handles it, and anything else is left as it is.
export function autoDefer<T>(value: T): AutoDeferred<T> {
  if (value instanceof Promise)
    void Promise.allSettled([value])

  return value as AutoDeferred<T>
}
