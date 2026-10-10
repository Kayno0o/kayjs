import type { Persisted } from './persist'
import type { ServerScope } from './reactive'
import { currentServerScope } from './reactive'

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
// The script the rules were last read from: a page swap replaces it with the next page's.
let pageRead: [Element | null, QueryRules | undefined] | undefined

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
export function keepParam<T>(name: string, read: () => T, write: (value: T) => void): Persisted<T> {
  if (typeof document === 'undefined')
    return serverSide(name, read)

  write(readParam(pageRules(), name, new URL(location.href).searchParams) as T)

  return { read, save: value => saveParam(name, value) }
}

// Read once per request, until a render of it writes the signal.
function serverSide<T>(name: string, read: () => T): Persisted<T> {
  const fromRequest = new WeakMap<ServerScope, T>()
  const written = new WeakSet<ServerScope>()

  return {
    read: () => {
      const scope = currentServerScope()

      if (!scope || written.has(scope))
        return read()

      if (!fromRequest.has(scope))
        fromRequest.set(scope, scope.param(name) as T)

      return fromRequest.get(scope)!
    },
    save: () => {
      const scope = currentServerScope()

      if (scope)
        written.add(scope)
    },
  }
}

function pageRules(): QueryRules | undefined {
  const script = document.querySelector(QUERY_SCRIPT)

  if (pageRead?.[0] !== script)
    pageRead = [script, script ? JSON.parse(script.textContent ?? '') as QueryRules : undefined]

  return pageRead[1]
}

// A list as the param repeated; nothing, blank text or the schema's default leaves it out, so a page left as it was keeps its plain address.
function saveParam(name: string, value: unknown): void {
  const url = new URL(location.href)
  const rules = pageRules()
  const fallback = rules && Object.hasOwn(rules, name) ? rules[name]!.default : undefined

  url.searchParams.delete(name)

  if (value != null && value !== '' && JSON.stringify(value) !== JSON.stringify(fallback)) {
    for (const item of Array.isArray(value) ? value as unknown[] : [value])
      url.searchParams.append(name, String(item))
  }

  history.replaceState(history.state, '', url)
}
