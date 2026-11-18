import type { Caller } from './action-owner'
import type { ActionStream, CallOptions, CallQueue, Outcome } from './action-shared'
import type { Duration } from './duration'
import type { ConnectionStatus } from './live'
import { ActionError, ActionRedirectError } from './action-error'
import { networkFailures, superseding } from './action-marks'
import { refreshed, refreshedIn, refreshedUnlessFollowed } from './action-navigate'
import { onStreamEnd, SETTLED } from './action-owner'
import { post } from './action-post'
import { apiErrorOf } from './api-error'
import { durationSeconds, isZeroDuration } from './duration'
import { navigation } from './navigation'
import { released, undoable } from './optimistic'
import { randomId } from './random-id'
import { untrack } from './reactive'

// What runs a call of an action: its queue, timeout and retries, the post and what follows the answer. An action shows its state to a page before any call, so that part stays with the action (`action-call.ts`) and a page that calls nothing does not carry this one, which the first call loads.

const RETRY_DELAY_MS = 500

// The calls of an action, or of one `track()` handle, that `queue` orders: `tail` settles when the last `serial` call is done, `latest` is the call in flight a newer one aborts.
export interface Lane {
  tail: Promise<unknown>
  queue?: CallQueue | undefined
  latest?: AbortController | undefined
}

// What the action keeps for a call to change: its URL, the calls in flight, the outcome of the last call and the progress of an upload.
export interface Host {
  url: () => string
  shift: (by: number) => void
  called: (page: number, outcome: Outcome | null, turn: number) => unknown
  progress: (sent: number | undefined) => void
  // Whether the call numbered `turn` is the one started last, which owns the outcome and the progress.
  latest: (turn: number) => boolean
}

// What the call captured when it was made, before this code was loaded: the page it was made on, the visits so far, who called, and its number.
export interface Start {
  page: number
  visits: number | undefined
  caller: Caller
  turn: number
}

function idempotencyKey(): string {
  return randomId()
}

// One signal for several, aborting with the reason of the first to abort. A lone one is returned as it is, so a browser that has no `AbortSignal.any` still runs the call; `stop` lets go of the listeners, and `always` makes a signal of its own whose sources can be let go of before the call ends.
function join(sources: (AbortSignal | undefined)[], always = false): { signal: AbortSignal | undefined, stop: (only?: AbortSignal) => void } {
  const list = sources.filter(source => source !== undefined)

  if (list.length < 2 && !always)
    return { signal: list[0], stop: () => undefined }

  const controller = new AbortController()
  const forwards = list.map(source => [source, () => controller.abort(source.reason)] as const)

  for (const [source, forward] of forwards) {
    if (source.aborted) {
      controller.abort(source.reason)

      break
    }

    source.addEventListener('abort', forward, { once: true })
  }

  return {
    signal: controller.signal,
    stop: (only) => {
      for (const [source, forward] of forwards) {
        if (only === undefined || only === source)
          source.removeEventListener('abort', forward)
      }
    },
  }
}

// Waits for `ms`, or for the calls ahead when given a promise, giving up at once when the signal aborts meanwhile.
async function waitFor(wait: number | Promise<unknown>, signal: AbortSignal | undefined): Promise<void> {
  signal?.throwIfAborted()

  let stop = () => undefined as void

  try {
    await new Promise<unknown>((resolve, reject) => {
      const abort = () => reject(signal!.reason)
      const id = typeof wait === 'number' ? setTimeout(resolve, wait) : undefined

      if (typeof wait !== 'number') {
        void (async () => {
          try {
            resolve(await wait)
          }
          catch (error) {
            reject(error)
          }
        })()
      }

      signal?.addEventListener('abort', abort, { once: true })
      stop = () => {
        clearTimeout(id)
        signal?.removeEventListener('abort', abort)
      }
    })
  }
  finally {
    stop()
  }
}

// How long a wait of the call's lasts: nothing for a zero, a clear error for text that is no duration.
function waitOf(value: Duration | undefined, what: string): number | undefined {
  return value === undefined || isZeroDuration(value) ? undefined : durationSeconds(value, what) * 1000
}

