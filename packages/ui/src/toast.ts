import { signal, untrack } from 'kay'

export type ToastType = 'error' | 'success' | 'info'

export interface Toast {
  id: number
  message: string
  type: ToastType
}

const DURATION_MS = 4000

let nextId = 1

// The toasts `Toaster` shows. Only ever added to in the browser: the server's copy of this module is shared by every request, so it stays empty.
export const toasts = signal<Toast[]>([])

export function dismissToast(id: number): void {
  toasts.set(list => list.filter(item => item.id !== id))
}

// Untracked: an effect toasting a settled task would otherwise read the list, and toast again on every toast it adds.
function push(message: string, type: ToastType): void {
  const id = nextId++

  untrack(() => toasts.set(list => [...list, { id, message, type }]))
  setTimeout(dismissToast, DURATION_MS, id)
}

export const toast = {
  error: (message: string) => push(message, 'error'),
  success: (message: string) => push(message, 'success'),
  info: (message: string) => push(message, 'info'),
}

// Runs a change the page waits on, resolving to what `run` returned, or to `undefined` once a refused call has toasted `failure` instead of throwing.
export async function attempt<T>(run: () => Promise<T>, failure: string): Promise<T | undefined> {
  try {
    return await run()
  }
  catch {
    toast.error(failure)

    return undefined
  }
}
