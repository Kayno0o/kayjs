import type { Span } from './ast'
import type { Expansion } from './markdown-block'

// A run of generated code copied character for character from the source.
export interface Mapping {
  generated: number
  source: number
  length: number
}

// Generated glue standing for a whole source construct, used when an offset falls outside every exact mapping.
export interface RangeMapping {
  generated: Span
  source: Span
}

// Text replaced or wrapped while copying a source span: `todo` becomes `todo()`, `a` becomes `__props.a`.
export interface Rewrite {
  before?: string | undefined
  replace?: string | undefined
  after?: string | undefined
  // The name is a component tag the rewrite cannot spell as one: it opens as `KayDynamic component={...}`.
  dynamic?: boolean | undefined
}

const BLANK = /^\s*$/

export const DYNAMIC_TAG = 'KayDynamic'

export class CodeBuilder {
  code = ''
  readonly mappings: Mapping[] = []
  readonly ranges: RangeMapping[] = []
  private readonly bodyStarts: number[] = []

  // The rewrites by where they start, so a span finds the ones inside it by bisection rather than scanning them all.
  private readonly sorted: [number, Rewrite & { end: number }][]

  constructor(private readonly source: string, rewrites: ReadonlyMap<number, Rewrite & { end: number }> = new Map()) {
    this.sorted = [...rewrites].sort((a, b) => a[0] - b[0])
  }

  add(text: string): this {
    this.code += text

    return this
  }

  // The same code as `addSource`, mapped to nothing: for a copy of a span whose messages the mapped copy already carries.
  addUnmapped(span: Span): this {
    const mappings = this.mappings.length
    const ranges = this.ranges.length

    this.addSource(span)
    this.mappings.length = mappings
    this.ranges.length = ranges

    return this
  }

  // Copies a source span verbatim and maps it, applying any rewrite anchored inside it.
  addSource(span: Span): this {
    let cursor = span.start

    for (const [start, rewrite] of this.rewritesIn(span)) {
      this.copy(cursor, start)

      const wrapped = this.code.length

      this.code += rewrite.before ?? ''

      if (rewrite.replace === undefined) {
        this.copy(start, rewrite.end)

        // What wraps the name maps to it, so an error on the whole of `(void count, __values.count)` lands on `count`.
        if (rewrite.before !== undefined || rewrite.after !== undefined)
          this.ranges.push({ generated: { start: wrapped, end: this.code.length + (rewrite.after?.length ?? 0) }, source: { start, end: rewrite.end } })
      }
      else {
        const generated = this.code.length

        this.code += rewrite.replace
        this.ranges.push({ generated: { start: generated, end: this.code.length }, source: { start, end: rewrite.end } })
      }

      this.code += rewrite.after ?? ''
      cursor = rewrite.end
    }
    this.copy(cursor, span.end)

    return this
  }

  // A span of a fence's body, whose lines the generated code indents one level.
  addBody(span: Span): this {
    const start = this.code.length

    this.addSource(span)

    const first = this.code.lastIndexOf('\n', start - 1) + 1

    // A span that starts after the indentation of its line is the line's.
    if (BLANK.test(this.code.slice(first, start)))
      this.noteBodyLine(first)

    for (let at = this.code.indexOf('\n', start); at !== -1 && at + 1 < this.code.length; at = this.code.indexOf('\n', at + 1))
      this.noteBodyLine(at + 1)

    return this
  }

  // The generated offsets where a line copied from a fence's body starts, a blank one aside: a linter reads them one level deeper than the file writes them, as the fence sits in the body of a function the generated code wraps it in.
  get bodyLines(): number[] {
    return this.bodyStarts.filter(line => !BLANK.test(this.code.slice(line, (this.code.indexOf('\n', line) + 1 || this.code.length + 1) - 1)))
  }

  private noteBodyLine(line: number) {
    if (this.bodyStarts.at(-1) !== line)
      this.bodyStarts.push(line)
  }

  // A component tag's name, which `KayDynamic` takes as a value when it is read through a call or a default; returns whether it did, so the closing tag matches.
  addTag(span: Span): boolean {
    const dynamic = this.isDynamicTag(span)

    if (dynamic)
      this.code += `${DYNAMIC_TAG} component={`

    this.addSource(span)

    if (dynamic)
      this.code += '}'

    return dynamic
  }

  // Whether a component tag is read through a call or a default, and so names a value rather than a component.
  isDynamicTag(span: Span): boolean {
    return this.rewritesIn(span).some(([, rewrite]) => rewrite.dynamic)
  }

  // Maps everything `emit` generates back to `source` as one range.
  wrap(source: Span, emit: () => void): this {
    const start = this.code.length

    emit()
    this.ranges.push({ generated: { start, end: this.code.length }, source })

    return this
  }

  map(): SourceMap {
    return new SourceMap(this.mappings, this.ranges)
  }

  private copy(start: number, end: number) {
    if (end <= start)
      return

    this.mappings.push({ generated: this.code.length, source: start, length: end - start })
    this.code += this.source.slice(start, end)
  }

