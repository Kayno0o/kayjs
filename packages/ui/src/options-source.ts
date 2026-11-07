import { effect, onCleanup, signal, untrack } from 'kay'
import { safely } from './safely'

// What a function source is asked: the text typed so far, empty for a control with no search.
export interface OptionsQuery {
  q: string
}

// The options of a choice control: a list, a promise of one, or a function answering one for a query, such as an action or a wrapped API call. A function and a promise are asked in the browser only.
export type OptionsSource<Option, Query extends OptionsQuery = OptionsQuery> = readonly Option[] | PromiseLike<readonly Option[]> | ((input: Query) => readonly Option[] | PromiseLike<readonly Option[]>)

// Whether the source has to be asked, as a function or a promise has.
export function isRemote<Option, Query extends OptionsQuery = OptionsQuery>(source: OptionsSource<Option, Query>): source is Exclude<OptionsSource<Option, Query>, readonly Option[]> {
  return !Array.isArray(source)
}

// The answer of a source for a query: the list itself, or what the function or the promise gives. A function that throws answers with a rejection.
export function askOptions<Option, Query extends OptionsQuery = OptionsQuery>(source: OptionsSource<Option, Query>, q: string, more?: Omit<Query, 'q'>): readonly Option[] | PromiseLike<readonly Option[]> {
  if (typeof source !== 'function')
    return source

  try {
    return source({ q, ...more } as Query)
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

// A search waits this long after the last key.
export const SEARCH_PAUSE_MS = 200

// Runs `run` with what `read` gave once it has stayed the same for the pause in typing, `immediate` asking at once instead; `skip` is read in the same effect, so a state it reads starts the wait again when it changes. Call it where an effect may be created.
export function afterPause<Value>(read: () => Value, run: (value: Value) => void, { skip, immediate }: { skip?: () => boolean, immediate?: () => boolean } = {}): void {
  effect(() => {
    const value = read()

    if (skip?.())
      return

    const timer = setTimeout(run, untrack(() => immediate?.()) ? 0 : SEARCH_PAUSE_MS, value)

    onCleanup(() => clearTimeout(timer))
  })
}

export interface SearchedOptions<Option> {
  // The last answer, empty before the first lands and after a failure.
  found: ReturnType<typeof signal<readonly Option[]>>
  // The text the answer held in `found` is for, none before the first lands.
  answered: ReturnType<typeof signal<string | undefined>>
  // Whether the last question was refused.
  failed: ReturnType<typeof signal<boolean>>
  // Asks the source for `query`: a list, or a text shorter than `minLength`, answers with none. Only the latest question lands.
  load: (query: string) => Promise<void>
  // Drops the question still on its way, as a new key press does: its answer is for an older text.
  stale: () => void
}

// What Combobox and MultiSelect ask on each pause in typing: the same question as `loadOptions`, but driven by the control, which decides when to ask, so the state is handed back to be reset between questions.
export function searchOptions<Option>(given: () => OptionsSource<Option>, hooks: { minLength: () => number, onLoad?: ((options: readonly Option[], query: string) => unknown) | undefined, onError?: ((failure: { error: unknown, query: string }) => unknown) | undefined, label: string }): SearchedOptions<Option> {
  const found = signal<readonly Option[]>(NONE)
  const answered = signal<string | undefined>(undefined)
  const failed = signal(false)
  let request = 0

  async function load(query: string) {
    const mine = ++request
    const source = untrack(given)

    if (!isRemote(source) || query.trim().length < untrack(hooks.minLength)) {
      found.set(NONE)
      answered.set(query)

      return
    }

    try {
      const answer = await askOptions(source, query)

      if (mine !== request)
        return

      found.set(answer)
      answered.set(query)
      failed.set(false)
      safely(() => hooks.onLoad?.(answer, query), `kayjs-ui: a ${hooks.label} onLoad`)
    }
    catch (error) {
      if (mine === request) {
        console.error(`kayjs-ui: a ${hooks.label} could not load its options`, error)
        found.set(NONE)
        answered.set(query)
        failed.set(true)
        safely(() => hooks.onError?.({ error, query }), `kayjs-ui: a ${hooks.label} onError`)
      }
    }
  }

  return { found, answered, failed, load, stale: () => void ++request }
}
