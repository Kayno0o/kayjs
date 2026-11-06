import type { Caller } from './action-owner'
import type { Action, ActionStream, CallOptions, CallQueue, Outcome, Refreshable, TrackedCall } from './action-shared'
import type { Duration } from './duration'
import { encodeCall } from './action-encode'
import { ActionError, ActionRedirectError } from './action-error'
import { withFields } from './action-form'
import { closeWithCaller, onStreamEnd, SETTLED } from './action-owner'
import { ACTION } from './action-shared'
import { actionFailed, apiErrorOf, messageOf } from './api-error'
import { withBase, withoutBase } from './base'
import { skew } from './build'
import { trackCalls, whenIdle } from './call-result'
import { durationSeconds, isZeroDuration } from './duration'
import { leave, mayLeave, navigation, prefetched } from './navigation'
import { pageData } from './page-data'
import { randomId } from './random-id'
import { getOwner, liveOwner, ownSignal, released, undoable, untrack } from './reactive'
import { reload } from './stale'
import { FAILURE_HEADER, OUTCOME_SCRIPT, PAGE_HEADER, REDIRECT_HEADER, WORK_HEADER, WORK_SCRIPT } from './swap'
import { ACTION_PREFIX, ACTION_TYPE, decodeServerValue, malformed, serverWritten } from './wire'

// Defined by the browser build, which never renders on the server: tested where it is read, so the bundler drops the server's code.
declare const KAY_BROWSER: true | undefined

export { OUTCOME_SCRIPT }

const HTTP_PROTOCOLS = new Set(['http:', 'https:'])
const RETRY_DELAY_MS = 500
// The reasons of the aborts a `latest` call makes of the earlier ones, which are no failure of a `track()` handle.
const superseding = new WeakSet<object>()
// The errors of a post that failed in the network, as opposed to one thrown before it was sent (an encoding, a redirect to a page that is none).
const networkFailures = new WeakSet<object>()

function idempotencyKey(): string {
  return randomId()
}