// Whether a failure is one a retry may repeat: the server's answer or the network's failure, never a redirect, an abort or something thrown before the post was sent. Unless `when` says otherwise, a 503 (the server turned the call away) and a failure before the post was sent are, and nothing else, as a post that reached the server may have run.
function retryOf(retry: CallOptions['retry']): { times: number, delay: number, again: (error: unknown, sent: boolean) => boolean } {
  const options = typeof retry === 'number' ? { times: retry } : retry

  return {
    times: options?.times ?? 0,
    delay: waitOf(options?.delay, 'retry.delay') ?? RETRY_DELAY_MS,
    again: (error, sent) => {
      if (error instanceof ActionRedirectError || !(error instanceof ActionError || networkFailures.has(error as object) || (error as { name?: unknown } | null)?.name === 'TimeoutError'))
        return false

      const failure = apiErrorOf(error)

      return options?.when ? options.when(failure) : failure.status === 503 || (!sent && (failure.status === 0 || failure.status === 502))
    },
  }
}

// A hook never fails the call it observes: a throw, or a rejection, is logged.
async function hooked<Event>(hook: ((event: Event) => unknown) | undefined, event: Event): Promise<void> {
  try {
    await hook?.(event)
  }
  catch (error) {
    console.error(error)
  }
}

// A call of an action `with()` fixed fields of is made with them, over the ones it is given, as a form posting to its URL does: a field fixed to `null` or `undefined` is left out there, so the given one stays.
function withFixed(input: unknown, fixed: Record<string, unknown> | undefined): unknown {
  if (fixed === undefined)
    return input

  const set = Object.entries(fixed).filter(([name, value]) => name !== '__proto__' && value !== undefined && value !== null)

  if (!(input instanceof FormData))
    return { ...input as object | undefined, ...Object.fromEntries(set) }

  const names = new Set(set.map(([name]) => name))
  const copy = new FormData()

  for (const [name, value] of input) {
    if (!names.has(name))
      copy.append(name, value)
  }

  for (const [name, value] of set) {
    for (const item of Array.isArray(value) ? value : [value])
      copy.append(name, item instanceof Date ? item.toISOString() : String(item))
  }

  return copy
}

// Refreshes what a call changed once it is done, started before the caller goes on, so a navigation it starts next supersedes the refresh rather than the other way round; a site with `navigation: false` shows a call's effects itself.
function refresher(options: CallOptions | undefined, caller: Caller, left: () => boolean): () => void {
  return () => {
    const scope = options?.refresh

    if (scope === false || left())
      return

    if (scope === undefined || scope === true) {
      if (navigation.hooks)
        void (scope === true ? refreshed() : refreshedUnlessFollowed(caller.invalidated))
    }
    else {
      const asked = [scope].flat()
      const names = asked.filter(source => typeof source === 'string')

      if (names.length > 0 && navigation.hooks)
        void refreshed(names)

      void refreshedIn(asked.filter(source => typeof source !== 'string'))
    }
  }
}

// Posts the call, again as its retry option allows. What the post found out of the call's own, whether it was sent and whether its timeout passed, is left in `flags`.
async function postTries(host: Host, input: unknown, options: CallOptions | undefined, signal: AbortSignal | undefined, caller: Caller, left: () => boolean, flags: { sent: boolean, timedOut: boolean }): Promise<unknown> {
  const timeoutOption = options?.timeout
  const timeout = waitOf(timeoutOption, 'timeout')
  const attempts = retryOf(options?.retry)
  // One key for every try of the call, which a handler reads from `ctx.request` to tell a repeat from a new call.
  const key = attempts.times > 0 ? idempotencyKey() : undefined

  for (let attempt = 0; ; attempt++) {
    // The wait for the answer counts from the moment the post is sent, and each try has its own.
    const limit = timeout === undefined ? undefined : new AbortController()
    const attemptSignal = join([signal, limit?.signal])
    let timer: ReturnType<typeof setTimeout> | undefined
    let sentNow = false

    try {
      return await post(host.url(), input, host.progress, attemptSignal.signal, () => {
        flags.sent = sentNow = true
        clearTimeout(timer)
        timer = limit && setTimeout(() => {
          flags.timedOut = true
          limit.abort(new DOMException(`The action call timeout of ${String(timeoutOption)} passed before the server answered`, 'TimeoutError'))
        }, timeout)
      }, left, caller, { key, options })
    }
    catch (error) {
      // Only the upload path says `sent: false`, as `fetch` gives no such signal and `onSent` has run before it: the default retry of an unsent post covers an upload alone.
      if (attempt >= attempts.times || signal?.aborted === true || !attempts.again(error, sentNow && (error as { sent?: unknown } | null)?.sent !== false))
        throw error

      await waitFor(attempts.delay * 2 ** attempt, signal)
    }
    finally {
      clearTimeout(timer)
      attemptSignal.stop()
    }
  }
}

