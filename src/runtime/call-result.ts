import type { ApiError, ErrorShape } from './api-error'
import type { LoadStatus, Reader } from './live'
import { apiErrorOf } from './api-error'
import { listenerSet } from './listener-set'
import { ownSignal, untrack } from './reactive'

// How a tracked call went, for an action and for a route alike: what it answered, or the refusal. `message` is the text to show; `errors` holds a message per field, the form-wide one under ''; `data` is what the handler passed to `ctx.fail` for an action, the answer a route refused with for a route.
// A refusal carries them twice, flat on the result and as its `error`, the one place every other result keeps its failure: the `ApiError` itself (an `ActionError` for an action), so `orThrow()` and a `throw result.error` throw what the call threw.
export type CallResult<Data, Failed>
  = | { ok: true, data: Data, error?: undefined }
    | ({ ok: false, error: ErrorShape<Failed> } & ErrorShape<Failed>)

// What a call returns: the result, and `orThrow()` for the throwing style, which resolves with the data and rejects with the failure itself (an `ActionError`, an `ApiError`, the `TimeoutError` of a timeout).
export type CallPromise<Result> = Promise<Result> & { orThrow: () => Promise<Result extends { ok: true, data: infer Data } ? Data : never> }

// The mark a call's result carries (not enumerable), so a reader tells it from an answer shaped like one, such as an entry write's `{ ok: false, error, issues }`: `unwrapped` of kayjs-ui looks for it by name.
const RESULT = Symbol.for('kay.call-result')

const marked = <Result extends object>(result: Result): Result => Object.defineProperty(result, RESULT, { value: true })

// Whether a call's options carry a signal that was aborted: what fails then is the abort's, and rejects as it threw, a timeout signal's included.
export const signalAborted = (options: unknown): boolean => (options as { signal?: AbortSignal } | undefined)?.signal?.aborted === true

// Turns a call that throws into one that answers a result: `refused` gives the `ApiError` of what it threw, which is the result's `error`, or undefined for what is no failure of the call (an abort, a redirect) or of the visitor (a bug), which rejects as it threw.
export function settling<Data>(throwing: Promise<Data>, refused: (error: unknown) => ApiError | undefined): CallPromise<CallResult<Data, unknown>> {
  const result = (async (): Promise<CallResult<Data, unknown>> => {
    try {
      return marked({ ok: true, data: await throwing })
    }
    catch (failure) {
      const error = refused(failure)

      if (error === undefined)
        throw failure

      return marked({ ok: false, status: error.status, message: error.message, errors: error.errors, data: error.data, error })
    }
  })()

  // A call awaited only through `orThrow()` leaves this one to reject on its own, which is no unhandled rejection.
  void Promise.allSettled([result])

  return Object.assign(result, { orThrow: async () => throwing })
}

// The callbacks a tracked call takes in its options, and as methods of the same names: `onX` after a transition, one object argument, `input` the first argument of the call. One that throws is logged and leaves the call alone.
// `input` is `unknown`, so an action of any input still passes where another is expected, as `Action` stands for any.
export interface TrackHooks<Data> {
  // A call succeeded, `value` what it answered; for a streaming action, once the stream is open.
  onData?: ((event: { value: Data, input: unknown }) => void) | undefined
  /** @deprecated Write `onData`, which hands `value` where this hands `data`. Removed in 1.108.0; `deprecated-source-readers` rewrites it. */
  onSuccess?: ((event: { data: Data, input: unknown }) => void) | undefined
  // A call failed, for a refusal and for no answer alike; not for an abort or a redirect.
  onError?: ((event: { error: ApiError, input: unknown }) => void) | undefined
}

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
// It resolves `{ ok: true, data }`, or what `refused` makes of an error the call threw, which rethrows when it returns undefined; an abort rethrows and is no failure. `holds` says a result is a stream, which counts as in flight until it ends, calling `release` then; `take` counts it in flight again, for a stream that is retried.
export function trackCalls<Args extends unknown[]>(
  call: (...args: Args) => Promise<unknown>,
  refused: (error: unknown) => ApiError | undefined,
  holds?: (data: unknown, release: () => void, take: () => void) => boolean,
  // An error that is no failure of the call, such as a redirect, which `status()`, `error()` and `retry()` leave alone (a retry would post a login or a checkout again).
  aside?: (error: unknown) => boolean,
  hooks?: TrackHooks<never>,
): ((...args: Args) => CallPromise<CallResult<unknown, unknown>>) & Reader<unknown, LoadStatus> & { settled: () => Promise<void> } & { onSuccess: (listener: (event: { data: unknown, input: unknown }) => void) => () => void } {
  const successes = listenerSet<{ data: unknown, input: unknown }>()
  const answers = listenerSet<{ value: unknown, input: unknown }>()
  const failures = listenerSet<{ error: ApiError, input: unknown }>()

  if (hooks?.onSuccess)
    successes.on(hooks.onSuccess as never)

  if (hooks?.onData)
    answers.on(hooks.onData as never)

  if (hooks?.onError)
    failures.on(hooks.onError)

  const [inFlight, setInFlight] = ownSignal(0)
  const [outcome, setOutcome] = ownSignal<LoadStatus>('idle')
  const [error, setError] = ownSignal<ApiError | undefined>(undefined)
  const [answer, setAnswer] = ownSignal<unknown>(undefined, { equals: false })
  const idle = whenIdle()
  let failedWith: Args | undefined
  const shift = (by: number) => {
    setInFlight(untrack(inFlight) + by)
    idle.check(untrack(inFlight))
  }

  const run = async (...args: Args): Promise<unknown> => {
    let streaming = false
    // The hook runs once the call is no longer in flight, so `pending()` is false in it and `retry()` works from it.
    let tell: (() => void) | undefined

    shift(1)

    try {
      const data = await call(...args)

      streaming = holds?.(data, () => shift(-1), () => shift(1)) ?? false
      setOutcome('ready')
      setError(undefined)
      setAnswer(data)
      tell = () => {
        answers.emit({ value: data, input: args[0] })
        successes.emit({ data, input: args[0] })
      }

      return data
    }
    catch (failure) {
      if (aside?.(failure) !== true && !args.some(signalAborted)) {
        const error = apiErrorOf(failure)

        failedWith = args
        setOutcome('failed')
        setError(error)
        tell = () => failures.emit({ error, input: args[0] })
      }

      throw failure
    }
    finally {
      if (!streaming)
        shift(-1)

      tell?.()
    }
  }

  // eslint-disable-next-line ts/promise-function-async -- an async function would wrap the call's promise, which carries `orThrow()`
  const answering = (...args: Args) => settling(run(...args), error => args.some(signalAborted) ? undefined : refused(error))

  return Object.assign(answering, {
    status: () => inFlight() > 0 ? 'loading' as const : outcome(),
    pending: () => inFlight() > 0,
    error,
    data: answer,
    onData: answers.on,
    onSuccess: successes.on,
    onError: failures.on,
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
