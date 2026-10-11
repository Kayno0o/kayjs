// Runs a control's change callback, holding the control busy while a promise-like it answers is pending.
// False once the change was refused, by resolving to false, rejecting or throwing; true otherwise, a callback answering nothing to wait on included.
// A failure is logged rather than thrown, an event handler having no one to throw to: the control going back is what the user sees.
export async function changeAccepted(control: string, run: () => unknown, busy: (pending: boolean) => void): Promise<boolean> {
  try {
    const answer = run()

    if (!isPromiseLike(answer))
      return true

    busy(true)

    return await answer !== false
  }
  catch (error) {
    console.error(`kayjs-ui: a ${control}'s onChange failed`, error)

    return false
  }
  finally {
    busy(false)
  }
}

// Any promise-like, not only this window's `Promise`.
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'then') === 'function'
}
