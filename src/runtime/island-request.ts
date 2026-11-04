import { ApiError } from './api-error-class'
import { skew } from './build'
import { ISLAND_HEADER, ISLAND_PARAM } from './server-islands'

// How long one request for a deferred server island may take before it counts as failed.
export const ISLAND_TIMEOUT_MS = 10_000

// The render of a deferred server island for this visitor, or undefined when a deploy removed the page's build, which the skew check reloads for.
// A request that gets no answer within `ISLAND_TIMEOUT_MS` or a refusal fails as an `ApiError` (status 0 for no answer); one `signal` aborts rejects with the abort and is no failure.
export async function requestIsland(slot: HTMLElement, signal?: AbortSignal, timeout = ISLAND_TIMEOUT_MS): Promise<string | undefined> {
  signal?.throwIfAborted()

  const url = new URL(location.href)
  const id = slot.dataset.kayServer ?? ''
  const timer = new AbortController()
  let late = false
  const stop = setTimeout(() => {
    late = true
    timer.abort()
  }, timeout)
  const abort = () => timer.abort(signal?.reason)

  url.searchParams.set(ISLAND_PARAM, id)
  url.hash = ''
  signal?.addEventListener('abort', abort)

  try {
    const response = await fetch(url, { headers: { [ISLAND_HEADER]: '1' }, signal: timer.signal })

    if (await skew(response))
      return undefined

    if (!response.ok)
      throw new ApiError(response.status, `kay: the server island ${id} of ${location.pathname} answered ${response.status}`)

    return await response.text()
  }
  catch (error) {
    if (error instanceof ApiError || signal?.aborted)
      throw error

    throw new ApiError(0, late ? `kay: the server island ${id} of ${location.pathname} took longer than ${timeout} ms` : `kay: the server island ${id} of ${location.pathname} got no answer`, undefined, {}, { cause: error })
  }
  finally {
    clearTimeout(stop)
    signal?.removeEventListener('abort', abort)
  }
}
