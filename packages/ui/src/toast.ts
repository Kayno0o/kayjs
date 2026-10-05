import { ActionError, signal, untrack } from 'kay'

export type ToastType = 'error' | 'success' | 'info'

export interface Toast {
  id: number
  message: string
  type: ToastType
}

const DURATION_MS = 4000

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

function run(id: number, timer: Timer): void {
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
function push(message: string, type: ToastType): void {
  const id = nextId++
  const timer: Timer = { remaining: DURATION_MS, started: Date.now() }

  untrack(() => toasts.set(list => [...list, { id, message, type }]))
  timers.set(id, timer)

  if (holds.size === 0)
    run(id, timer)
}

export const toast = {
  error: (message: string) => push(message, 'error'),
  success: (message: string) => push(message, 'success'),
  info: (message: string) => push(message, 'info'),
}

// Runs a change the page waits on, resolving to what `run` returned, or to `undefined` once a refused call has toasted instead of throwing.
// What is toasted: the message `refused` reads from the data the action's handler passed to `ctx.fail`, else a refusal of the whole call such as a limit, else `failure`.
export async function attempt<T, Data = unknown>(run: () => Promise<T>, failure: string, refused?: (data: Data) => string | undefined): Promise<T | undefined> {
  try {
    return await run()
  }
  catch (error) {
    toast.error(refusalOf(error, refused) || failure)

    return undefined
  }
}

function refusalOf<Data>(error: unknown, refused: ((data: Data) => string | undefined) | undefined): string | undefined {
  if (!(error instanceof ActionError))
    return undefined

  return (error.data === undefined ? undefined : refused?.(error.data as Data)) || error.errors['']
}
