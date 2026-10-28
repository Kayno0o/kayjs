import type { Caller } from './action-owner'
import type { Action, ActionStream, CallOptions, Outcome, TrackedCall } from './action-shared'
import { encodeCall } from './action-encode'
import { ActionError, ActionRedirectError } from './action-error'
import { withFields } from './action-form'
import { closeWithCaller, onStreamEnd, SETTLED } from './action-owner'
import { ACTION } from './action-shared'
import { withBase } from './base'
import { skew } from './build'
import { trackCalls, whenIdle } from './call-result'
import { leave, mayLeave, navigation, prefetched } from './navigation'
import { pageData } from './page-data'
import { getOwner, liveOwner, ownSignal, undoable, untrack } from './reactive'
import { reload } from './stale'
import { FAILURE_HEADER, PAGE_HEADER, REDIRECT_HEADER, WORK_HEADER, WORK_SCRIPT } from './swap'
import { ACTION_PREFIX, ACTION_TYPE, decodeServerValue, malformed, serverWritten } from './wire'

// Defined by the browser build, which never renders on the server: tested where it is read, so the bundler drops the server's code.
declare const KAY_BROWSER: true | undefined

// Where the server writes the post a page with islands was rendered in answer to.
export const OUTCOME_SCRIPT = 'data-kay-outcome'

const HTTP_PROTOCOLS = new Set(['http:', 'https:'])

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

// Called by the chunk of an island that types a prop as an action, so the props a page passes it revive as callable stubs: only a URL under the actions' own path is one, whatever the text says.
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

    return found && !found.succeeded ? { status: found.status, values: found.values, errors: found.errors, data: found.data } : undefined
  }
  const read = (value: unknown) => ({ value, enumerable: true })

  const call = async (input: unknown, options?: CallOptions) => {
    // The page the call was made on, whose outcome it is even once the visitor went elsewhere.
    const page = navigation.page
    const visits = navigation.visits
    const left = () => navigation.visits !== visits
    // The island calling, from its setup or a handler, whose end ends a stream the call answers with; else the page, as long as no other path is shown.
    const caller: Caller = { owner: liveOwner(getOwner()), arrivals: navigation.arrivals }

    const turn = ++started

    shift(1)
    called(page, null)

    let undo: (() => void) | undefined
    let posted = false
    let sent = false
    // A stream keeps the call in flight until it ends.
    let streaming = false
    // Started before the caller goes on, so a navigation it starts next supersedes the refresh rather than the other way round; a site with `navigation: false` shows a call's effects itself.
    const refreshPage = () => {
      if (options?.refresh !== false && !left() && navigation.hooks)
        void refreshed()
    }

    try {
      undo = options?.optimistic ? undoable(options.optimistic) : undefined

      const data = await post(url(), input, setProgress, options?.signal, () => {
        sent = true
      }, left, caller, options?.headers)

      posted = true

      streaming = onStreamEnd(data, (status) => {
        if (status === 'done') {
          called(page, { action: url(), succeeded: true, data: untrack((data as ActionStream<unknown>).last) }, turn)
          refreshPage()
        }

        shift(-1)
      })

      if (!streaming) {
        called(page, { action: url(), succeeded: true, data }, turn)
        refreshPage()
      }

      return data
    }
    catch (error) {
      // A redirect leaves the page as it is until the next one shows.
      if (!posted && !(error instanceof ActionRedirectError))
        undo?.()

      // The server may have run a call aborted once it was sent, which the page then shows as it stands.
      if (sent && options?.signal?.aborted === true)
        refreshPage()

      if (error instanceof ActionError && !(error instanceof ActionRedirectError))
        called(page, { action: url(), status: error.status, values: {}, errors: error.errors, data: error.data }, turn)

      throw error
    }
    finally {
      if (!streaming)
        shift(-1)

      if (turn === started)
        setProgress(undefined)
    }
  }

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
      refused: read((error: unknown) => error instanceof ActionError && refusedAt.get(error) === url()),
      track: read(() => tracked(call, url)),
      with: read((fields: Record<string, unknown>) => withFields(call, fields)),
    },
  }
}

// A handle over `call` whose refusals of this action it answers as results.
function tracked(call: (input: never, options?: CallOptions) => Promise<unknown>, url: () => string): TrackedCall<never, unknown> {
  return trackCalls(
    call as (input: unknown, options?: CallOptions) => Promise<unknown>,
    error => !(error instanceof ActionError) || error instanceof ActionRedirectError || refusedAt.get(error) !== url() ? undefined : { ok: false, status: error.status, errors: error.errors, data: error.data },
    (data, release) => onStreamEnd(data, release),
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

    return files && upload ? upload.uploaded('POST', withBase(url), headers, files, onProgress, signal) : fetch(withBase(url), { method: 'POST', headers, body, ...signal && { signal } })
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
async function refreshed(): Promise<void> {
  const [navigations, visits] = [navigation.navigations, navigation.visits]
  const api = await navigateApi()

  if (navigation.navigations !== navigations || navigation.visits !== visits)
    return

  if (api)
    await api.refresh()
  else
    reload()
}

// Through the swap once it took over the app's links; a site with `navigation: false` loads the page, asking the leave guards first as `navigate()` would.
// Whether the page went, or a leave guard kept the visitor on it.
async function goTo(target: string): Promise<boolean> {
  const api = navigation.hooks ? await navigateApi() : undefined

  if (api) {
    const [before, released] = [navigation.current, navigation.released]

    await api.navigate(target)

    return navigation.current !== before || (!released && navigation.released)
  }

  const url = new URL(target, location.href)

  if (!await mayLeave(url))
    return false

  leave(url)

  return true
}
