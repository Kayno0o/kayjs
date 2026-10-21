// The text between a function's parentheses, or its lone arrow parameter.
const PARAMETERS = /^(?:async\s+)?(?:function[^(]*|[\w$]+\s*)?\(\s*(.?)/

// Calls an `on*` hook with its one event object, or with `legacy` as positional arguments when it still has its old shape: two or more parameters, or a lone one that is not destructured (`(user) => ...`). This lets the old shape keep working until 1.73, so an app writes `({ user })` to move over.
export function callHook<Result>(hook: (...args: never[]) => Result, event: object, legacy: readonly unknown[]): Result {
  const call = hook as (...args: unknown[]) => Result

  return takesEvent(hook) ? call(event) : call(...legacy)
}

function takesEvent(hook: (...args: never[]) => unknown): boolean {
  if (hook.length >= 2)
    return false

  if (hook.length === 0)
    return true

  return PARAMETERS.exec(hook.toString())?.[1] === '{'
}