// The calls of an action, or of one `track()` handle, that `queue` orders: `tail` settles when the last `serial` call is done, `latest` is the call in flight a newer one aborts.
interface Lane {
  tail: Promise<unknown>
  queue?: CallQueue | undefined
  latest?: AbortController | undefined
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

// On the server, the form post the request being answered carries: null for none, undefined outside a request.
let requestOutcome: (() => Outcome | null | undefined) | undefined

export function setRequestOutcome(read: () => Outcome | null | undefined): void {
  requestOutcome = read
}

// What a browser build exports in place of a server action.
export function actionStub(url: string): Action<unknown, unknown> {
  const { call, reads } = callable(() => url)

  return Object.defineProperties(call, {
    ...reads,
    url: { value: url, enumerable: true },
    [ACTION]: { value: true },
  }) as unknown as Action<unknown, unknown>
}

// Called by the lazy chunk a page handing an island an action loads, so the props revive as callable stubs: only a URL under the actions' own path is one, whatever the text says.
export function reviveActions(): void {
  serverWritten[ACTION_TYPE] = (url: string) => typeof url === 'string' && url.startsWith(ACTION_PREFIX) ? actionStub(url) : malformed(url, ACTION_TYPE)
}

// The post a page with islands was rendered in answer to, read again once a swap brings another page.
// The action URL each refused call was made to, which `refused` matches.
const refusedAt = new WeakMap<ActionError, string>()

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

// Posts a call, counting the ones in flight; a call that redirects never settles, so the action stays pending while the page goes, unless the visitor stays or already went elsewhere.
// How a post went is the request's on the server; in the browser the last call's once the page shown made one, else the post the page answers.
export function callable(url: () => string): { call: (input: never, options?: CallOptions) => Promise<unknown>, reads: PropertyDescriptorMap } {
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
  const read = (value: unknown) => ({ value, enumerable: true })

  const actionLane: Lane = { tail: Promise.resolve() }

  const run = async (lane: Lane, input: unknown, options?: CallOptions) => {
    // The page the call was made on, whose outcome it is even once the visitor went elsewhere.
    const page = navigation.page
    const visits = navigation.visits
    const left = () => navigation.visits !== visits
    // The island calling, from its setup or a handler, whose end ends a stream the call answers with; else the page, as long as no other path is shown.
    const caller: Caller = { owner: liveOwner(getOwner()), arrivals: navigation.arrivals }
    const mode = options?.queue ?? lane.queue ?? 'parallel'

    const turn = ++started

    shift(1)
    called(page, null)
    void hooked(options?.onStart, { input })

    let undo: (() => void) | undefined
    let posted = false
    let sent = false
    let timedOut = false
    // A stream keeps the call in flight until it ends.
    let streaming = false
    let answer: unknown
    let failure: unknown
    let release: (() => void) | undefined
    // Started before the caller goes on, so a navigation it starts next supersedes the refresh rather than the other way round; a site with `navigation: false` shows a call's effects itself.
    const refreshPage = () => {
      const scope = options?.refresh

      if (scope === false || left())
        return

      if (scope === undefined || scope === true) {
        if (navigation.hooks)
          void refreshed()
      }
      else {
        const asked = [scope].flat()
        const names = asked.filter(source => typeof source === 'string')

        if (names.length > 0 && navigation.hooks)
          void refreshed(names)

        void refreshedIn(asked.filter(source => typeof source !== 'string'))
      }
    }
    const later = mode === 'latest' ? new AbortController() : undefined
    // What aborts the call as a whole: its own signal, and a later call of a `latest` queue, which stops mattering once the post is answered.
    const whole = join([options?.signal, later?.signal], later !== undefined)
    const timeoutOption = options?.timeout
    const timeout = waitOf(timeoutOption, 'timeout')

    try {
      undo = options?.optimistic ? undoable(options.optimistic) : undefined

      if (later) {
        const reason = new DOMException('Superseded by a later call', 'AbortError')

        superseding.add(reason)
        lane.latest?.abort(reason)
        lane.latest = later
      }

      if (mode === 'serial') {
        const before = lane.tail

        lane.tail = Promise.all([before, new Promise<void>((resolve) => {
          release = resolve
        })])
        await waitFor(before, whole.signal)
      }

      const attempts = retryOf(options?.retry)
      // One key for every try of the call, which a handler reads from `ctx.request` to tell a repeat from a new call.
      const key = attempts.times > 0 ? idempotencyKey() : undefined

      for (let attempt = 0; ; attempt++) {
        // The wait for the answer counts from the moment the post is sent, and each try has its own.
        const limit = timeout === undefined ? undefined : new AbortController()
        const attemptSignal = join([whole.signal, limit?.signal])
        let timer: ReturnType<typeof setTimeout> | undefined
        let sentNow = false

        try {
          answer = await post(url(), input, setProgress, attemptSignal.signal, () => {
            sent = sentNow = true
            clearTimeout(timer)
            timer = limit && setTimeout(() => {
              timedOut = true
              limit.abort(new DOMException(`The server did not answer within ${String(timeoutOption)}`, 'TimeoutError'))
            }, timeout)
          }, left, caller, key === undefined ? options?.headers : { 'idempotency-key': key, ...options?.headers })

          break
        }
        catch (error) {
          // Only the upload path says `sent: false`, as `fetch` gives no such signal and `onSent` has run before it: the default retry of an unsent post covers an upload alone.
          if (attempt >= attempts.times || whole.signal?.aborted === true || !attempts.again(error, sentNow && (error as { sent?: unknown } | null)?.sent !== false))
            throw error

          await waitFor(attempts.delay * 2 ** attempt, whole.signal)
        }
        finally {
          clearTimeout(timer)
          attemptSignal.stop()
        }
      }

      posted = true
      whole.stop(later?.signal)
      release?.()
      release = undefined

      streaming = onStreamEnd(answer, (status) => {
        if (status === 'done') {
          called(page, { action: url(), succeeded: true, data: untrack((answer as ActionStream<unknown>).last) }, turn)
          refreshPage()
        }

        shift(-1)
      })

      if (!streaming) {
        called(page, { action: url(), succeeded: true, data: answer }, turn)
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
      if (sent && (options?.signal?.aborted === true || timedOut))
        refreshPage()

      if (error instanceof ActionError && !(error instanceof ActionRedirectError))
        called(page, { action: url(), status: error.status, values: {}, errors: error.errors, data: error.data }, turn)

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
        shift(-1)

      if (turn === started)
        setProgress(undefined)

      if (lane.latest === later)
        lane.latest = undefined

      void hooked(options?.onSettled, failure === undefined ? { data: answer } : { error: apiErrorOf(failure) })
    }
  }

  const call = async (input: unknown, options?: CallOptions) => run(actionLane, input, options)

  return {
    call,
    reads: {
      pending: read(() => inFlight() > 0),
      settled: read(async () => idle.wait(flying())),
      progress: read(progress),
      failed: read(failed),
      succeeded: read(() => {
        const found = outcome()

        return found?.succeeded ? { data: found.data } : undefined
      }),
      error: read((field = '') => failed()?.errors[field]),
      validate: read(async (form: HTMLFormElement, field?: string) => {
        const { fieldMessages } = await import('./validate')
        const found = fieldMessages(form, withoutBase(url()), field)

        if (found === undefined)
          return true

        // One field checked replaces that field's message and leaves the others.
        const errors = field === undefined ? found : { ...Object.fromEntries(Object.entries(untrack(failed)?.errors ?? {}).filter(([name]) => name !== field)), ...found }

        called(navigation.page, Object.keys(errors).length === 0 ? null : { action: url(), status: 422, values: {}, errors, data: undefined })

        return field === undefined ? Object.keys(found).length === 0 : found[field] === undefined
      }),
      refused: read((error: unknown) => error instanceof ActionError && refusedAt.get(error) === url()),
      track: read((handle?: { queue?: CallQueue }) => {
        const lane: Lane = { tail: Promise.resolve(), queue: handle?.queue }

        return tracked(async (input, options) => run(lane, input, options), url)
      }),
      with: read((fields: Record<string, unknown>) => withFields(call, fields)),
    },
  }
}

// A handle over `call` whose refusals of this action it answers as results.
function tracked(call: (input: never, options?: CallOptions) => Promise<unknown>, url: () => string): TrackedCall<never, unknown> {
  return trackCalls(
    call as (input: unknown, options?: CallOptions) => Promise<unknown>,
    error => !(error instanceof ActionError) || error instanceof ActionRedirectError || refusedAt.get(error) !== url() ? undefined : { ok: false, status: error.status, message: error.message, errors: error.errors, data: error.data },
    (data, release) => onStreamEnd(data, release),
    error => error instanceof ActionRedirectError || superseding.has(error as object),
  )
}

async function post<Output>(url: string, input: unknown, onProgress: (sent: number) => void, signal: AbortSignal | undefined, onSent: () => void, left: () => boolean, caller: Caller, extra?: Record<string, string>): Promise<Output> {
  const { headers, body } = encodeCall(input)
  const sent: Record<string, string> = { ...extra, ...headers }

  // A test or a script calling it has no page.
  if (typeof location !== 'undefined')
    sent[PAGE_HEADER] = location.pathname + location.search

  // fetch tells nothing of an upload's progress, which a call carrying files reports.
  const send = async (solution: string | undefined) => {
    const headers = solution === undefined ? sent : { ...sent, [WORK_HEADER]: solution }

    const files = body instanceof FormData && typeof XMLHttpRequest !== 'undefined' ? body : undefined
    // Loaded before the call counts as sent, as an abort while it loads sends nothing.
    const upload = files && await import('./upload')

    // A signal aborted already sends nothing.
    if (signal?.aborted !== true)
      onSent()

    try {
      return await (files && upload ? upload.uploaded('POST', withBase(url), headers, files, onProgress, signal) : fetch(withBase(url), { method: 'POST', headers, body, ...signal && { signal } }))
    }
    catch (error) {
      if (typeof error === 'object' && error !== null)
        networkFailures.add(error)

      throw error
    }
  }

  let response: Response

  try {
    // A page holding a challenge for the action solves it from the moment one of its forms takes focus.
    response = await send(typeof document !== 'undefined' && document.querySelector(`script[${WORK_SCRIPT}]`) ? await (await import('./work.client')).spendWork(url) : undefined)

    const challenge = response.status === 422 ? response.headers.get(WORK_HEADER) : null

    // A call with no challenge to solve, or a stale one, is answered a fresh one, and goes again with its solution.
    if (challenge !== null)
      response = await send(await (await import('./work.client')).spendWork(url, challenge))
  }
  finally {
    // Pages prefetched while it was out, or once it ran whatever the answer, show what it changed no more than the ones before it.
    prefetched.clear()
  }

  void skew(response)

  return readActionResponse(response, url, left, caller)
}

// What a call to `action` got back: the handler's result, or an `ActionError` with the refused fields and the failure data.
// `left` tells whether the visitor went to another page since the call was made, which a redirect then no longer takes them from; a stream closes with the island that called, else once another path is shown.
export async function readActionResponse<Output>(response: Response, action: string, left?: () => boolean, caller?: Caller): Promise<Output> {
  const target = response.headers.get(REDIRECT_HEADER)

  if (target !== null) {
    if (typeof KAY_BROWSER === 'undefined' && typeof window === 'undefined')
      throw new ActionRedirectError(response.status, target)

    // Only a page goes there: a `javascript:` target would run in this one.
    if (!HTTP_PROTOCOLS.has(new URL(target, window.location.href).protocol))
      throw new TypeError(`kay: the action redirected to ${JSON.stringify(target)}, which is no page`)

    if (left?.() === true)
      throw new ActionRedirectError(response.status, target)

    // The page goes away, so whatever awaited the call never resumes; a leave guard keeping the visitor here settles it instead.
    if (await goTo(target))
      return new Promise<never>(() => undefined)

    throw new ActionRedirectError(response.status, target)
  }

  // Loaded only once an action streams, so a page calling none does not carry it.
  if (response.ok && response.headers.get('content-type')?.startsWith('text/event-stream') === true) {
    const stream = (await import('./action-stream')).actionStream(response, SETTLED, () => new ActionError(500, '', {}, undefined, `The stream of ${action} failed after its first value`))

    closeWithCaller(stream, caller)

    return stream as Output
  }

  const body = await response.text()

  if (!response.ok) {
    const failed = response.headers.get(FAILURE_HEADER) === null ? {} : decodeServerValue(body) as { errors?: Record<string, string>, data?: unknown }

    const error = new ActionError(response.status, body, failed.errors, failed.data)

    refusedAt.set(error, action)

    throw error
  }

  return (body === '' ? undefined : decodeServerValue(body)) as Output
}

// The code of `navigate()` and `refresh()`, loaded on first use; a chunk a deploy removed asks the server whether the build changed, which reloads the page; undefined means the code is unavailable.
async function navigateApi(): Promise<typeof import('./navigate-api') | undefined> {
  try {
    return await import('./navigate-api')
  }
  catch {
    await skew()

    return undefined
  }
}

// The page's loads again through the swap, unless the visitor or the app went elsewhere while its code loaded, as a refresh started before them would have given way to them.
// Without the swap's code the page reloads, as a deploy's would, so an action's effect still shows; a reload that would lose what was typed, or came within the minute, leaves the page and the next link loads in full.
async function refreshed(loads?: readonly string[]): Promise<void> {
  const [navigations, visits] = [navigation.navigations, navigation.visits]
  const api = await navigateApi()

  if (navigation.navigations !== navigations || navigation.visits !== visits)
    return

  if (api)
    await api.refresh(loads)
  else
    reload()
}

// What a call limited its refresh to, `refresh()`ed together; one that throws or fails is that source's to show.
async function refreshedIn(sources: readonly Refreshable[]): Promise<void> {
  await Promise.allSettled(sources.map(async (source) => {
    await source.refresh()
  }))
}

// Through the swap once it took over the app's links; a site with `navigation: false` loads the page, asking the leave guards first as `navigate()` would.
// Whether the page went, or a leave guard kept the visitor on it.
async function goTo(target: string): Promise<boolean> {
  const api = navigation.hooks ? await navigateApi() : undefined

  if (api) {
    const [before, released] = [navigation.current, navigation.released]

    await api.navigateTo(target, {}, false)

    return navigation.current !== before || (!released && navigation.released)
  }

  const url = new URL(target, location.href)

  if (!await mayLeave(url, false))
    return false

  leave(url)

  return true
}
