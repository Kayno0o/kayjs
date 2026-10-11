// A JavaScript lexer only as deep as finding where code ends needs: strings, template literals, comments, regex literals and brackets are stepped over whole.

const WHITESPACE = /\s/
// What a `/` after one of these characters starts: a regex literal, since an operand is expected there.
// A `}` most often ends a block, which a statement may follow; a `)` most often ends an operand, which a division follows.
const REGEX_PRECEDERS = new Set('(,=:[!&|?{};+-*%<>~^')
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'void', 'delete', 'in', 'of', 'instanceof', 'new', 'throw', 'case', 'yield', 'await', 'else', 'do'])
const WORD_BEFORE = /[\w$]+$/
const REGEX_FLAGS = /[a-z]*/iy
const CLOSERS = { '{': '}', '(': ')', '[': ']' } as const

export class Scanner {
  constructor(private readonly src: string, private readonly error: (start: number, end: number, message: string) => void) {}

  // The position just past the bracket matching the one at `open`.
  balanced(open: number): number {
    const { src } = this
    const closers: string[] = []
    let i = open

    while (i < src.length) {
      const char = src[i]!

      if (char === '"' || char === '\'') {
        i = this.string(i, char)

        continue
      }

      if (char === '`') {
        i = this.template(i)

        continue
      }

      if (char === '/' && src[i + 1] === '/') {
        i = this.lineEnd(i)

        continue
      }

      if (char === '/' && src[i + 1] === '*') {
        i = this.blockComment(i)

        continue
      }

      if (char === '/') {
        const end = this.regex(open, i)

        if (end !== -1) {
          i = end

          continue
        }
      }

      i++

      if (char === '{' || char === '(' || char === '[') {
        closers.push(CLOSERS[char])

        continue
      }

      if (char !== '}' && char !== ')' && char !== ']')
        continue

      if (closers.pop() !== char) {
        this.error(i - 1, i, `Unbalanced \`${char}\``)

        return i
      }

      if (closers.length === 0)
        return i
    }

    this.error(open, open + 1, `Unclosed \`${src[open]}\``)

    return src.length
  }

  template(open: number): number {
    const { src } = this
    let i = open + 1

    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') {
        i += 2

        continue
      }

      if (src[i] === '$' && src[i + 1] === '{') {
        i = this.balanced(i + 1)

        continue
      }

      i++
    }

    if (i >= src.length) {
      this.error(open, open + 1, 'Unclosed template literal')

      return src.length
    }

    return i + 1
  }

  blockComment(open: number): number {
    const close = this.src.indexOf('*/', open + 2)

    return close === -1 ? this.src.length : close + 2
  }

  // A string stops at the end of its line, where it cannot run on.
  string(open: number, quote: string): number {
    const { src } = this
    let i = open + 1

    while (i < src.length && src[i] !== quote && src[i] !== '\n')
      i += src[i] === '\\' ? 2 : 1

    return src[i] === quote ? i + 1 : i
  }

  // The position just past the regex literal starting at `at`, or -1 when a `/` there divides or the literal does not close on its line; `from` bounds the look back at the previous token.
  regex(from: number, at: number): number {
    const { src } = this
    let before = at - 1

    while (before >= from && WHITESPACE.test(src[before]!))
      before--

    const previous = before < from ? '{' : src[before]!
    const word = WORD_BEFORE.exec(src.slice(from, before + 1))?.[0]
    const doubled = (previous === '+' || previous === '-') && src[before - 1] === previous

    if (doubled || !(REGEX_PRECEDERS.has(previous) || (word !== undefined && REGEX_KEYWORDS.has(word))))
      return -1

    let inClass = false

    for (let i = at + 1; i < src.length && src[i] !== '\n'; i++) {
      const char = src[i]

      if (char === '\\') {
        i++
      }
      else if (char === '[') {
        inClass = true
      }
      else if (char === ']') {
        inClass = false
      }
      else if (char === '/' && !inClass) {
        REGEX_FLAGS.lastIndex = i + 1
        REGEX_FLAGS.test(src)

        return REGEX_FLAGS.lastIndex
      }
    }

    return -1
  }

  lineEnd(from: number): number {
    const end = this.src.indexOf('\n', from)

    return end === -1 ? this.src.length : end
  }
}
