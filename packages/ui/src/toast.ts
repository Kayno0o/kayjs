import type { Duration } from 'kay'
import type { Tone } from './tone'
import { ActionError, ApiError, durationMs, signal, untrack } from 'kay'
import { answerMessage } from './internal/answer-message'

// What a toast means, in the vocabulary of every tone: a failed call is a `danger`.
export type ToastTone = Tone

/** @deprecated The old name of a toast's tone, `error` for `danger`: read `Toast.tone`. Removed in 2.0.0. */
export type ToastType = 'error' | 'success' | 'info'

// A button in a toast for the obvious next step of its message: busy while `run`'s promise is pending, the toast dismissed once it settles, a rejection logged.
export interface ToastAction {
  label: string
  run: () => unknown
}

export interface Toast {
  id: number
  message: string
  action?: ToastAction | undefined
  // A toast pushed by hand with only a `type` takes its tone from it.
  tone?: ToastTone | undefined
  /** @deprecated Read `tone`, where `error` is `danger`. Removed in 2.0.0, when a toast is `{ id, message, tone }`. */
  type: ToastType
}

export interface ToastOptions {
  // How long it stays, such as `'3s'`: 6 seconds by default, an error until the reader dismisses it, as it asks them to act. `false` keeps any toast until the reader dismisses it, or `dismissToast(id)` does.
  duration?: Duration | false | undefined
  // One button before the close button, such as Retry or Undo. An error already open with the same words is shown once, whatever action the second asks.
  action?: ToastAction | undefined
  // The colour and icon, one of every `Tone`; the method's own when left out. A `danger` toast has the clock and the repeat guard of an error.
  tone?: Tone | undefined
}

// Long enough to read a sentence; an error has no clock, as a reader who needs longer than any limit must not lose it.
const DURATION_MS = 6000

// What keeps the toasts on screen past their time: the pointer resting on them, or focus inside them.
export type ToastHold = 'pointer' | 'focus'

interface Timer {
  remaining: number
  started: number
  handle?: ReturnType<typeof setTimeout>
}

let nextId = 1
const timers = new Map<number, Timer>()
const holds = new Set<ToastHold>()

// The toasts `Toaster` shows. Only ever added to in the browser: the server's copy of this module is shared by every request, so it stays empty.
export const toasts = signal<Toast[]>([])

// A sticky toast, with an infinite time left, sets no clock: the reader or `dismissToast(id)` ends it.
function run(id: number, timer: Timer): void {
  if (!Number.isFinite(timer.remaining))
    return

  timer.started = Date.now()
  timer.handle = setTimeout(dismissToast, timer.remaining, id)
}

export function dismissToast(id: number): void {
  clearTimeout(timers.get(id)?.handle)
  timers.delete(id)
  toasts.set(list => list.filter(item => item.id !== id))

  // The toaster hides with its last toast, so no pointer is left on it and no focus in it to let go.
  if (timers.size === 0)
    holds.clear()
}

// Stops every toast's clock while the reader is on them, and restarts each with the time it had left once nothing holds them, so a message can be read to its end.
export function holdToasts(hold: ToastHold, on: boolean): void {
  const held = holds.size > 0

  if (on)
    holds.add(hold)
  else
    holds.delete(hold)

  if (held === (holds.size > 0))
    return

  for (const [id, timer] of timers) {
    if (held) {
      run(id, timer)
    }
    else {
      clearTimeout(timer.handle)
      timer.remaining -= Date.now() - timer.started
    }
  }
}

function askedMs(duration: Duration | false | undefined): number | undefined {
  if (duration === false)
    return Number.POSITIVE_INFINITY

  return duration === undefined ? undefined : durationMs(duration)
}

// Untracked: an effect toasting a settled task would otherwise read the list, and toast again on every toast it adds.
const TYPE_OF_TONE: Partial<Record<Tone, ToastType>> = { danger: 'error', success: 'success' }

function push(message: string, method: ToastType, { duration, action, tone: chosen }: ToastOptions): number {
  const tone: Tone = chosen ?? (method === 'error' ? 'danger' : method)
  // The deprecated `type` follows the tone: a danger is an error, a success a success and every other tone an info.
  const type: ToastType = TYPE_OF_TONE[tone] ?? 'info'

  // An error already open with the same words is not stacked again, so a failing poll cannot cover the page.
  const open = type === 'error' ? untrack(toasts).find(shown => shown.type === 'error' && shown.message === message) : undefined

  if (open !== undefined)
    return open.id

  const id = nextId++
  const asked = askedMs(duration)
  const wanted = asked === undefined || Number.isNaN(asked) || asked < 0 ? undefined : asked
  const timer: Timer = { remaining: wanted ?? (type === 'error' ? Number.POSITIVE_INFINITY : DURATION_MS), started: Date.now() }

  untrack(() => toasts.set(list => [...list, { id, message, action, tone, type }]))
  timers.set(id, timer)

  if (holds.size === 0)
    run(id, timer)

  return id
}

// Each shows a message and answers its id, for `dismissToast` to close a sticky one.
export const toast = {
  error: (message: string, options: ToastOptions = {}) => push(message, 'error', options),
  success: (message: string, options: ToastOptions = {}) => push(message, 'success', options),
  info: (message: string, options: ToastOptions = {}) => push(message, 'info', options),
  warning: (message: string, options: ToastOptions = {}) => push(message, 'info', { tone: 'warning', ...options }),
}

