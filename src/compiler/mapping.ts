import type { Span } from './ast'

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
  before?: string
  replace?: string
  after?: string
  // The name is a component tag the rewrite cannot spell as one: it opens as `KayDynamic component={...}`.
  dynamic?: boolean
}

export const DYNAMIC_TAG = 'KayDynamic'

export class CodeBuilder {
  code = ''
  readonly mappings: Mapping[] = []
  readonly ranges: RangeMapping[] = []

  constructor(private readonly source: string, private readonly rewrites: ReadonlyMap<number, Rewrite & { end: number }> = new Map()) {}

  add(text: string): this {
    this.code += text

    return this
  }

  // Copies a source span verbatim and maps it, applying any rewrite anchored inside it.
  addSource(span: Span): this {
    let cursor = span.start

    for (const [start, rewrite] of this.rewritesIn(span)) {
      this.copy(cursor, start)
      this.code += rewrite.before ?? ''

      if (rewrite.replace === undefined) {
        this.copy(start, rewrite.end)
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

    for (const entry of this.rewrites) {
      if (entry[0] >= span.start && entry[1].end <= span.end)
        found.push(entry)
    }

    return found.sort((a, b) => a[0] - b[0])
  }
}

export class SourceMap {
  private readonly byGenerated: Mapping[]
  private readonly bySource: Mapping[]

  constructor(mappings: Mapping[], private readonly ranges: RangeMapping[]) {
    this.byGenerated = [...mappings].sort((a, b) => a.generated - b.generated)
    this.bySource = [...mappings].sort((a, b) => a.source - b.source)
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
  const end = newline === -1 ? source.length : source[newline - 1] === '\r' ? newline - 1 : newline

  return Math.min(offset + position.column - 1, end)
}
