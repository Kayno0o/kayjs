import { ActionError, signal, untrack } from 'kay'

// What a toast means, in the vocabulary of every tone: a failed call is a `danger`.
export type ToastTone = 'danger' | 'success' | 'info'

// Deprecated: the old name of a toast's tone, `error` for `danger`.
export type ToastType = 'error' | 'success' | 'info'

export interface Toast {
  id: number
  message: string
  tone: ToastTone
  // Deprecated: use `tone`.
  type: ToastType
}

export interface ToastOptions {
  // How long it stays, in milliseconds: 6000 by default, 10000 for an error. `Infinity` keeps it until the reader dismisses it, or `dismissToast(id)` does.
  duration?: number | undefined
}

// Long enough to read a sentence, an error longer as the reader has something to do about it.
const DURATION_MS = 6000
const ERROR_DURATION_MS = 10_000

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

// Untracked: an effect toasting a settled task would otherwise read the list, and toast again on every toast it adds.
function push(message: string, type: ToastType, duration: number | undefined): number {
  const id = nextId++
  const wanted = duration === undefined || Number.isNaN(duration) || duration < 0 ? undefined : duration
  const timer: Timer = { remaining: wanted ?? (type === 'error' ? ERROR_DURATION_MS : DURATION_MS), started: Date.now() }

  untrack(() => toasts.set(list => [...list, { id, message, tone: type === 'error' ? 'danger' : type, type }]))
  timers.set(id, timer)

  if (holds.size === 0)
    run(id, timer)

  return id
}

// Each shows a message and answers its id, for `dismissToast` to close a sticky one.
export const toast = {
  error: (message: string, options: ToastOptions = {}) => push(message, 'error', options.duration),
  success: (message: string, options: ToastOptions = {}) => push(message, 'success', options.duration),
  info: (message: string, options: ToastOptions = {}) => push(message, 'info', options.duration),
}

export interface AttemptOptions<Data = unknown> {
  failure: string
  // Toasted once the call goes through.
  success?: string | undefined
  refused?: ((data: Data) => string | undefined) | undefined
}

// What a call that went through resolves to: what it returned, or `true` when it returned nothing, so `undefined` only ever means it failed.
export type Attempted<T> = T extends void ? true : T

// Runs a change the page waits on, resolving to what `run` returned, or to `undefined` once a refused call has toasted instead of throwing.
// What is toasted: the message `refused` reads from the data the action's handler passed to `ctx.fail`, else a refusal of the whole call such as a limit, else `failure`.
export async function attempt<T, Data = unknown>(run: () => Promise<T>, failure: string | AttemptOptions<Data>, refused?: (data: Data) => string | undefined): Promise<Attempted<T> | undefined> {
  const options = typeof failure === 'string' ? { failure, refused } : failure

  try {
    const value = await run()

    if (options.success !== undefined)
      toast.success(options.success)

    return (value === undefined ? true : value) as Attempted<T>
  }
  catch (error) {
    toast.error(refusalOf(error, options.refused) ?? options.failure)

    return undefined
  }
}

function refusalOf<Data>(error: unknown, refused: ((data: Data) => string | undefined) | undefined): string | undefined {
  if (!(error instanceof ActionError))
    return undefined

  // A schema refusal carries no handler data for `refused` to read.
  const said = error.data === undefined ? undefined : refused?.(error.data as Data)

  return [said, error.errors['']].find(message => message !== undefined && message !== '')
}
