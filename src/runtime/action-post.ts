import type { Caller, Settles } from './action-owner'
import type { ActionStream, CallOptions } from './action-shared'
import { encodeCall } from './action-encode'
import { ActionError, ActionRedirectError } from './action-error'
import { networkFailures, refusedAt } from './action-marks'
import { goTo } from './action-navigate'
import { closeWithCaller, SETTLED } from './action-owner'
import { withBase } from './base'
import { skew } from './build'
import { withKeepalive } from './keepalive'
import { prefetched } from './navigation'
import { FAILURE_HEADER, PAGE_HEADER, REDIRECT_HEADER, WORK_HEADER, WORK_SCRIPT } from './swap'
import { decodeServerValue } from './wire'

// Defined by the browser build, which never renders on the server: tested where it is read, so the bundler drops the server's code.
declare const KAY_BROWSER: true | undefined

const HTTP_PROTOCOLS = new Set(['http:', 'https:'])

// Posting a call and reading its answer: loaded by the first call of an action, as a page that calls none does not carry it.
export async function post<Output>(url: string, input: unknown, onProgress: (sent: number) => void, signal: AbortSignal | undefined, onSent: () => void, left: () => boolean, caller: Caller, call?: { key?: string | undefined, options?: CallOptions | undefined }): Promise<Output> {
  const { headers, body } = encodeCall(input)
  const sent: Record<string, string> = { ...call?.key !== undefined && { 'idempotency-key': call.key }, ...call?.options?.headers, ...headers }

  // A test or a script calling it has no page.
  if (typeof location !== 'undefined')
    sent[PAGE_HEADER] = location.pathname + location.search

  // The timeout of a call counts for its first answer; a stream retried later is not cut by a timer that was cleared once the call returned.
  let first = true
  const sentOnce = () => {
    if (first)
      onSent()
  }

  // fetch tells nothing of an upload's progress, which a call carrying files reports.
  const send = async (solution: string | undefined) => {
    const headers = solution === undefined ? sent : { ...sent, [WORK_HEADER]: solution }

    const files = body instanceof FormData && typeof XMLHttpRequest !== 'undefined' ? body : undefined
    // Loaded before the call counts as sent, as an abort while it loads sends nothing.
    const upload = files && await import('./upload')

    // A signal aborted already sends nothing.
    if (signal?.aborted !== true)
      sentOnce()

    try {
      return await (files && upload ? upload.uploaded('POST', withBase(url), headers, files, onProgress, signal) : withKeepalive(call?.options?.keepalive === true, body, async extra => fetch(withBase(url), { method: 'POST', headers, body, ...signal && { signal }, ...extra })))
    }
    catch (error) {
      if (typeof error === 'object' && error !== null)
        networkFailures.add(error)

      throw error
    }
  }

  const answered = async () => {
    try {
      // A page holding a challenge for the action solves it from the moment one of its forms takes focus.
      let response = await send(typeof document !== 'undefined' && document.querySelector(`script[${WORK_SCRIPT}]`) ? await (await import('./work.client')).spendWork(url) : undefined)

      const challenge = response.status === 422 ? response.headers.get(WORK_HEADER) : null

      // A call with no challenge to solve, or a stale one, is answered a fresh one, and goes again with its solution.
      if (challenge !== null)
        response = await send(await (await import('./work.client')).spendWork(url, challenge))

      return response
    }
    finally {
      // Pages prefetched while it was out, or once it ran whatever the answer, show what it changed no more than the ones before it.
      prefetched.clear()
    }
  }

  const response = await answered()

  first = false
  void skew(response)

  return readActionResponse(response, url, left, caller, async () => {
    const again = await answered()

    void skew(again)

    return again
  })
}

// What a call to `action` got back: the handler's result, or an `ActionError` with the refused fields and the failure data.
// `left` tells whether the visitor went to another page since the call was made, which a redirect then no longer takes them from; a stream closes with the island that called, else once another path is shown.
// `call` posts the action again, which a stream that failed does when it is retried.
export async function readActionResponse<Output>(response: Response, action: string, left?: () => boolean, caller?: Caller, call?: () => Promise<Response>): Promise<Output> {
  const target = response.headers.get(REDIRECT_HEADER)

  if (target !== null) {
    if (typeof KAY_BROWSER === 'undefined' && typeof window === 'undefined')
      throw new ActionRedirectError(response.status, target)

    // Only a page goes there: a `javascript:` target would run in this one.
    if (!HTTP_PROTOCOLS.has(new URL(target, window.location.href).protocol))
      throw new TypeError(`kay: the action redirected to ${JSON.stringify(target)}, which is no page`)

    if (left?.() === true)
      throw new ActionRedirectError(response.status, target)

    // The navigation goes on either way; the call rejects as one a leave guard stopped does, so `pending()` clears and a `finally` runs.
    await goTo(target)

    throw new ActionRedirectError(response.status, target)
  }

  // Loaded only once an action streams, so a page calling none does not carry it.
  if (response.ok && response.headers.get('content-type')?.startsWith('text/event-stream') === true) {
    const retrying = call && {
      send: call,
      // What is not a stream again is the retry's failure: a refusal throws its `ActionError`, a redirect is followed.
      read: async (next: Response) => readActionResponse(next, action, left, caller),
      begun: (again: ActionStream<unknown> & Settles) => {
        closeWithCaller(again, caller)
        caller?.retried?.(again)
      },
    }
    const stream = (await import('./action-stream')).actionStream(response, SETTLED, () => new ActionError(500, '', {}, undefined, `The stream of ${action} failed after its first value`), retrying)

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
