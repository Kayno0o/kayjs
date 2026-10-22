import { ownSignal, untrack } from './reactive'

// How a tracked call went, for an action and for a route alike: what it answered, or the refusal. `errors` holds a message per field, the form-wide one under ''; `data` is what the handler passed to `ctx.fail` for an action, the answer a route refused with for a route.
export type CallResult<Data, Failed>
  = | { ok: true, data: Data }
    | { ok: false, status: number, errors: Record<string, string>, data: Failed | undefined }

// What `settled()` waits on: callers resolved as the count of calls in flight reaches 0.
export function whenIdle(): { wait: (count: number) => Promise<void>, check: (count: number) => void } {
  let waiting: (() => void)[] = []

  return {
    wait: async count => count === 0 ? undefined : new Promise<void>(resolve => void waiting.push(resolve)),
    check: (count) => {
      if (count !== 0 || waiting.length === 0)
        return

      const resolving = waiting

      waiting = []

      for (const resolve of resolving)
        resolve()
    },
  }
}

// A handle with a pending count of its own over `call`: it resolves `{ ok: true, data }`, or what `refused` makes of an error the call threw, which rethrows when it returns undefined. `holds` says a result is a stream, which counts as in flight until it ends, calling `release` then.
export function trackCalls<Args extends unknown[]>(
  call: (...args: Args) => Promise<unknown>,
  refused: (error: unknown) => CallResult<never, unknown> | undefined,
  holds?: (data: unknown, release: () => void) => boolean,
): ((...args: Args) => Promise<CallResult<unknown, unknown>>) & { pending: () => boolean, settled: () => Promise<void> } {
  const [inFlight, setInFlight] = ownSignal(0)
  const idle = whenIdle()
  const shift = (by: number) => {
    setInFlight(untrack(inFlight) + by)
    idle.check(untrack(inFlight))
  }

  const run = async (...args: Args): Promise<CallResult<unknown, unknown>> => {
    let streaming = false

    shift(1)

    try {
      const data = await call(...args)

      streaming = holds?.(data, () => shift(-1)) ?? false

      return { ok: true, data }
    }
    catch (error) {
      const result = refused(error)

      if (result === undefined)
        throw error

      return result
    }
    finally {
      if (!streaming)
        shift(-1)
    }
  }

  return Object.assign(run, { pending: () => inFlight() > 0, settled: async () => idle.wait(untrack(inFlight)) })
}