export interface AttemptOptions<Data = unknown> {
  failure: string
  // Toasted once the call goes through.
  success?: string | undefined
  refused?: ((data: Data) => string | undefined) | undefined
  // The button of a refusal's toast, read from the same data as `refused`, and not used with `onRefused`, which shows no toast: `data => data.diverged ? { label: 'Rebase', run: rebase } : undefined`. Only a refusal gets it, not `failure`.
  refusedAction?: ((data: Data) => ToastAction | undefined) | undefined
  // Handed what a refusal carries, an action's `ctx.fail` data or a route's JSON answer, instead of toasting anything, for a page that shows the refusal where it is. A failure that is no refusal still toasts `failure`.
  onRefused?: ((data: Data) => unknown) | undefined
}

// What a call that went through resolves to: what it returned, or `true` when it returned nothing, so `undefined` only ever means it failed.
export type Attempted<T> = T extends void ? true : T

// Runs a change the page waits on, resolving to what `run` returned, or to `undefined` once a refused call has toasted instead of throwing.
// What is toasted: the message `refused` reads from the data the action's handler passed to `ctx.fail`, else a refusal of the whole call such as a limit, else `failure`.
// A call made with `call()` throws `ApiError`, read the same way: `refused` gets the route's JSON answer, else the words of a 4xx that read as a message, else `failure`, which status 0 and a 5xx always get.
export async function attempt<T, Data = unknown>(run: () => Promise<T>, failure: string | AttemptOptions<Data>, refused?: (data: Data) => string | undefined): Promise<Attempted<T> | undefined> {
  const options = typeof failure === 'string' ? { failure, refused } : failure

  try {
    const value = await run()

    if (options.success !== undefined)
      toast.success(options.success)

    return (value === undefined ? true : value) as Attempted<T>
  }
  catch (error) {
    const { onRefused, refusedAction } = options
    const data = onRefused === undefined && refusedAction === undefined ? undefined : refusalData<Data>(error)

    if (onRefused === undefined || data === undefined) {
      const message = refusalOf(error, options.refused)

      toast.error(message ?? options.failure, message !== undefined && data !== undefined && refusedAction !== undefined ? { action: readAction(refusedAction, data.value) } : {})
    }
    else {
      // The app shows the refusal itself, so a handler that throws or rejects leaves `failure` and the console.
      try {
        await onRefused(data.value)
      }
      catch (handlerError) {
        console.error('kayjs-ui: the `onRefused` of an attempt threw', handlerError)
        toast.error(options.failure)
      }
    }

    return undefined
  }
}

// A `refusedAction` that throws offers no button, and goes to the console as a bug in the app's own code.
function readAction<Data>(refusedAction: (data: Data) => ToastAction | undefined, data: Data): ToastAction | undefined {
  try {
    return refusedAction(data)
  }
  catch (error) {
    console.error('kayjs-ui: the `refusedAction` of a toast threw', error)

    return undefined
  }
}

// What a refusal carries for `onRefused`, boxed so a falsy answer still counts: the data an action's handler passed to `ctx.fail`, or the JSON object a route answered with. A schema refusal, a status 0, a 5xx answer and any other error carry none.
function refusalData<Data>(error: unknown): { value: Data } | undefined {
  if (error instanceof ActionError)
    return error.data === undefined ? undefined : { value: error.data as Data }

  if (error instanceof ApiError && error.status !== 0 && error.status < 500 && typeof error.data === 'object' && error.data !== null && !(error.data instanceof Blob))
    return { value: error.data as Data }

  return undefined
}

// The message of a call that failed, for a page that shows it where it is and not as a toast: what `attempt` would toast for a route's refusal or an action's, else `fallback`, which status 0, a 5xx and any other error get.
export function messageOf(error: unknown, fallback: string): string {
  return refusalOf(error, undefined) ?? fallback
}

function refusalOf<Data>(error: unknown, refused: ((data: Data) => string | undefined) | undefined): string | undefined {
  if (error instanceof ActionError) {
    // A schema refusal carries no handler data for `refused` to read.
    const said = error.data === undefined ? undefined : readRefused(refused, error.data as Data)

    return [said, answerMessage(error.data), error.errors['']].find(message => message !== undefined && message !== '')
  }

  return error instanceof ApiError ? refusalOfApi(error, refused) : undefined
}

// A route's refusal: `refused` reads its answer, else the words the route gave, which a server fault, an answer that never came or a bare status keep to `failure`.
function refusalOfApi<Data>(error: ApiError, refused: ((data: Data) => string | undefined) | undefined): string | undefined {
  if (error.status === 0)
    return undefined

  // An answer that is text, null or a Blob has no fields for `refused` to read.
  const said = typeof error.data === 'object' && error.data !== null && !(error.data instanceof Blob) ? readRefused(refused, error.data as Data) : undefined

  return [said, error.status < 500 ? answerMessage(error.data) : undefined].find(message => message !== undefined && message !== '')
}

// A `refused` that throws on data it did not expect says nothing, so `failure` is toasted and the caller is not left waiting; the throw goes to the console, as a bug in the app's own code.
function readRefused<Data>(refused: ((data: Data) => string | undefined) | undefined, data: Data): string | undefined {
  try {
    return refused?.(data)
  }
  catch (error) {
    console.error('kayjs-ui: the `refused` of a toast threw', error)

    return undefined
  }
}
