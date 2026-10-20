interface Frame {
  array: boolean
  // The children complete so far; the child being read is not in it.
  value: Record<string, unknown> | unknown[]
  // The key of the child being read, of an object.
  key: string
}

type Mode = 'start' | 'key' | 'colon' | 'value' | 'after' | 'string' | 'token' | 'done' | 'dead'

export interface PartialParser {
  // Reads the next piece of the text and tells whether the object so far changed.
  push: (piece: string) => boolean
  // The object so far, undefined while the text is no JSON object (nothing yet, text around it, malformed).
  value: () => Record<string, unknown> | undefined
}

const MAX_DEPTH = 64
const NUMBER_CHARS = new Set('0123456789+-.eE')
const NUMBER = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i
const HEX = /^[\da-f]$/i
const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', 'b': '\b', 'f': '\f', 'n': '\n', 'r': '\r', 't': '\t' }
const LITERALS: Record<string, unknown> = { true: true, false: false, null: null }
const HIGH_SURROGATE_FIRST = 0xD800
const HIGH_SURROGATE_LAST = 0xDBFF
const SPACE = new Set([' ', '\n', '\r', '\t'])
const NONE = Symbol('none')

function set(target: Record<string, unknown>, key: string, value: unknown): void {
  // A key such as `__proto__` is data, as `JSON.parse` keeps it.
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

// How much of a string shows: a high surrogate waits for its pair.
function shownLength(text: string): number {
  const last = text.charCodeAt(text.length - 1)

  return last >= HIGH_SURROGATE_FIRST && last <= HIGH_SURROGATE_LAST ? text.length - 1 : text.length
}

// Reads a JSON object that may stop anywhere, as a model's answer does while it streams, one piece at a time: the parsing is the size of the piece, not of the text so far, and a snapshot copies only the containers still open.
// The object is as far as it came, a string as far as it was written and any other value once it is complete. What follows a closed object is left alone.
export function partialParser(): PartialParser {
  const stack: Frame[] = []
  let root: Record<string, unknown> | undefined
  let mode: Mode = 'start'
  let afterComma = false
  let changed = false
  // The string being read, and whether it is a key; `escape` holds a backslash sequence cut by the end of a piece.
  let isKey = false
  let out = ''
  let shown = 0
  let escape = ''
  // The number or literal being read.
  let token = ''
  let numeric = false

  const top = (): Frame => stack.at(-1)!

  const dead = () => {
    mode = 'dead'
  }

  const attach = (value: unknown) => {
    const frame = top()

    if (frame.array)
      (frame.value as unknown[]).push(value)
    else
      set(frame.value as Record<string, unknown>, frame.key, value)

    mode = 'after'
  }

  const add = (value: unknown) => {
    attach(value)
    changed = true
  }

  const open = (array: boolean) => {
    stack.push({ array, value: array ? [] : {}, key: '' })
    mode = array ? 'value' : 'key'
    afterComma = false
    changed = true
  }

  const close = () => {
    const frame = stack.pop()!

    if (stack.length === 0) {
      root = frame.value as Record<string, unknown>
      mode = 'done'

      return
    }

    // The container was shown while it grew, so closing it changes nothing.
    attach(frame.value)
  }

  const startValue = (char: string) => {
    if (stack.length > MAX_DEPTH) {
      dead()

      return
    }

    afterComma = false

    if (char === '"') {
      mode = 'string'
      isKey = false
      out = ''
      shown = 0
      changed = true
    }
    else if (char === '{') {
      open(false)
    }
    else if (char === '[') {
      open(true)
    }
    else {
      numeric = char === '-' || (char >= '0' && char <= '9')
      token = char

      mode = !numeric && !Object.keys(LITERALS).some(word => word.startsWith(char)) ? 'dead' : 'token'
    }
  }

  const endString = () => {
    if (isKey) {
      top().key = out
      mode = 'colon'

      return
    }

    // The string showed as far as `shown` while it grew, so closing it changes what shows only by the rest.
    attach(out)

    if (out.length !== shown)
      changed = true
  }

  // Reads the unescaped run of a string from `from`, then the escape or the end that stops it; returns where to go on.
  const readString = (piece: string, from: number): number => {
    let at = from

    while (at < piece.length) {
      if (escape !== '') {
        const char = piece[at]!

        if (escape === '\\') {
          if (char === 'u') {
            escape = '\\u'
          }
          else {
            const unescaped = ESCAPES[char]

            if (unescaped === undefined) {
              dead()

              return piece.length
            }

            out += unescaped
            escape = ''
          }
        }
        else if (HEX.test(char)) {
          escape += char

          if (escape.length === 6) {
            out += String.fromCharCode(Number.parseInt(escape.slice(2), 16))
            escape = ''
          }
        }
        else {
          dead()

          return piece.length
        }

        at++

        continue
      }

      let end = at

      while (end < piece.length) {
        const code = piece.charCodeAt(end)

        if (code === 0x22 || code === 0x5C || code < 0x20)
          break

        end++
      }

      out += piece.slice(at, end)
      at = end

      if (at >= piece.length)
        break

      const char = piece[at]!

      if (char === '"') {
        at++
        endString()

        return at
      }

      if (char !== '\\') {
        dead()

        return piece.length
      }

      escape = '\\'
      at++
    }

    return at
  }

  const finishNumber = (): boolean => {
    if (!NUMBER.test(token)) {
      dead()

      return false
    }

    add(Number(token))

    return true
  }

  const push = (piece: string): boolean => {
    changed = false

    for (let at = 0; at < piece.length; at++) {
      if (mode === 'done' || mode === 'dead')
        break

      if (mode === 'string') {
        at = readString(piece, at) - 1

        if (mode === 'string' && !isKey) {
          const now = shownLength(out)

          if (now !== shown)
            changed = true

          shown = now
        }

        continue
      }

      const char = piece[at]!

      if (mode === 'token') {
        if (numeric) {
          if (NUMBER_CHARS.has(char)) {
            token += char

            continue
          }

          // The token ended before this character, which the value's parent reads.
          if (!finishNumber())
            break

          at--

          continue
        }

        token += char

        if (Object.hasOwn(LITERALS, token))
          add(LITERALS[token])
        else if (!Object.keys(LITERALS).some(word => word.startsWith(token)))
          dead()

        continue
      }

      if (SPACE.has(char))
        continue

      if (mode === 'start') {
        if (char === '{')
          open(false)
        else
          dead()
      }
      else if (mode === 'key') {
        if (char === '}' && !afterComma) {
          close()
        }
        else if (char === '"') {
          afterComma = false
          mode = 'string'
          isKey = true
          out = ''
        }
        else {
          dead()
        }
      }
      else if (mode === 'colon') {
        if (char === ':')
          mode = 'value'
        else
          dead()
      }
      else if (mode === 'value') {
        if (char === ']' && top().array && !afterComma)
          close()
        else
          startValue(char)
      }
      else if (mode === 'after') {
        const frame = top()

        if (char === ',') {
          afterComma = true
          mode = frame.array ? 'value' : 'key'
        }
        else if (char === (frame.array ? ']' : '}')) {
          close()
        }
        else {
          dead()
        }
      }
    }

    return changed && mode !== 'dead'
  }

  const value = (): Record<string, unknown> | undefined => {
    if (mode === 'dead' || mode === 'start')
      return undefined

    if (root)
      return root

    // Only the containers still open are copied, the complete ones inside are shared between snapshots and read-only.
    let inner: unknown = mode === 'string' && !isKey ? out.slice(0, shown) : NONE

    for (let index = stack.length - 1; index >= 0; index--) {
      const frame = stack[index]!

      if (frame.array) {
        const items = (frame.value as unknown[]).slice()

        if (inner !== NONE)
          items.push(inner)

        inner = items
      }
      else {
        const fields = { ...frame.value as Record<string, unknown> }

        if (inner !== NONE)
          set(fields, frame.key, inner)

        inner = fields
      }
    }

    return inner as Record<string, unknown>
  }

  return { push, value }
}

// Reads a JSON object that may stop anywhere in one go: undefined when the text is no JSON object (nothing yet, text around it, malformed); what follows a closed object is left alone.
export function parsePartial(text: string): Record<string, unknown> | undefined {
  const parser = partialParser()

  parser.push(text)

  return parser.value()
}
