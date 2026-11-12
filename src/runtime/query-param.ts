import type { Persisted, Stored } from './persist'
import { historyState, navigation, pageKey } from './navigation'
import { pageData } from './page-data'
import { keep } from './persist'
import { onCleanup } from './reactive'
import { addressChanged } from './with-query'

// What the server sends of one param of the page's `query` schema, enough to read its text as the schema does without the schema itself.
export interface ParamRule {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | undefined
  items?: ParamRule | undefined
  enum?: unknown[] | undefined
  minimum?: number | undefined
  maximum?: number | undefined
  default?: unknown
  required?: boolean | undefined
}

export type QueryRules = Record<string, ParamRule>

// The rules of the page's `query` schema, which the server writes into the page for its islands, in one JSON script of its head.
const QUERY_SCRIPT = 'script[data-kay-query]'
// form.ts reads a number input's and a checkbox's text alike; it stays out of this module, which would pull it into every page's eager JS.
const DECIMAL = /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?\s*$/i
const BOOLEAN_TEXT = new Map([['true', true], ['on', true], ['false', false]])
const REFUSED = /* @__PURE__ */ Symbol('refused')

// A query param as the page's `query` schema reads it: its text read as the type the schema asks for, its default when left out or refused; without a rule for it, its text.
// The server renders with it and the browser hydrates with it, so both read the same value from the same rules.
export function readParam(rules: QueryRules | undefined, name: string, search: URLSearchParams): unknown {
  const rule = rules && Object.hasOwn(rules, name) ? rules[name] : undefined
  const texts = search.getAll(name)

  if (!rule)
    return texts[0]

  if (rule.type === 'array') {
    // A blank text is the empty list, as `persisted.query` writes it.
    if (texts.length === 1 && texts[0] === '')
      return []

    const items = texts.map(text => fromText(rule.items ?? {}, text))

    return texts.length === 0 || items.includes(REFUSED) ? leftOut(rule) : items
  }

  const text = texts[0]
  // An optional param left blank is left out, as a form's field is.
  const value = text === undefined || (text === '' && rule.required !== true) ? REFUSED : fromText(rule, text)

  return value === REFUSED ? leftOut(rule) : value
}

// Its default, else what a form means by leaving out a required checkbox or list.
function leftOut(rule: ParamRule): unknown {
  if (rule.default !== undefined)
    return structuredClone(rule.default)

  if (rule.required === true && (rule.type === 'array' || rule.type === 'boolean'))
    return rule.type === 'array' ? [] : false

  return undefined
}

function fromText(rule: ParamRule, text: string): unknown {
  let value: unknown = text

  if (rule.type === 'number' || rule.type === 'integer') {
    const number = DECIMAL.test(text) ? Number(text) : Number.NaN

    if (Number.isNaN(number) || (rule.type === 'integer' && !Number.isInteger(number)) || (rule.minimum !== undefined && number < rule.minimum) || (rule.maximum !== undefined && number > rule.maximum))
      return REFUSED

    value = number
  }
  else if (rule.type === 'boolean') {
    value = BOOLEAN_TEXT.get(text) ?? REFUSED
  }

  return rule.enum === undefined || rule.enum.includes(value) ? value : REFUSED
}

// The signals kept in the query, each reading its param again from the address a traversal reached between entries kay wrote.
const followed = new Set<() => void>()

// What `queryParam` reads and keeps, around the signal's own `read`: the server reads the request's param, the browser the page's address once, then each write takes the current history entry's place.
// A param left out reads as the signal's own value, `fallback` for `persisted.query(name, fallback)`, which writing it leaves out too.
// A value outside `values` reads as the param left out.
// `history: 'push'` adds an entry for each write instead, which Back and Forward step through, the signal following.
export function keepParam<T>(name: string, read: () => T, write: (value: T) => void, fallback?: T, values?: readonly unknown[], history?: 'push' | 'replace'): Persisted<T> {
  const stored = () => found<T>(readParam(pageRules(), name, new URL(location.href).searchParams), values, fallback)
  const push = history === 'push'

  if (typeof document !== 'undefined') {
    const reread = () => {
      const now = stored()

      write(now.found ? now.value : fallback as T)
    }

    followed.add(reread)
    onCleanup(() => followed.delete(reread))

    if (push)
      watch()
  }

  return keep<T>({
    request: scope => found(scope.param(name), values, fallback),
    stored,
    save: value => saveParam(name, value, fallback, push),
  }, read, write)
}

// A param with no rule reads as text: a blank one is the empty list of a list signal, and text naming one of the `values` is that value, a number or a boolean.
function found<T>(value: unknown, values?: readonly unknown[], fallback?: unknown): Stored<T> {
  if (value === '' && Array.isArray(fallback))
    value = []

  if (typeof value === 'string' && values && !values.includes(value))
    value = values.find(given => typeof given !== 'string' && String(given) === value) ?? value

  return value === undefined || (values !== undefined && !values.includes(value)) ? { found: false } : { found: true, value: value as T }
}

