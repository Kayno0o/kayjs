import { DevalueError, stringify } from 'devalue'
import { isVouched, vouch } from './safe-html'

// Island props, action calls and the flash cookie go as devalue text: JSON that also carries Dates, Maps, Sets, bigints, URLs, RegExps, undefined and shared references.
// The server writes it with devalue's stringify, whose errors name the path of what it cannot send; the browser writes it with `sendValue` (send.ts) and kay reads it back itself, so no client chunk ships devalue.
// Markup the server vouched for stays vouched for where it arrives, as a `SafeHtml` entry holding the markup after a mark: devalue stores a string once by value, so a payload equal to the string itself would point at its own entry.
const SAFE_HTML = 'SafeHtml'
const MARK = '!'

export const ACTION_TYPE = 'Action'
export const ACTION_PREFIX = '/_kay/action/'
const ACTION_MARK = Symbol.for('kay.action')

// `actions` lets a function that is an action through, as island props do, as its URL: anywhere else it stays unsendable.
export function encodeValue(value: unknown, actions = false): string {
  return stringify(value, {
    [SAFE_HTML]: markup => typeof markup === 'string' && isVouched(markup, false) && MARK + markup,
    ...actions && { [ACTION_TYPE]: sendableAction },
  })
}

function sendableAction(value: unknown): string | false {
  return typeof value === 'function' && ACTION_MARK in value ? (value as unknown as { url: string }).url : false
}

// The revivers for text the server wrote, island props, action results and event streams: the only text whose `SafeHtml` entries vouch for markup. What the browser sends, a cookie and localStorage are read without them, so no caller can vouch for its own text.
export const serverWritten: Record<string, Reviver> = {
  // `substring` throws on a payload that is no string, where an array has a `slice`.
  [SAFE_HTML]: (text: string) => vouch(text.substring(1)),
}

// The action reviver until an island typing a prop as an action installs the one building stubs (`reviveActions`, action.ts), so the core chunk carries none.
export function noActionReviver(): never {
  throw new TypeError('kay: an island was passed an action but does not type a prop as one: import `Action` from \'kay\' in its script, as the type of that prop')
}

if (process.env.NODE_ENV !== 'production')
  serverWritten[ACTION_TYPE] = noActionReviver

export function decodeServerValue(text: string): unknown {
  return decodeValue(text, serverWritten)
}

// Reads back a custom type, from what the stringify reducer of the same name returned.
export type Reviver = (value: never) => unknown

// What devalue writes in place of an index for a value it does not store.
export const CONSTANTS = new Map<unknown, unknown>([[-1, undefined], [-3, Number.NaN], [-4, Infinity], [-5, -Infinity], [-6, -0]])
const HOLE = -2

export const SPARSE = -7
const MAX_ARRAY_LENGTH = 2 ** 32 - 1
// The types devalue writes as text, a RegExp with its flags after.
const FROM_TEXT: Record<string, (text: string, flags?: string) => unknown> = {
  Date: text => new Date(text),
  RegExp: (source, flags) => new RegExp(source, flags),
  BigInt,
  URL: text => new URL(text),
  URLSearchParams: text => new URLSearchParams(text),
}

export function decodeValue(text: string, revivers?: Record<string, Reviver>): unknown {
  return unflattenValue(JSON.parse(text), revivers)
}

// The value devalue's stringify wrote, from its text as JSON.parse returns it; throws on anything stringify cannot have written.
export function unflattenValue(flat: unknown, revivers: Record<string, Reviver> = {}): unknown {
  const values = Array.isArray(flat) ? flat as unknown[] : []
  // Seeded with the constants, which no index of the text can overwrite.
  const decoded = new Map<unknown, unknown>(CONSTANTS)
  // The custom types being revived, whose payload may not lead back to them.
  const reviving = new Set<number>()

  const keep = <T>(index: number, value: T): T => {
    decoded.set(index, value)

    return value
  }

  const read = (index: unknown): unknown => {
    if (decoded.has(index))
      return decoded.get(index)

    if (!isIndex(index, values.length))
      malformed(index)

    const raw = values[index]

    if (raw === null || typeof raw !== 'object')
      return keep(index, raw)

    if (!Array.isArray(raw)) {
      const object = keep(index, {})

      for (const key in raw)
        assign(object, key, read((raw as Record<string, unknown>)[key]), index)

      return object
    }

    const [type, payload] = raw as unknown[]

    if (typeof type !== 'string') {
      const array = keep(index, [] as unknown[])

      if (type !== SPARSE) {
        array.length = raw.length

        for (let at = 0; at < raw.length; at++) {
          if (raw[at] !== HOLE)
            array[at] = read(raw[at])
        }

        return array
      }

      if (!isIndex(payload, MAX_ARRAY_LENGTH + 1))
        malformed(index)

      // A length set on a fresh array would allocate that many slots; touching the last index first leaves it a dictionary, which a forged length cannot grow.
      array[MAX_ARRAY_LENGTH - 1] = undefined
      delete array[MAX_ARRAY_LENGTH - 1]
      array.length = payload

      for (let at = 2; at < raw.length; at += 2) {
        const position: unknown = raw[at]

        if (!isIndex(position, payload))
          malformed(index)

        array[position] = read(raw[at + 1])
      }

      return array
    }

    if (Object.hasOwn(revivers, type)) {
      if (reviving.has(index))
        malformed(index)

      reviving.add(index)
      const value = (revivers[type] as (value: unknown) => unknown)(read(payload))

      reviving.delete(index)

      return keep(index, value)
    }

    if (Object.hasOwn(FROM_TEXT, type)) {
      if (typeof payload !== 'string' || (raw.length > 2 && typeof raw[2] !== 'string'))
        malformed(index)

      return keep(index, FROM_TEXT[type]!(payload, raw[2] as string | undefined))
    }

    if (type === 'Set') {
      const set = keep(index, new Set<unknown>())

      for (const item of raw.slice(1))
        set.add(read(item))

      return set
    }

    if (type === 'Map') {
      const map = keep(index, new Map<unknown, unknown>())

      for (let at = 1; at < raw.length; at += 2)
        map.set(read(raw[at]), read(raw[at + 1]))

      return map
    }

    if (type !== 'null')
      malformed(index, type)

    const object = keep(index, Object.create(null) as object)

    for (let at = 1; at < raw.length; at += 2)
      assign(object, raw[at], read(raw[at + 1]), index)

    return object
  }

  return read(typeof flat === 'number' ? flat : 0)
}

// What devalue refused and where, such as `Cannot stringify a function at .todo.format`; undefined for any other error.
export function unsendable(error: unknown): string | undefined {
  if (!(error instanceof DevalueError))
    return undefined

  return error.path === '' ? error.message : `${error.message} at ${error.path}`
}

// A `__proto__` key would swap the object's prototype rather than set a property.
function assign(object: object, key: unknown, value: unknown, index: number): void {
  if (typeof key !== 'string' || key === '__proto__')
    malformed(index)

  ;(object as Record<string, unknown>)[key] = value
}

export function isIndex(value: unknown, length: number): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) < length
}

export function malformed(index: unknown, type?: string): never {
  throw new TypeError(`kay: the devalue text received is malformed at index ${String(index)}${type === undefined ? '' : `, a ${type} kay never sends`}`)
}
