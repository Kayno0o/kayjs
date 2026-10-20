interface Read {
  value: unknown
  complete: boolean
}

const MALFORMED = Symbol('malformed')
const MAX_DEPTH = 64
const SPACE = new Set([' ', '\n', '\r', '\t'])
const NUMBER_CHARS = new Set('0123456789+-.eE')
const NUMBER = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i
const HEX = /^[\da-f]{4}$/i
const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', 'b': '\b', 'f': '\f', 'n': '\n', 'r': '\r', 't': '\t' }
const LITERALS: Record<string, unknown> = { true: true, false: false, null: null }
const HIGH_SURROGATE_FIRST = 0xD800
const HIGH_SURROGATE_LAST = 0xDBFF

function set(target: Record<string, unknown>, key: string, value: unknown): void {
  // A key such as `__proto__` is data, as `JSON.parse` keeps it.
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

// Reads a JSON object that may stop anywhere, as a model's answer does while it streams: the object as far as it came, a string as far as it was written and any other value once it is complete.
// Undefined when the text is no JSON object (nothing yet, text around it, malformed); what follows a closed object is left alone.
export function parsePartial(text: string): Record<string, unknown> | undefined {
  let at = 0

  const skip = () => {
    while (at < text.length && SPACE.has(text[at]!))
      at++
  }

  const readString = (): { value: string, complete: boolean } => {
    let out = ''

    at++

    while (at < text.length) {
      const char = text[at]!

      if (char === '"') {
        at++

        return { value: out, complete: true }
      }

      if (char < ' ')
        throw MALFORMED

      if (char !== '\\') {
        out += char
        at++

        continue
      }

      const escape = text[at + 1]

      if (escape === undefined)
        break

      if (escape === 'u') {
        const hex = text.slice(at + 2, at + 6)

        if (hex.length < 4) {
          if (!HEX.test(hex.padEnd(4, '0')))
            throw MALFORMED

          break
        }

        if (!HEX.test(hex))
          throw MALFORMED

        out += String.fromCharCode(Number.parseInt(hex, 16))
        at += 6

        continue
      }

      const unescaped = ESCAPES[escape]

      if (unescaped === undefined)
        throw MALFORMED

      out += unescaped
      at += 2
    }

    // A high surrogate waits for its pair.
    const last = out.charCodeAt(out.length - 1)

    return { value: last >= HIGH_SURROGATE_FIRST && last <= HIGH_SURROGATE_LAST ? out.slice(0, -1) : out, complete: false }
  }

  const readNumber = (): Read | null => {
    let end = at

    while (end < text.length && NUMBER_CHARS.has(text[end]!))
      end++

    // A number running to the end of the text may still grow.
    if (end === text.length)
      return null

    const token = text.slice(at, end)

    if (!NUMBER.test(token))
      throw MALFORMED

    at = end

    return { value: Number(token), complete: true }
  }

  const readLiteral = (): Read | null => {
    for (const [word, value] of Object.entries(LITERALS)) {
      if (text.startsWith(word, at)) {
        at += word.length

        return { value, complete: true }
      }

      const rest = text.slice(at)

      if (rest.length < word.length && word.startsWith(rest))
        return null
    }

    throw MALFORMED
  }

  const readObject = (depth: number): Read => {
    const object: Record<string, unknown> = {}
    let afterComma = false

    at++

    for (;;) {
      skip()

      if (at >= text.length)
        return { value: object, complete: false }

      if (text[at] === '}') {
        if (afterComma)
          throw MALFORMED

        at++

        return { value: object, complete: true }
      }

      if (text[at] !== '"')
        throw MALFORMED

      const key = readString()

      if (!key.complete)
        return { value: object, complete: false }

      skip()

      if (at >= text.length)
        return { value: object, complete: false }

      if (text[at] !== ':')
        throw MALFORMED

      at++

      const read = readValue(depth + 1)

      if (read)
        set(object, key.value, read.value)

      if (!read?.complete)
        return { value: object, complete: false }

      skip()

      if (at >= text.length)
        return { value: object, complete: false }

      if (text[at] === '}') {
        at++

        return { value: object, complete: true }
      }

      if (text[at] !== ',')
        throw MALFORMED

      at++
      afterComma = true
    }
  }

  const readArray = (depth: number): Read => {
    const items: unknown[] = []
    let afterComma = false

    at++

    for (;;) {
      skip()

      if (at >= text.length)
        return { value: items, complete: false }

      if (text[at] === ']') {
        if (afterComma)
          throw MALFORMED

        at++

        return { value: items, complete: true }
      }

      const read = readValue(depth + 1)

      if (read)
        items.push(read.value)

      if (!read?.complete)
        return { value: items, complete: false }

      skip()

      if (at >= text.length)
        return { value: items, complete: false }

      if (text[at] === ']') {
        at++

        return { value: items, complete: true }
      }

      if (text[at] !== ',')
        throw MALFORMED

      at++
      afterComma = true
    }
  }

  // Null when the value has not come far enough to show.
  function readValue(depth: number): Read | null {
    if (depth > MAX_DEPTH)
      throw MALFORMED

    skip()

    if (at >= text.length)
      return null

    const char = text[at]!

    if (char === '"')
      return readString()

    if (char === '{')
      return readObject(depth)

    if (char === '[')
      return readArray(depth)

    return char === '-' || (char >= '0' && char <= '9') ? readNumber() : readLiteral()
  }

  skip()

  if (text[at] !== '{')
    return undefined

  try {
    return readObject(0).value as Record<string, unknown>
  }
  catch (error) {
    if (error === MALFORMED)
      return undefined

    throw error
  }
}