  private rewritesIn(span: Span): [number, Rewrite & { end: number }][] {
    const found: [number, Rewrite & { end: number }][] = []
    let low = 0
    let high = this.sorted.length

    while (low < high) {
      const middle = (low + high) >> 1

      if (this.sorted[middle]![0] < span.start)
        low = middle + 1
      else
        high = middle
    }

    for (let index = low; index < this.sorted.length && this.sorted[index]![0] <= span.end; index++) {
      if (this.sorted[index]![1].end <= span.end)
        found.push(this.sorted[index]!)
    }

    return found
  }
}

export class SourceMap {
  private readonly byGenerated: Mapping[]
  private readonly bySource: Mapping[]

  constructor(mappings: Mapping[], private readonly ranges: RangeMapping[]) {
    this.byGenerated = [...mappings].sort((a, b) => a.generated - b.generated)
    this.bySource = [...mappings].sort((a, b) => a.source - b.source)
  }

  // What a cached map is written as and read back from.
  toJSON(): { mappings: Mapping[], ranges: RangeMapping[] } {
    return { mappings: this.byGenerated, ranges: this.ranges }
  }

  static fromJSON({ mappings, ranges }: ReturnType<SourceMap['toJSON']>): SourceMap {
    return new SourceMap(mappings, ranges)
  }

  // The source offset a generated offset came from: exact when copied, else the start of the tightest construct around it.
  toSource(generated: number): number | undefined {
    const exact = findContaining(this.byGenerated, generated, mapping => mapping.generated)

    if (exact)
      return exact.source + generated - exact.generated

    let best: RangeMapping | undefined

    for (const range of this.ranges) {
      if (generated < range.generated.start || generated > range.generated.end)
        continue

      if (!best || range.generated.end - range.generated.start < best.generated.end - best.generated.start)
        best = range
    }

    return best?.source.start
  }

  // The source a generated span was copied from when one verbatim run holds all of it, so an edit to it can be made to the source instead.
  toSourceSpan(start: number, end: number): Span | undefined {
    const exact = findContaining(this.byGenerated, start, mapping => mapping.generated)

    return exact && end <= exact.generated + exact.length ? { start: exact.source + start - exact.generated, end: exact.source + end - exact.generated } : undefined
  }

  // The map of code generated from the expanded source of a file with `markdown` blocks, as if it were generated from the file: what the lowering made up stands for the block's keyword.
  expanded(expansion: Expansion): SourceMap {
    const mappings: Mapping[] = []
    const ranges = this.ranges.map(range => ({ ...range, source: expansion.realSpan(range.source) }))

    for (const mapping of this.byGenerated) {
      for (const piece of expansion.split({ start: mapping.source, end: mapping.source + mapping.length })) {
        const generated = mapping.generated + piece.start - mapping.source

        if (piece.real === undefined)
          ranges.push({ generated: { start: generated, end: generated + piece.end - piece.start }, source: expansion.keyword(piece.block!) })
        else
          mappings.push({ generated, source: piece.real, length: piece.end - piece.start })
      }
    }

    return new SourceMap(mappings, ranges)
  }

  toGenerated(source: number): number | undefined {
    const exact = findContaining(this.bySource, source, mapping => mapping.source)

    return exact && exact.generated + source - exact.source
  }

  // Generated code may copy a name more than once, as a loop's item into its key function and its row; a run ending where the name starts is no copy of it.
  toGeneratedAll(source: number): number[] {
    return this.bySource.filter(mapping => mapping.source <= source && source < mapping.source + mapping.length).map(mapping => mapping.generated + source - mapping.source)
  }

  // True when the generated offset was copied from the source, so a diagnostic there is the user's own code.
  isExact(generated: number): boolean {
    return findContaining(this.byGenerated, generated, mapping => mapping.generated) !== undefined
  }
}

// Binary search for the mapping whose run covers `offset`, the run end included so an offset just past an identifier still maps.
function findContaining(sorted: Mapping[], offset: number, startOf: (mapping: Mapping) => number): Mapping | undefined {
  let low = 0
  let high = sorted.length - 1
  let found: Mapping | undefined

  while (low <= high) {
    const middle = (low + high) >> 1
    const mapping = sorted[middle]!

    if (startOf(mapping) <= offset) {
      found = mapping
      low = middle + 1
    }
    else {
      high = middle - 1
    }
  }

  return found && offset <= startOf(found) + found.length ? found : undefined
}

export interface Position {
  line: number
  column: number
}

// 1-based line and column, the way editors and tsc print them.
export function positionAt(source: string, offset: number): Position {
  let line = 1
  let lineStart = 0

  for (let i = source.indexOf('\n'); i !== -1 && i < offset; i = source.indexOf('\n', i + 1)) {
    line++
    lineStart = i + 1
  }

  return { line, column: offset - lineStart + 1 }
}

// A column past the end of its line stops at that end, as LSP positions do, rather than running into the next line.
export function offsetAt(source: string, position: Position): number {
  let offset = 0

  for (let line = 1; line < position.line; line++) {
    const next = source.indexOf('\n', offset)

    if (next === -1)
      return source.length

    offset = next + 1
  }

  const newline = source.indexOf('\n', offset)
  const end = newline === -1 ? source.length : newline - Number(source[newline - 1] === '\r')

  return Math.min(offset + position.column - 1, end)
}
