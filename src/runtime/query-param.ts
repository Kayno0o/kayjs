import type { Persisted, Stored } from './persist'
import { pageData } from './page-data'
import { keep } from './persist'

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
const REFUSED = Symbol('refused')

// A query param as the page's `query` schema reads it: its text read as the type the schema asks for, its default when left out or refused; without a rule for it, its text.
// The server renders with it and the browser hydrates with it, so both read the same value from the same rules.
export function readParam(rules: QueryRules | undefined, name: string, search: URLSearchParams): unknown {
  const rule = rules && Object.hasOwn(rules, name) ? rules[name] : undefined
  const texts = search.getAll(name)

  if (!rule)
    return texts[0]

  if (rule.type === 'array') {
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

// What `queryParam` reads and keeps, around the signal's own `read`: the server reads the request's param, the browser the page's address once, then each write takes the current history entry's place.
// A param left out reads as the signal's own value, `fallback` for `persisted(name, fallback, { storage: 'query' })`, which writing it leaves out too.
export function keepParam<T>(name: string, read: () => T, write: (value: T) => void, fallback?: T): Persisted<T> {
  return keep<T>({
    request: scope => found(scope.param(name)),
    stored: () => found(readParam(pageRules(), name, new URL(location.href).searchParams)),
    save: value => saveParam(name, value, fallback),
  }, read, write)
}

function found<T>(value: unknown): Stored<T> {
  return value === undefined ? { found: false } : { found: true, value: value as T }
}

function pageRules(): QueryRules | undefined {
  return pageData<QueryRules>(QUERY_SCRIPT, JSON.parse, true)[0]
}

// WebKit throws a SecurityError past 100 history writes in 30 s, Firefox past 200 in 10 s, which a slider dragged for long enough reaches.
// Writes under the budget land at once; past it only each param's last value is kept and written once the window has room, and a refused write never throws out of `set()`.
const WRITE_WINDOW = 30_000
const WRITE_BUDGET = 50
const writes: number[] = []
const deferred = new Map<string, ReturnType<typeof setTimeout>>()

function saveParam(name: string, value: unknown, fallback: unknown): void {
  clearTimeout(deferred.get(name))
  deferred.delete(name)

  const now = Date.now()

  while (writes.length > 0 && now - writes[0]! >= WRITE_WINDOW)
    writes.shift()

  if (writes.length < WRITE_BUDGET) {
    writes.push(now)
    writeParam(name, value, fallback)

    return
  }

  const path = location.pathname

  deferred.set(name, setTimeout(() => {
    deferred.delete(name)

    // A swap to another page since: the value is no longer this URL's to write.
    if (location.pathname === path)
      saveParam(name, value, fallback)
  }, WRITE_WINDOW - (now - writes[0]!)))
}

// Takes the current history entry's place, keeping its state, which holds kay's place in history: writing as the visitor types adds no entry to go back through.
// A list as the param repeated; nothing, blank text or the default leaves it out, so a page left as it was keeps its plain address.
function writeParam(name: string, value: unknown, fallback: unknown): void {
  const url = new URL(location.href)
  const rules = pageRules()
  const defaults = [rules && Object.hasOwn(rules, name) ? rules[name]!.default : undefined, fallback].filter(given => given !== undefined).map(given => JSON.stringify(given))

  url.searchParams.delete(name)

  if (value != null && value !== '' && !defaults.includes(JSON.stringify(value))) {
    for (const item of Array.isArray(value) ? value as unknown[] : [value])
      url.searchParams.append(name, String(item))
  }

  try {
    history.replaceState(history.state, '', url)
  }
  catch {
    // Refused by the browser's limit: the address stays behind the signal until the next write.
  }
}
