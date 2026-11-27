// Zero-dependency span patcher (replaces magic-string for fast TSX AST transforms).

interface Patch {
  start: number
  end: number
  text: string
}

export class SourceEditor {
  readonly #source: string
  readonly #patches: Patch[] = []
  readonly #prepends: string[] = []
  readonly #appends: string[] = []

  constructor(source: string) {
    this.#source = source
  }

  replace(start: number, end: number, text: string): void {
    this.#patches.push({ start, end, text })
  }

  remove(start: number, end: number): void {
    this.#patches.push({ start, end, text: '' })
  }

  prepend(text: string): void {
    this.#prepends.push(text)
  }

  append(text: string): void {
    this.#appends.push(text)
  }

  toString(): string {
    const patches = this.#patches.slice().sort((a, b) => a.start - b.start || a.end - b.end)
    let out = this.#prepends.join('')
    let cursor = 0

    for (let i = 0; i < patches.length; i++) {
      const p = patches[i]!
      if (p.start < cursor)
        throw new Error(`kay compiler: overlapping source patch [${p.start}, ${p.end}] overlaps previous end ${cursor}`)
      out += this.#source.slice(cursor, p.start)
      out += p.text
      cursor = p.end
    }

    out += this.#source.slice(cursor)
    if (this.#appends.length > 0)
      out += this.#appends.join('')
    return out
  }
}

// A mark holds a source line inside generated code; `alignLines` turns it into the newlines that put the code after it back on that line.
const LINE_MARK_RE = /\/\*\x01(\d+)\*\//g

/** Marks the source line of an offset, for code spliced where a newline is allowed (an expression's start, never after `return`). */
export function lineMarker(source: string): (offset: number) => string {
  let starts: number[] | undefined
  return (offset) => {
    if (starts === undefined) {
      starts = [0]
      for (let i = source.indexOf('\n'); i !== -1; i = source.indexOf('\n', i + 1))
        starts.push(i + 1)
    }
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid]! <= offset)
        lo = mid
      else
        hi = mid - 1
    }
    return `/*\x01${lo + 1}*/`
  }
}

/** Replaces each line mark with the newlines that bring the code after it down to its source line, so a stack trace names the line it was written on. */
export function alignLines(code: string): string {
  if (!code.includes('\x01'))
    return code
  let line = 1
  let last = 0
  return code.replace(LINE_MARK_RE, (mark: string, target: string, at: number) => {
    for (let i = code.indexOf('\n', last); i !== -1 && i < at; i = code.indexOf('\n', i + 1))
      line++
    last = at + mark.length
    const pad = Number(target) - line
    if (pad <= 0)
      return ''
    line += pad
    return '\n'.repeat(pad)
  })
}