function pageRules(): QueryRules | undefined {
  return pageData<QueryRules>(QUERY_SCRIPT, JSON.parse, true)[0]
}

// WebKit throws a SecurityError past 100 history writes in 10 s, which a slider dragged fast reaches.
// Every param shares one gap, a throttle with a leading write: one goes through at once, then at most one per 200 ms while values keep coming, the latest ones landing in a single `replaceState`.
// The page flushes them before it is left or navigated, one found on another page than it was set on is dropped, and a refused write never throws out of `set()`.
const WRITE_GAP = 200
const pending = new Map<string, [value: unknown, fallback: unknown]>()
let timer: ReturnType<typeof setTimeout> | undefined
let lastWrite = 0
let retrying = false
// The page the pending values were set on, which a traversal or a swap may have left by the time they are written.
let queuedOn = ''
// A pending write asked for its own entry.
let pushing = false

let watching = false

// An entry kay wrote for the page now shown carries the page's number, so a swap to other content, by `navigate()` or a link, makes the entries before it foreign again.
const MARK = 'kayq'

function watch(): void {
  if (!watching) {
    watching = true
    // The navigation's own popstate handler asks, after its leave guards, whether the entry reached is one kay wrote.
    navigation.traversed = traversed
  }
}

function marked(state: unknown): object {
  return { ...state as object | null, [MARK]: navigation.page }
}

// Whether `state` is an entry of the page shown that kay wrote: then the signals read the address they reached, and the page stays.
function traversed(state: unknown): boolean {
  if ((state as Record<string, unknown> | null)?.[MARK] !== navigation.page)
    return false

  clearTimeout(timer)
  timer = undefined
  pending.clear()
  pushing = false
  retrying = false
  navigation.shown = pageKey(new URL(location.href))

  for (const reread of followed)
    reread()

  addressChanged()

  return true
}

function saveParam(name: string, value: unknown, fallback: unknown, push: boolean): void {
  if (pending.size === 0)
    queuedOn = pageKey(new URL(location.href))

  pending.set(name, [value, fallback])

  if (push)
    pushing = true

  if (!navigation.flush) {
    navigation.flush = flush
    addEventListener('pagehide', flush)
    addEventListener('visibilitychange', flush)
  }

  // An entry of its own is written at once, past the gap: it follows a click, not a drag.
  if (push || timer === undefined) {
    // A monotonic clock, which no change of the system's time holds a write back by.
    const wait = lastWrite + WRITE_GAP - performance.now()

    if (wait <= 0 || push)
      flush()
    else
      timer = setTimeout(flush, wait)
  }
}

// Takes the current history entry's place, keeping its state, which holds kay's place in history: writing as the visitor types adds no entry to go back through.
// A write asking for `history: 'push'` adds an entry instead, with the writes waiting.
// A list as the param repeated; the default leaves it out, so a page left as it was keeps its plain address, and an empty value is the param with blank text.
function flush(): void {
  clearTimeout(timer)
  timer = undefined

  if (pending.size === 0)
    return

  const url = new URL(location.href)

  if (pageKey(url) !== queuedOn) {
    pushing = false
    pending.clear()
    retrying = false

    return
  }

  const rules = pageRules()

  for (const [name, [value, fallback]] of pending) {
    const defaults = [rules && Object.hasOwn(rules, name) ? rules[name]!.default : undefined, fallback].filter(given => given !== undefined).map(given => JSON.stringify(given))

    url.searchParams.delete(name)

    if (value != null && !defaults.includes(JSON.stringify(value))) {
      const items = Array.isArray(value) ? value as unknown[] : [value]

      // An empty value is written when a default is not empty, so a reload keeps it rather than reading the default back.
      if (value === '' || items.length === 0) {
        if (defaults.length > 0)
          url.searchParams.append(name, '')
      }
      else {
        for (const item of items)
          url.searchParams.append(name, String(item))
      }
    }
  }

  const push = pushing
  let pushed = false

  pushing = false

  try {
    if (push && url.href !== location.href) {
      // The entry left is marked too, so Back to it follows the signals.
      if ((history.state as Record<string, unknown> | null)?.[MARK] !== navigation.page)
        history.replaceState(marked(history.state), '')

      navigation.at++
      history.pushState(marked(historyState()), '', url)
      pushed = true
    }
    else if (!push) {
      history.replaceState(watching ? marked(history.state) : history.state, '', url)
    }

    if (watching)
      navigation.shown = pageKey(url)

    addressChanged()
    pending.clear()
    retrying = false
  }
  catch {
    if (push && !pushed)
      navigation.at--

    // Refused by the browser's limit: tried once more after the gap, the address behind the signals until then.
    if (retrying) {
      pending.clear()
      retrying = false
    }
    else {
      retrying = true
      pushing = push
      timer = setTimeout(flush, WRITE_GAP)
    }
  }

  lastWrite = performance.now()
}