// A call of a `latest` queue aborts the one in flight before it.
function supersede(lane: Lane, later: AbortController): void {
  const reason = new DOMException('Superseded by a later call', 'AbortError')

  superseding.add(reason)
  lane.latest?.abort(reason)
  lane.latest = later
}

// Runs a call in its lane, counting it in flight until it settles.
export async function run(host: Host, start: Start, lane: Lane, given: unknown, fixed: Record<string, unknown> | undefined, options?: CallOptions): Promise<unknown> {
  const { page, visits, caller, turn } = start
  const input = withFixed(given, fixed)
  const left = () => navigation.visits !== visits
  const mode = options?.queue ?? lane.queue ?? 'parallel'

  void hooked(options?.onStart, { input })

  let undo: (() => void) | undefined
  let posted = false
  const flags = { sent: false, timedOut: false }
  // A stream keeps the call in flight until it ends.
  let streaming = false
  let answer: unknown
  let failure: unknown
  let release: (() => void) | undefined
  const refreshPage = refresher(options, caller, left)
  const later = mode === 'latest' ? new AbortController() : undefined
  // What aborts the call as a whole: its own signal, and a later call of a `latest` queue, which stops mattering once the post is answered.
  const whole = join([options?.signal, later?.signal], later !== undefined)

  try {
    undo = options?.optimistic ? undoable(options.optimistic) : undefined

    if (later)
      supersede(lane, later)

    if (mode === 'serial') {
      const before = lane.tail

      lane.tail = Promise.all([before, new Promise<void>((resolve) => {
        release = resolve
      })])
      await waitFor(before, whole.signal)
    }

    answer = await postTries(host, input, options, whole.signal, caller, left, flags)

    posted = true
    whole.stop(later?.signal)
    release?.()
    release = undefined

    const streamEnded = (status: ConnectionStatus) => {
      if (status === 'done') {
        host.called(page, { action: host.url(), succeeded: true, data: untrack((answer as ActionStream<unknown>).last) }, turn)
        refreshPage()
      }

      host.shift(-1)
    }

    streaming = onStreamEnd(answer, streamEnded)

    if (streaming) {
      // A retry of the stream is the call running again.
      caller.retried = (again) => {
        host.shift(1)
        again[SETTLED](streamEnded)
      }
    }

    if (!streaming) {
      host.called(page, { action: host.url(), succeeded: true, data: answer }, turn)
      refreshPage()
    }

    void hooked(options?.onSuccess, { data: answer })

    return answer
  }
  catch (error) {
    failure = error

    // A redirect leaves the page as it is until the next one shows.
    if (!posted && !(error instanceof ActionRedirectError))
      undo?.()

    // The server may have run a call aborted or timed out once it was sent, which the page then shows as it stands.
    if (flags.sent && (options?.signal?.aborted === true || flags.timedOut))
      refreshPage()

    if (error instanceof ActionError && !(error instanceof ActionRedirectError))
      host.called(page, { action: host.url(), status: error.status, values: {}, errors: error.errors, data: error.data }, turn)

    if (!(error instanceof ActionRedirectError) && whole.signal?.aborted !== true)
      void hooked(options?.onError, { error: apiErrorOf(error) })

    throw error
  }
  finally {
    // A stream is aborted by the call's own signal until it ends.
    if (!streaming)
      whole.stop()

    release?.()

    if (undo)
      released(undo)

    if (!streaming)
      host.shift(-1)

    if (host.latest(turn))
      host.progress(undefined)

    if (lane.latest === later)
      lane.latest = undefined

    void hooked(options?.onSettled, failure === undefined ? { data: answer } : { error: apiErrorOf(failure) })
  }
}
