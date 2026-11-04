import { effect, memo, signal } from 'kay'

// What a Table or a VirtualList draws its rows from: the rows, a function returning them or a promise of them.
export type RowsSource<Row> = Row[] | (() => Row[] | Promise<Row[]>) | Promise<Row[]>

export interface AsyncRowsHooks<Row> {
  onLoad?: ((rows: Row[]) => unknown) | undefined
  onError?: ((error: unknown) => unknown) | undefined
}

export interface AsyncRows<Row> {
  // The rows of the source: those of an array or a function answering at once, the last answer of a promise, none before it lands or once it failed.
  rows: () => Row[]
  // Whether an answer is on its way.
  loading: () => boolean
  // Whether the last answer was a failure, which waits for `retry`.
  failed: () => boolean
  // Whether `retry` has anything to call again: a bare promise cannot be asked twice.
  retryable: boolean
  // Calls the function again.
  retry: () => void
}

// An app's callback that throws is logged, not taken for a failed load.
function notify(call: () => unknown) {
  try {
    call()
  }
  catch (error) {
    console.error('kayjs-ui: a rows callback threw', error)
  }
}

const NONE: never[] = []

// A function returning an array stays synchronous and reactive, so the server draws its rows; a promise, or a function returning one, loads in the browser with only the latest answer landing.
export function asyncRows<Row>(given: () => RowsSource<Row> | undefined, hooks: AsyncRowsHooks<Row> = {}): AsyncRows<Row> {
  const attempt = signal(0)
  const loaded = signal<Row[]>(NONE)
  const failed = signal(false)
  const answer = memo((): Row[] | Promise<Row[]> => {
    attempt()

    const source = given()

    if (typeof source !== 'function')
      return source ?? NONE

    let result: Row[] | Promise<Row[]>

    try {
      result = source()
    }
    catch (error) {
      result = Promise.reject(error)
    }

    return result
  })
  // A promise is on its way from the start, so the server draws the skeleton.
  const loading = signal(!Array.isArray(answer()))
  let request = 0

  effect(() => {
    const value = answer()

    if (Array.isArray(value)) {
      request++
      loading.set(false)
      failed.set(false)

      return
    }

    void settle(value)
  })

  async function settle(promise: Promise<Row[]>) {
    const mine = ++request

    loading.set(true)
    failed.set(false)

    try {
      const rows = await promise

      if (mine !== request)
        return

      loaded.set(rows)
      loading.set(false)
      notify(() => hooks.onLoad?.(rows))
    }
    catch (error) {
      if (mine !== request)
        return

      console.error('kayjs-ui: could not load the rows', error)
      loaded.set(NONE)
      loading.set(false)
      failed.set(true)
      notify(() => hooks.onError?.(error))
    }
  }

  const direct = () => {
    const value = answer()

    return Array.isArray(value) ? value : undefined
  }

  return {
    rows: () => direct() ?? loaded(),
    loading,
    failed,
    retryable: typeof given() === 'function',
    retry: () => attempt.set(attempt() + 1),
  }
}
