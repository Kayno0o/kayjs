import type { Lane, Start } from './action-run'
import type { Action, ActionErrorDetail, ActionStartDetail, ActionStream, ActionSuccessDetail, CallOptions, CallQueue, Outcome, TrackedCall } from './action-shared'
import type { ApiError } from './api-error'
import type { CallPromise, CallResult, TrackHooks } from './call-result'
import type { LoadStatus } from './live'
import { ActionError, ActionRedirectError } from './action-error'
import { PAYLOAD_PARAM, payloadQuery, withFields } from './action-form'
import { networkFailures, refusedAt, superseding } from './action-marks'
import { onStreamEnd } from './action-owner'
import { ACTION } from './action-shared'
import { actionFailed, failed, messageOf, unreachable } from './api-error'
import { withoutBase } from './base'
import { skew } from './build'
import { settling, signalAborted, trackCalls, whenIdle } from './call-result'
import { navigation } from './navigation'
import { released, undoable } from './optimistic'
import { pageData } from './page-data'
import { getOwner, liveOwner, onCleanup, ownSignal, untrack } from './reactive'
import { OUTCOME_SCRIPT } from './swap'
import { ACTION_PREFIX, ACTION_TYPE, decodeServerValue, FIXED_FIELDS, malformed, serverWritten } from './wire'

// Defined by the browser build, which never renders on the server: tested where it is read, so the bundler drops the server's code.
declare const KAY_BROWSER: true | undefined

export { OUTCOME_SCRIPT }

const QUERY = /\?.*/

const CODE_RETRIES = 2
// Once loaded, a call is made in the same task, as one made from `pagehide` must be: a dynamic import resolves a task later, when the page may be gone.
let running: typeof import('./action-run') | undefined
// The load the calls made before it ends share, so they go on in the order they were made.
let loading: Promise<typeof import('./action-run')> | undefined

// A property of the handle an action builds, readable and listed.
const read = (value: unknown) => ({ value, enumerable: true })

// On the server, the form post the request being answered carries: null for none, undefined outside a request.
let requestOutcome: (() => Outcome | null | undefined) | undefined

export function setRequestOutcome(read: () => Outcome | null | undefined): void {
  requestOutcome = read
}

// What a browser build exports in place of a server action.
export function actionStub(url: string, fixed?: Record<string, unknown>): Action<unknown, unknown> {
  const { reads, bound } = callable(() => url)

  warmCode()

  return stubWith(url, reads, bound, fixed)
}

type Bound = (fields: Record<string, unknown> | undefined) => { call: (input: never, options?: CallOptions) => CallPromise<CallResult<unknown, unknown>>, track: (handle?: { queue?: CallQueue } & TrackHooks<never>) => TrackedCall<never, unknown> }

// `with` adds to the fields fixed, so a call, `track()` and a form all carry them, a form posting to the URL holding them as it does on the server; its pending state and outcome stay the action's own.
function stubWith(url: string, reads: PropertyDescriptorMap, bound: Bound, fixed: Record<string, unknown> | undefined): Action<unknown, unknown> {
  const { call, track } = bound(fixed)

  return Object.defineProperties(call, {
    ...reads,
    track: { value: track, enumerable: true },
    url: { value: url, enumerable: true },
    [ACTION]: { value: true },
    with: { value: (fields: Record<string, unknown>) => stubWith(url, reads, bound, { ...fixed, ...fields }) },
    ...fixed && {
      formUrl: { value: `${url}?${PAYLOAD_PARAM}=${encodeURIComponent(payloadQuery(fixed))}` },
      [FIXED_FIELDS]: { value: fixed },
    },
  }) as unknown as Action<unknown, unknown>
}

// Called by the lazy chunk a page handing an island an action loads, so the props revive as callable stubs: only a URL under the actions' own path is one, whatever the text says.
export function reviveActions(): void {
  serverWritten[ACTION_TYPE] = (sent: string | [string, Record<string, unknown>]) => {
    const [url, fields] = Array.isArray(sent) ? sent : [sent]

    return typeof url === 'string' && url.startsWith(ACTION_PREFIX) && (fields === undefined || (typeof fields === 'object' && fields !== null && !Array.isArray(fields))) ? actionStub(url, fields) : malformed(sent, ACTION_TYPE)
  }
}

function statusOf(inFlight: number, found: Outcome | undefined, failed: object | undefined): LoadStatus {
  if (inFlight > 0)
    return 'loading'

  if (found?.succeeded)
    return 'ready'

  return failed === undefined ? 'idle' : 'failed'
}

// The post a page with islands was rendered in answer to, read again once a swap brings another page.
function pageOutcome(): Outcome | undefined {
  return typeof KAY_BROWSER === 'undefined' && typeof document === 'undefined' ? undefined : pageData<Outcome>(`script[${OUTCOME_SCRIPT}]`, decodeServerValue, true)[0]
}

