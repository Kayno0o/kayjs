import { effect, memo, signal, untrack } from 'kay'

// What a Table or a VirtualList draws its rows from: the rows, a function returning them or a promise of them.
export type RowsSource<Row> = Row[] | (() => Row[] | Promise<Row[]>) | Promise<Row[]>

export interface AsyncRowsHooks<Row> {
  onLoad?: ((rows: Row[]) => unknown) | undefined
  onError?: ((failure: { error: unknown }) => unknown) | undefined
}

export interface AsyncRows<Row> {
  // The rows of the source: those of an array or a function answering at once, the last answer of a promise, none before the first lands; a refresh or a failure keeps the last ones.
  rows: () => Row[]
  // Whether an answer is on its way.
  loading: () => boolean
  // Whether the last answer was a failure, which waits for `retry`.
  failed: () => boolean
  // Whether `retry` has anything to call again: a bare promise cannot be asked twice.
  retryable: () => boolean
  // Calls the function again.
  retry: () => void
}

// An app's callback that throws is logged, not taken for a failed load.
function notify(call: () => unknown) {
  try {
    untrack(call)
  }
  catch (error) {
    console.error('kayjs-ui: a rows callback threw', error)
  }
}

const NONE: never[] = []

// An array is drawn at once, by the server too. A function is called in the browser only, so the server never runs an app's fetch or its browser-only code and draws the skeleton; a promise is consumed on the server so its rejection is never unhandled. Only the latest answer lands, a refresh keeps the rows shown until its answer, and a failure keeps them too, with the retry.
export function asyncRows<Row>(given: () => RowsSource<Row> | undefined, hooks: AsyncRowsHooks<Row> = {}): AsyncRows<Row> {
  const attempt = signal(0)
  const loaded = signal<Row[]>(NONE)
  const failed = signal(false)
  const source = memo((): RowsSource<Row> | undefined => given())
  const loading = signal(!Array.isArray(source()))
  let request = 0

  const direct = (): Row[] | undefined => {
    const value = source()

    return Array.isArray(value) ? value : undefined
  }

  // Awaiting a promise nobody else awaits, as the server does, keeps its rejection from being unhandled.
  async function consume(promise: Promise<Row[]>) {
    try {
      await promise
    }
    catch {
      // settle() reports it in the browser.
    }
  }

  const first = untrack(source)

  if (first instanceof Promise)
    void consume(first)

  effect(() => {
    const value = source()

    attempt()

    if (Array.isArray(value)) {
      request++
      loading.set(false)
      failed.set(false)

      return
    }

    if (typeof value !== 'function') {
      if (value instanceof Promise)
        void settle(value)

      return
    }

    let answer: Row[] | Promise<Row[]>

    try {
      answer = value()
    }
    catch (error) {
      answer = Promise.reject(error)
    }

    void settle(answer)
  })

  async function settle(answer: Row[] | Promise<Row[]>) {
    const mine = ++request

    failed.set(false)

    if (Array.isArray(answer)) {
      loaded.set(answer)
      loading.set(false)
      notify(() => hooks.onLoad?.(answer))

      return
    }

    loading.set(true)

    try {
      const rows = await answer

      if (mine !== request)
        return

      loaded.set(rows)
      loading.set(false)
      notify(() => hooks.onLoad?.(rows))
    }
    catch (error) {
      if (mine !== request)
        return

      console.error('kayjs-ui: a rows source could not load', error)
      loading.set(false)
      failed.set(true)
      notify(() => hooks.onError?.({ error }))
    }
  }

  return {
    rows: (): Row[] => direct() ?? loaded(),
    loading,
    failed,
    retryable: () => typeof source() === 'function',
    retry: () => attempt.set(attempt() + 1),
  }
}
