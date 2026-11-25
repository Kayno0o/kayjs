// Tiny client-side action stub (~300 B gzip, 0 B when no island imports an action).

import type { ReadonlySignal } from '../reactivity/index'
import type { ActionResult, ServerAction } from '../server/action'
import { signal } from '../reactivity/index'

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

/** Reactive progressive-enhancement form controller for a Kay server `action()`. */
export function useAction<Input, Output>(
  action: ClientAction<Input, Output> | ServerAction<Input, Output>,
  options: UseActionOptions<Output> = {},
): ActionForm<Input, Output> {
  const pending = signal(false)
  const error = signal('')
  const fieldErrors = signal<Record<string, string>>({})
  const data = signal<Output | undefined>(undefined)

  const submit = async (input: Input | FormData, formEl?: HTMLFormElement): Promise<ActionResult<Output> | undefined> => {
    if (pending.peek())
      return undefined
    pending.value = true
    error.value = ''
    fieldErrors.value = {}
    try {
      const res = await (action as ClientAction<Input, Output>)(input)
      if (!res.ok) {
        fieldErrors.value = res.fieldErrors ?? {}
        error.value = res.error
        options.onError?.(res)
        return res
      }
      data.value = res.data
      if (options.reset && formEl)
        formEl.reset()
      await options.onSuccess?.(res.data, formEl)
      return res
    }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      error.value = msg
      const failed: Extract<ActionResult<Output>, { ok: false }> = { ok: false, status: 0, error: msg }
      options.onError?.(failed)
      return failed
    }
    finally {
      pending.value = false
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
      return submit(new FormData(formEl), formEl)
    },
    submit,
    reset() {
      error.value = ''
      fieldErrors.value = {}
      data.value = undefined
    },
  }
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
