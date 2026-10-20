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
