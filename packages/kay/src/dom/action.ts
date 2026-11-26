// Tiny client-side action stub (~300 B gzip, 0 B when no island imports an action).

import type { ReadonlySignal } from '../reactivity/index'
import type { ActionResult, ServerAction } from '../server/action'
import { batch, signal } from '../reactivity/index'

export interface ClientAction<Input, Output> {
  /** A FormData input is sent as multipart, so it can carry files. */
  (input: Input | FormData): Promise<ActionResult<Output>>
  readonly url: string
  toString(): string
}

export interface UseActionOptions<Output> {
  /** Reset the submitted `<form>` element after a successful submission (default: false). */
  reset?: boolean | undefined
  /** Called with the typed action `data` when the action succeeds (`res.ok === true`). */
  onSuccess?: ((data: Output, form?: HTMLFormElement) => void | Promise<void>) | undefined
  /** Called when the action fails (`res.ok === false`). */
  onError?: ((result: Extract<ActionResult<Output>, { ok: false }>) => void) | undefined
}

export interface ActionForm<Input, Output> {
  readonly pending: ReadonlySignal<boolean>
  readonly error: ReadonlySignal<string>
  readonly fieldErrors: ReadonlySignal<Record<string, string>>
  readonly data: ReadonlySignal<Output | undefined>
  /** Action URL for progressive `<form action={form.action} method="post">` (or pass the action directly). */
  readonly action: string
  /** Progressive `<form onSubmit={form.onSubmit}>` handler that submits `FormData` via fetch when JS is loaded. */
  readonly onSubmit: (event: SubmitEvent & { currentTarget: HTMLFormElement }) => Promise<ActionResult<Output> | undefined>
  /** Imperatively submit typed input or `FormData` while tracking `pending`, `error`, `fieldErrors`, and `data`. */
  submit(input: Input | FormData, form?: HTMLFormElement): Promise<ActionResult<Output> | undefined>
  /** Clears `error`, `fieldErrors`, and `data`. */
  reset(): void
}

const errMsg = (e: unknown): string => e instanceof Error ? e.message : String(e)
const fail = (status: number, error: string) => ({ ok: false as const, status, error })

/** Reactive progressive-enhancement form controller for a Kay server `action()`. */
export function useAction<Input, Output>(
  action: ClientAction<Input, Output> | ServerAction<Input, Output>,
  options: UseActionOptions<Output> = {},
): ActionForm<Input, Output> {
  const pending = signal(false)
  const error = signal('')
  const fieldErrors = signal<Record<string, string>>({})
  const data = signal<Output | undefined>(undefined)

  const set = (p: boolean, e = '', f: Record<string, string> = {}) => batch(() => {
    pending.value = p
    error.value = e
    fieldErrors.value = f
  })

  const submit = async (input: Input | FormData, formEl?: HTMLFormElement): Promise<ActionResult<Output> | undefined> => {
    if (pending.peek())
      return undefined
    set(true)
    try {
      const res = await (action as ClientAction<Input, Output>)(input)
      if (!res.ok) {
        set(false, res.error, res.fieldErrors)
        options.onError?.(res)
        return res
      }
      batch(() => {
        data.value = res.data
        pending.value = false
      })
      if (options.reset && formEl)
        formEl.reset()
      await options.onSuccess?.(res.data, formEl)
      return res
    }
    catch (err) {
      const failed = fail(0, errMsg(err))
      set(false, failed.error)
      options.onError?.(failed)
      return failed
    }
  }

  return {
    pending,
    error,
    fieldErrors,
    data,
    get action() {
      return action.url || String(action)
    },
    onSubmit(event) {
      event.preventDefault()
      const formEl = event.currentTarget
      return submit(new FormData(formEl, event.submitter), formEl)
    },
    submit,
    reset() {
      batch(() => {
        set(pending.peek())
        data.value = undefined
      })
    },
  }
}

export function actionStub<Input = unknown, Output = unknown>(url: string): ClientAction<Input, Output> {
  const call = (async (input: Input | FormData): Promise<ActionResult<Output>> => {
    const isForm = typeof FormData !== 'undefined' && input instanceof FormData
    const headers: Record<string, string> = { 'accept': 'application/json', 'x-kay-action': '1' }
    if (!isForm)
      headers['content-type'] = 'application/json'
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: isForm ? input : input === undefined ? '{}' : JSON.stringify(input),
        redirect: 'manual',
      })
    }
    catch (err) {
      return fail(0, errMsg(err))
    }

    if (res.type === 'opaqueredirect')
      return fail(0, 'Unexpected redirect')

    const h = res.headers
    const to = h.get('x-kay-redirect') || (res.status > 299 && res.status < 400 && h.get('location')) || (res.redirected && res.url)
    if (to) {
      if (typeof location !== 'undefined') {
        location.assign(to)
        return new Promise<never>(() => {})
      }
      return fail(res.status || 302, to)
    }

    try {
      const b = await res.json() as Record<string, unknown> | null
      if (b && typeof b === 'object') {
        if (b.ok === true)
          return b as unknown as ActionResult<Output>
        if (b.ok === false && typeof b.error === 'string')
          return { ...b, status: typeof b.status === 'number' ? b.status : res.status } as ActionResult<Output>
        const m = typeof b.error === 'string' ? b.error : typeof b.message === 'string' ? b.message : ''
        if (m)
          return fail(res.status, m)
      }
    }
    catch {}
    return fail(res.status, res.statusText || `HTTP ${res.status}`)
  }) as unknown as ClientAction<Input, Output>

  Object.defineProperties(call, {
    url: { value: url, enumerable: true },
    toString: { value: () => url, enumerable: false },
  })
  return call
}
