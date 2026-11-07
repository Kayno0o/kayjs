import { effect, signal, untrack } from 'kay'
import { safely } from './safely'

// What a function source is asked: the text typed so far, empty for a control with no search.
export interface OptionsQuery {
  q: string
}

// The options of a choice control: a list, a promise of one, or a function answering one for a query, such as an action or a wrapped API call. A function and a promise are asked in the browser only.
export type OptionsSource<Option, Query extends OptionsQuery = OptionsQuery> = readonly Option[] | PromiseLike<readonly Option[]> | ((input: Query) => readonly Option[] | PromiseLike<readonly Option[]>)

// Whether the source has to be asked, as a function or a promise has.
export function isRemote<Option>(source: OptionsSource<Option>): source is Exclude<OptionsSource<Option>, readonly Option[]> {
  return !Array.isArray(source)
}

// The answer of a source for a query: the list itself, or what the function or the promise gives. A function that throws answers with a rejection.
export function askOptions<Option>(source: OptionsSource<Option>, q: string): readonly Option[] | PromiseLike<readonly Option[]> {
  if (typeof source !== 'function')
    return source

  try {
    return source({ q })
  }
  catch (error) {
    return Promise.reject(error)
  }
}

export interface OptionsHooks<Option> {
  // Text the source is asked for; read in an effect, so a change asks again. Left out, the source is asked once.
  query?: (() => string) | undefined
  onLoad?: ((options: readonly Option[], query: string) => unknown) | undefined
  onError?: ((failure: { error: unknown, query: string }) => unknown) | undefined
  // The control's name, in the log of a failure.
  label: string
}

export interface LoadedOptions<Option> {
  // The list, or the last answer: a new question and a failure keep it, none before the first lands.
  options: () => readonly Option[]
  // Whether an answer is on its way, true from the start for a source that has to be asked.
  loading: () => boolean
  // Whether the last question was refused, until the next one is asked.
  failed: () => boolean
  // Whether `retry` can ask again: a function can, a promise cannot be asked twice.
  retryable: () => boolean
  // Asks the same question again.
  retry: () => void
}

const NONE: never[] = []

// A list is drawn at once, by the server too. A function or a promise is asked in the browser only, once and again for each new `query` or `retry`; only the latest answer lands.
export function loadOptions<Option>(given: () => OptionsSource<Option>, hooks: OptionsHooks<Option>): LoadedOptions<Option> {
  const attempt = signal(0)
  const loaded = signal<readonly Option[]>(NONE)
  const failed = signal(false)
  const loading = signal(isRemote(untrack(given)))
  let request = 0

  effect(() => {
    const q = hooks.query?.() ?? ''

    attempt()

    const source = untrack(given)

    if (!isRemote(source)) {
      request++
      loading.set(false)
      failed.set(false)

      return
    }

    void settle(typeof source === 'function' ? untrack(() => askOptions(source, q)) : source, q)
  })

  async function settle(answer: readonly Option[] | PromiseLike<readonly Option[]>, q: string) {
    const mine = ++request

    failed.set(false)
    loading.set(true)

    try {
      const found = await answer

      if (mine !== request)
        return

      loaded.set(found)
      loading.set(false)
      safely(() => untrack(() => hooks.onLoad?.(found, q)), `kayjs-ui: a ${hooks.label} onLoad`)
    }
    catch (error) {
      if (mine !== request)
        return

      console.error(`kayjs-ui: a ${hooks.label} could not load its options`, error)
      loading.set(false)
      failed.set(true)
      safely(() => untrack(() => hooks.onError?.({ error, query: q })), `kayjs-ui: a ${hooks.label} onError`)
    }
  }

  return {
    options: () => {
      const source = given()

      return isRemote(source) ? loaded() : source
    },
    loading,
    failed,
    retryable: () => typeof given() === 'function',
    retry: () => attempt.set(attempt() + 1),
  }
}