// An `ownSignal` made when first read, as most actions are only called: what is written before holds as its value.
function lazySignal<T>(value: T): [read: () => T, write: (next: T) => void, peek: () => T] {
  let current = value
  let signal: ReturnType<typeof ownSignal<T>> | undefined

  return [() => (signal ??= ownSignal(current))[0](), (next) => {
    current = next
    signal?.[1](next)
  }, () => current]
}

// Checks a form against the action's schema in the browser, as the server would, and hands `show` the messages to read as a refusal's, undefined for none; one field checked replaces that field's message and leaves the others.
function validator(url: () => string, failed: () => { errors: Record<string, string> } | undefined, show: (errors: Record<string, string> | undefined) => unknown): (form: HTMLFormElement, field?: string) => Promise<boolean> {
  return async (form, field) => {
    const { fieldMessages } = await import('./validate')
    const found = fieldMessages(form, withoutBase(url()), field)

    if (found === undefined)
      return true

    const errors = field === undefined ? found : { ...Object.fromEntries(Object.entries(untrack(failed)?.errors ?? {}).filter(([name]) => name !== field)), ...found }

    show(Object.keys(errors).length === 0 ? undefined : errors)

    return field === undefined ? Object.keys(found).length === 0 : found[field] === undefined
  }
}

// Makes the call of an action, counting the ones in flight; a call that redirects rejects with `ActionRedirectError` once the browser is on its way, so the action stops being pending.
// How a post went is the request's on the server; in the browser the last call's once the page shown made one, else the post the page answers.
export function callable(url: () => string): { call: (input: never, options?: CallOptions) => CallPromise<CallResult<unknown, unknown>>, reads: PropertyDescriptorMap, bound: Bound } {
  const [inFlight, setInFlight, flying] = lazySignal(0)
  const [last, setLast] = lazySignal<{ page: number, outcome: Outcome | null } | undefined>(undefined)
  const [progress, setProgress] = lazySignal<number | undefined>(undefined)
  const idle = whenIdle()
  const shift = (by: number) => {
    setInFlight(flying() + by)
    idle.check(flying())
  }
  // The call started last owns the outcome, whichever finishes last.
  let started = 0
  const called = (page: number, outcome: Outcome | null, turn = started) => turn === started && setLast({ page, outcome })
  const outcome = () => {
    let found = requestOutcome?.()
    const own = last()

    if (found === undefined)
      found = own?.page === navigation.page ? own.outcome : pageOutcome()

    return found?.action === url() ? found : undefined
  }
  const failed = () => {
    const found = outcome()

    return found && !found.succeeded ? { status: found.status, message: messageOf({ status: found.status, errors: found.errors, data: found.data }, actionFailed(found.status)), values: found.values, errors: found.errors, data: found.data } : undefined
  }
  const error = (field = '') => failed()?.errors[field]
  const validate = validator(url, failed, errors => called(navigation.page, errors === undefined ? null : { action: url(), status: 422, values: {}, errors, data: undefined }))
  const host = { url, shift, called, progress: setProgress, latest: (turn: number) => turn === started }

  // The state a call changes is the action's own and is read from the first paint, so a call counts itself in flight at once and hands the rest to the code that runs it, which loads with the first call.
  const run = async (lane: Lane, input: unknown, fixed: Record<string, unknown> | undefined, options?: CallOptions) => {
    const start: Start = { page: navigation.page, visits: navigation.visits, caller: { owner: liveOwner(getOwner()), arrivals: navigation.arrivals }, turn: ++started }

    shift(1)
    called(start.page, null)

    let code: typeof import('./action-run')
    let attempt: typeof loading

    try {
      // An optimistic change shows at once, as the call is pending at once.
      start.undo = options?.optimistic ? undoable(options.optimistic) : undefined
      code = running ?? await (attempt = loading ??= runCode())
    }
    catch (error) {
      if (loading === attempt)
        loading = undefined

      if (start.undo) {
        start.undo()
        released(start.undo)
      }

      shift(-1)

      if (host.latest(start.turn))
        setProgress(undefined)

      throw error
    }

    return code.run(host, start, lane, input, fixed, options)
  }

  const bound = binder(run, url)
  const { call, track } = bound(undefined)

  return {
    call,
    bound,
    reads: {
      pending: read(() => inFlight() > 0),
      settled: read(async () => idle.wait(flying())),
      ...formHooks(url),
      progress: read(progress),
      form: read({ failed, error, validate }),,
      data: read(() => outcome()?.succeeded ? outcome()?.data : undefined),
      status: read(() => statusOf(inFlight(), outcome(), failed())),
      refused: read((error: unknown) => error instanceof ActionError && refusedAt.get(error) === url()),
      track: read(track),
      with: read((fields: Record<string, unknown>) => withFields(call, fields)),
    },
  }
}

