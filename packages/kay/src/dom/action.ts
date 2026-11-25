// Tiny client-side action stub (~300 B gzip, 0 B when no island imports an action).

import type { ActionResult } from '../server/action'

interface ClientAction<Input, Output> {
  /** A FormData input is sent as multipart, so it can carry files. */
  (input: Input | FormData): Promise<ActionResult<Output>>
  readonly url: string
  toString(): string
}

export function actionStub<Input = unknown, Output = unknown>(url: string): ClientAction<Input, Output> {
  const call = (async (input: Input | FormData): Promise<ActionResult<Output>> => {
    const isForm = typeof FormData !== 'undefined' && input instanceof FormData
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: isForm ? { accept: 'application/json' } : { 'content-type': 'application/json', 'accept': 'application/json' },
        body: isForm ? input : input === undefined ? '{}' : JSON.stringify(input),
      })
    }
    catch (error) {
      return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) }
    }

    // The action answered with a redirect: the page navigates there and the call never settles, so no caller acts on data it did not get.
    if (res.redirected) {
      if (typeof location !== 'undefined')
        location.assign(res.url)
      return new Promise<never>(() => {})
    }

    try {
      return await res.json() as ActionResult<Output>
    }
    catch {
      return { ok: false, status: res.status, error: res.statusText }
    }
  }) as unknown as ClientAction<Input, Output>

  Object.defineProperties(call, {
    url: { value: url, enumerable: true },
    toString: { value: () => url, enumerable: false },
  })
  return call
}
