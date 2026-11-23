// Tiny client-side action stub (~300 B gzip, 0 B when no island imports an action).

import type { ActionResult } from '../server/action'

export interface ClientAction<Input, Output> {
  (input: Input): Promise<ActionResult<Output>>
  readonly url: string
  toString(): string
}

export function actionStub<Input = unknown, Output = unknown>(url: string): ClientAction<Input, Output> {
  const call = (async (input: Input): Promise<ActionResult<Output>> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json',
      },
      body: input === undefined ? '{}' : JSON.stringify(input),
    })

    if (res.redirected) {
      if (typeof location !== 'undefined')
        location.assign(res.url)
      return { ok: true, data: undefined as Output }
    }

    const body = await res.json().catch(() => ({ ok: false, status: res.status, error: res.statusText }))
    return body as ActionResult<Output>
  }) as unknown as ClientAction<Input, Output>

  Object.defineProperties(call, {
    url: { value: url, enumerable: true },
    toString: { value: () => url, enumerable: false },
  })
  return call
}