// `onStart`, `onData` and `onError` of an action, for the posts its forms make in place.
function formHooks(url: () => string): Record<string, object> {
  return {
    onStart: read(formHook<ActionStartDetail, { input: FormData }>(url, 'start', ({ data }) => ({ input: data }))),
    onData: read(formHook<ActionSuccessDetail, { input: FormData }>(url, 'success', ({ data }) => ({ input: data }))),
    onError: read(formHook<ActionErrorDetail, { input: FormData, error: ActionError }>(url, 'error', ({ data, status, errors }) => ({ input: data, error: new ActionError(status, '', errors) }))),
  }
}

// The hook of one step of the posts a form of this action makes in place: the `kay:action-<step>` events its `form(action={...})` fires, which bubble to `document`, told as an object of the hook's own. A throw is logged, and the island's end removes it.
function formHook<Detail extends { action: string }, Told>(url: () => string, step: 'start' | 'success' | 'error', told: (detail: Detail) => Told): (listener: (event: Told) => void) => () => void {
  return (listener) => {
    if (typeof document === 'undefined')
      return () => undefined

    const type = `kay:action-${step}`
    const heard = (event: Event) => {
      const detail = (event as CustomEvent<Detail>).detail

      // The URL of an action holding fixed fields carries them as a query the event's `action` leaves out.
      if (detail.action !== withoutBase(url()).replace(QUERY, ''))
        return

      try {
        listener(told(detail))
      }
      catch (error) {
        console.error(error)
      }
    }
    const stop = () => document.removeEventListener(type, heard)

    document.addEventListener(type, heard)
    onCleanup(stop)

    return stop
  }
}

// A call and `track()` carrying the fields given, over one action's state: a `with` of the action follows the same calls.
function binder(run: (lane: Lane, input: unknown, fixed: Record<string, unknown> | undefined, options?: CallOptions) => Promise<unknown>, url: () => string): Bound {
  const actionLane: Lane = { tail: Promise.resolve() }

  return fields => ({
    // eslint-disable-next-line ts/promise-function-async -- an async function would wrap the call's promise, which carries `orThrow()`
    call: (input: unknown, options?: CallOptions) => settling(run(actionLane, input, fields, options), error => signalAborted(options) ? undefined : refusalOf(url)(error)),
    track: (handle) => {
      const lane: Lane = { tail: Promise.resolve(), queue: handle?.queue }

      return tracked(async (input, options) => run(lane, input, fields, options), url, handle)
    },
  })
}

// What a call that failed answers: the refusal of this action, or a failure with no answer (status 0, the network's or a timeout's). An abort, a redirect and what is thrown before the post is sent are no failure of the call, and reject as they are thrown.
function refusalOf(url: () => string): (error: unknown) => ApiError | undefined {
  return (error) => {
    if (error instanceof ActionRedirectError || superseding.has(error as object))
      return undefined

    if (error instanceof ActionError)
      return refusedAt.get(error) === url() ? error : undefined

    const name = (error as { name?: unknown } | null)?.name

    if (name === 'TimeoutError' || (name !== 'AbortError' && networkFailures.has(error as object)))
      return name === 'TimeoutError' ? failed(0, (error as Error).message, error) : unreachable(error)

    return undefined
  }
}

// A handle over `call` whose refusals of this action it answers as results.
function tracked(call: (input: never, options?: CallOptions) => Promise<unknown>, url: () => string, hooks?: TrackHooks<never>): TrackedCall<never, unknown> {
  return trackCalls(
    call as (input: unknown, options?: CallOptions) => Promise<unknown>,
    refusalOf(url),
    (data, release, take) => {
      const held = onStreamEnd(data, release)

      // A stream retried is in flight again until it ends once more: `take()` first, as the end that follows may come at once.
      if (held) {
        (data as ActionStream<unknown>).onOpen(() => {
          take()
          onStreamEnd(data, release)
        })
      }

      return held
    },
    error => error instanceof ActionRedirectError || superseding.has(error as object),
    hooks,
  ) as unknown as TrackedCall<never, unknown>
}

let warming = false

// An island holding an action caller loads the code running a call once the browser is idle, so a call made as the page goes away (`pagehide`, which cannot wait for a chunk) finds it in; it stays out of the first load. A failure is left for the call itself to retry and report, so an idle load never reloads the page.
function warmCode(): void {
  if (warming || typeof window === 'undefined')
    return

  warming = true

  const load = async () => {
    try {
      running = await import('./action-run')
    }
    catch {}
  }

  if (typeof requestIdleCallback === 'function')
    requestIdleCallback(() => void load())
  else
    setTimeout(() => void load(), 200)
}

// A flaky connection gets the chunk retried after 1 s and 3 s, as a lazy component's is. The code that runs a call, loaded by the first call; a chunk a deploy removed asks the server whether the build changed, which reloads the page, and the call fails as any call that could not be sent.
async function runCode(): Promise<typeof import('./action-run')> {
  for (let attempt = 0; ; attempt++) {
    try {
      return running = await import('./action-run')
    }
    catch (error) {
      if (attempt >= CODE_RETRIES) {
        await skew()

        throw error
      }

      await new Promise(done => setTimeout(done, 1000 * (attempt * 2 + 1)))
    }
  }
}
