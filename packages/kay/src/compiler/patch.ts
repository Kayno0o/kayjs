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
