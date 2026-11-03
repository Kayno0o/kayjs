import type { ApiError, ErrorShape } from './api-error'
import type { LoadStatus, Source } from './live'
import { apiErrorOf } from './api-error'
import { ownSignal, untrack } from './reactive'

// How a tracked call went, for an action and for a route alike: what it answered, or the refusal. `message` is the text to show; `errors` holds a message per field, the form-wide one under ''; `data` is what the handler passed to `ctx.fail` for an action, the answer a route refused with for a route.
export type CallResult<Data, Failed>
  = | { ok: true, data: Data }
    | ({ ok: false } & ErrorShape<Failed>)

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

// A handle over `call` that reads its own calls as a source: `pending()` counts those in flight, `status()` is `idle` before the first, `loading` while one runs and else how the last to settle went, `error()` the failure of the last one until a call succeeds, and `retry()` repeats the call that failed.
// It resolves `{ ok: true, data }`, or what `refused` makes of an error the call threw, which rethrows when it returns undefined; an abort rethrows and is no failure. `holds` says a result is a stream, which counts as in flight until it ends, calling `release` then.
export function trackCalls<Args extends unknown[]>(
  call: (...args: Args) => Promise<unknown>,
  refused: (error: unknown) => CallResult<never, unknown> | undefined,
  holds?: (data: unknown, release: () => void) => boolean,
): ((...args: Args) => Promise<CallResult<unknown, unknown>>) & Source<LoadStatus> & { settled: () => Promise<void> } {
  const [inFlight, setInFlight] = ownSignal(0)
  const [outcome, setOutcome] = ownSignal<LoadStatus>('idle')
  const [error, setError] = ownSignal<ApiError | undefined>(undefined)
  const idle = whenIdle()
  let failedWith: Args | undefined
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
      setOutcome('ready')
      setError(undefined)

      return { ok: true, data }
    }
    catch (failure) {
      if (!args.some(arg => (arg as { signal?: AbortSignal } | undefined)?.signal?.aborted === true)) {
        failedWith = args
        setOutcome('failed')
        setError(apiErrorOf(failure))
      }

      const result = refused(failure)

      if (result === undefined)
        throw failure

      return result
    }
    finally {
      if (!streaming)
        shift(-1)
    }
  }

  return Object.assign(run, {
    status: () => inFlight() > 0 ? 'loading' as const : outcome(),
    pending: () => inFlight() > 0,
    error,
    settled: async () => idle.wait(untrack(inFlight)),
    retry: () => {
      if (untrack(inFlight) > 0 || untrack(outcome) !== 'failed' || failedWith === undefined)
        return

      void retried(run, failedWith)
    },
  })
}

// Runs a call again for `retry()`: how it went is in `error()`, so what it throws goes no further than a button's handler.
async function retried<Args extends unknown[]>(run: (...args: Args) => Promise<unknown>, args: Args): Promise<void> {
  try {
    await run(...args)
  }
  catch {}
}
