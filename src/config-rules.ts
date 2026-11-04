import { nearest } from './nearest'
import { SIZE_TEXT } from './runtime/byte-size'
import { DURATION_TEXT } from './runtime/duration'

// A check of one config value: what it accepts, in words, and the problems it finds in a value of the right kind.
// `keys` is set on an option bag, whose own keys are checked for typos too.
export interface Check {
  (value: unknown, path: string, out: string[]): void
  expected: string
  // Whether the value is of the kind this check is about, so `either` hands a value to the alternative it is meant for and reports that one's problems.
  accepts: (value: unknown) => boolean
  keys?: Record<string, Rule> | undefined
  // The words a mistyped string is matched against for a did-you-mean.
  words?: readonly string[] | undefined
}

// A key declares its check beside its type; `true` takes any value, for a key whose type is too open to check.
export type Rule = true | Check

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const SECRET_KEY = /secret|key|token|password/i
const SHOWN_LENGTH = 40

// How a value reads in a message, short and without its contents when it is big or when its key names a secret.
export function shown(value: unknown, path = ''): string {
  if (typeof value === 'number')
    return String(value)

  if (typeof value === 'string') {
    if (SECRET_KEY.test(path.slice(path.lastIndexOf('.') + 1)))
      return 'a string'

    return JSON.stringify(value.length > SHOWN_LENGTH ? `${value.slice(0, SHOWN_LENGTH)}...` : value)
  }

  if (typeof value === 'boolean' || value === null)
    return JSON.stringify(value)

  if (Array.isArray(value))
    return 'a list'

  return typeof value === 'object' ? 'an object' : `a ${typeof value}`
}

export function problem(path: string, value: unknown, expected: string, words?: readonly string[]): string {
  const near = typeof value === 'string' && words !== undefined ? nearest(value, words) : undefined

  return `\`${path}\` is ${shown(value, path)}, expected ${expected}${near === undefined ? '' : `; did you mean ${JSON.stringify(near)}?`}`
}

function check(expected: string, accepts: (value: unknown) => boolean, run?: (value: unknown, path: string, out: string[]) => void, extra: { keys?: Record<string, Rule> | undefined, words?: readonly string[] | undefined } = {}): Check {
  const own = (value: unknown, path: string, out: string[]): void => {
    if (!accepts(value)) {
      out.push(problem(path, value, expected, extra.words))

      return
    }

    run?.(value, path, out)
  }

  return Object.assign(own, { expected, accepts, ...extra })
}

const listed = (words: readonly string[]): string => words.length === 1 ? JSON.stringify(words[0]) : `${words.slice(0, -1).map(word => JSON.stringify(word)).join(', ')} or ${JSON.stringify(words.at(-1))}`

export const str = check('a string', value => typeof value === 'string')
export const bool = check('true or false', value => typeof value === 'boolean')
export const num = check('a number', value => typeof value === 'number' && Number.isFinite(value))
// A number that may be Infinity, for a limit whose documented value for no limit it is.
export const numOrInfinity = check('a number', value => typeof value === 'number' && !Number.isNaN(value))
export const fn = check('a function', value => typeof value === 'function')
export const obj = check('an object', isRecord)

export const lit = (given: boolean): Check => check(String(given), value => value === given)

export const oneOf = (...words: string[]): Check => check(`one of ${listed(words)}`, value => typeof value === 'string' && words.includes(value), undefined, { words })

// A duration text such as '250ms' or '5m'; whether a zero is allowed is left to the feature that reads it.
export const duration = check('a duration such as \'250ms\', \'5m\' or \'30d\'', value => typeof value === 'string' && DURATION_TEXT.test(value))
// A size in bytes: a number, or a text with its unit such as '20kb'.
export const bytes = check('a size such as 4096 or \'20kb\'', value => (typeof value === 'number' && Number.isFinite(value) && value >= 0) || (typeof value === 'string' && SIZE_TEXT.test(value)))

export function list(item: Rule): Check {
  return check('a list', Array.isArray, (value, path, out) => {
    if (item === true)
      return

    for (const [index, entry] of (value as unknown[]).entries()) {
      if (entry !== undefined)
        item(entry, `${path}[${index}]`, out)
    }
  })
}

// An object whose keys are free and whose values all follow one rule.
export function map(item: Rule): Check {
  return check('an object', isRecord, (value, path, out) => {
    if (item === true)
      return

    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry !== undefined)
        item(entry, `${path}.${key}`, out)
    }
  })
}

// An option bag: the keys it takes, each with its check, and `across` for a rule between two of them. A key it does not take is reported by `unknownConfigKeys`, which walks the same tables.
export function bag(keys: Record<string, Rule>, across?: (value: Record<string, unknown>, path: string, out: string[]) => void): Check {
  return check('an object of options', isRecord, (value, path, out) => {
    const before = out.length

    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const rule = Object.hasOwn(keys, key) ? keys[key] : undefined

      if (entry !== undefined && rule !== undefined && rule !== true)
        rule(entry, `${path}.${key}`, out)
    }

    if (out.length === before)
      across?.(value as Record<string, unknown>, path, out)
  }, { keys })
}

// The first alternative that takes a value's kind answers for it, so a bag with a bad key reports that key rather than "expected false or an object".
export function either(...options: Check[]): Check {
  const expected = options.map(option => option.expected).join(' or ')

  return check(expected, value => options.some(option => option.accepts(value)), (value, path, out) => {
    options.find(option => option.accepts(value))?.(value, path, out)
  }, { words: options.flatMap(option => option.words ?? []), keys: options.find(option => option.keys !== undefined)?.keys })
}

export function typedKeys(rule: Rule | undefined): Record<string, Rule> | undefined {
  return rule === undefined || rule === true ? undefined : rule.keys
}
