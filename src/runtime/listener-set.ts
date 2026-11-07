// A set of listeners to call with a value, one throwing leaving the others alone; `on` gives what removes a listener.
export function listenerSet<T>(): { on: (listener: (value: T) => void) => () => void, emit: (value: T) => void } {
  const all = new Set<(value: T) => void>()

  return {
    on: (listener) => {
      all.add(listener)

      return () => void all.delete(listener)
    },
    emit: (value) => {
      for (const listener of all) {
        try {
          listener(value)
        }
        catch (error) {
          console.error(error)
        }
      }
    },
  }
}
