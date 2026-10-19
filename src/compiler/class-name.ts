// What a shorthand class holds outside a group: Tailwind's variants and utilities, `*:` and `**:` included.
const PLAIN_RUN = /[\w\-:/@!*]+/y
// A decimal's digits, which must not run into a letter: `.2xl:flex` starts a class where `.5` ends one.
const DECIMAL_DIGITS = /\d+\b/y
const WHITESPACE = /\s/
// A token made of digits that no letter follows, `5/6` or `1.5`, which only the middle of a class can hold.
const NUMBER_START = /^\d+\b/
const DIGIT = /\d/
const CLOSERS: Record<string, string> = { '[': ']', '(': ')' }

export interface ClassScan {
  // The position just past the class, which stops at the first character the shorthand does not take.
  end: number
  // Set when a `[` or a `-(` group does not close before a space or the end of the source; `end` then runs to that space.
  unclosed?: { at: number, group: string }
}

// Reads the shorthand class starting at `from`: `[A-Za-z0-9_-:/@!*]`, a `.` between digits when digits alone follow it (`gap-1.5`), a balanced `[...]` group (`w-[calc(100%-2rem)]`) and a balanced `(...)` group right after a `-` (`bg-(--brand)`).
// Everything inside a group is part of the class, so `#`, `.`, `,` and a quote in it open nothing.
export function scanClassName(src: string, from: number): ClassScan {
  let i = from

  while (i < src.length) {
    PLAIN_RUN.lastIndex = i

    if (PLAIN_RUN.test(src)) {
      i = PLAIN_RUN.lastIndex

      continue
    }

    const char = src[i]!

    if (char === '.' && isDecimalDot(src, i)) {
      i++
    }
    else if (char === '[' || (char === '(' && src[i - 1] === '-')) {
      const end = groupEnd(src, i)

      if (end === -1)
        return { end: tokenEnd(src, i), unclosed: { at: i, group: char } }

      i = end
    }
    else {
      break
    }
  }

  return { end: i }
}

// Whether the whole of `token` is one shorthand class, which a pasted class attribute may be folded into.
// One ending in `-` or `:` would take the `(` or the space after it, and one made of digits would join the decimal before it.
export function isClassToken(token: string): boolean {
  const scan = scanClassName(token, 0)

  return token !== '' && scan.unclosed === undefined && scan.end === token.length && !token.endsWith('-') && !token.endsWith(':') && !NUMBER_START.test(token)
}

function isDecimalDot(src: string, at: number): boolean {
  if (!DIGIT.test(src[at - 1] ?? ''))
    return false

  DECIMAL_DIGITS.lastIndex = at + 1

  return DECIMAL_DIGITS.test(src)
}

// The position just past the group opened at `open`, or -1 when a space or the end of the source comes first.
function groupEnd(src: string, open: number): number {
  const opener = src[open]!
  const closer = CLOSERS[opener]!
  let depth = 0

  for (let i = open; i < src.length; i++) {
    const char = src[i]!

    if (WHITESPACE.test(char))
      return -1

    // A bracket inside a quoted value, `content-['[']`, closes nothing.
    if (char === '\'' || char === '"') {
      const quoted = quotedEnd(src, i)

      if (quoted !== -1) {
        i = quoted

        continue
      }
    }

    if (char === opener)
      depth++
    else if (char === closer && --depth === 0)
      return i + 1
  }

  return -1
}

// The position of the quote closing the one at `open`, or -1 when a space or the end of the source comes first.
function quotedEnd(src: string, open: number): number {
  for (let i = open + 1; i < src.length && !WHITESPACE.test(src[i]!); i++) {
    if (src[i] === src[open])
      return i
  }

  return -1
}

function tokenEnd(src: string, from: number): number {
  let i = from

  while (i < src.length && !WHITESPACE.test(src[i]!))
    i++

  return i
}
