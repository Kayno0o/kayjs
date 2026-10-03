import type { SourceMap } from '../compiler'
import { offsetAt, positionAt } from '../compiler/mapping'

// A generated column and the 0-based source line and column it came from.
type Segment = [column: number, sourceLine: number, sourceColumn: number]

interface Compiled {
  source: string
  tsx: string
  map: SourceMap
  // Solid's v3 map from its JavaScript back to the TSX, decoded on the first stack that needs it.
  solidMap: string
  lines?: Segment[][]
}

const BASE64_DIGITS = new Map([...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'].map((char, index) => [char, index]))
const KAY_FRAME = /([^\s()]+\.kay):(\d+):(\d+)/g
const VLQ_CONTINUATION = 32
const VLQ_VALUE = 31

// Bun reports positions in the JavaScript a plugin returns and ignores any source map with it, so kay maps `.kay` frames itself.
// A file the compile cache served compiles again for its maps only when a stack needs them.
const compiled = new Map<string, Compiled | (() => Compiled)>()

export function registerSourceMap(file: string, entry: Omit<Compiled, 'lines'> | (() => Omit<Compiled, 'lines'>)): void {
  compiled.set(file, entry)
}

function compiledFor(file: string): Compiled | undefined {
  let entry = compiled.get(file)

  if (typeof entry === 'function') {
    entry = entry()
    compiled.set(file, entry)
  }

  return entry
}

// Points every `.kay` frame of a stack at the line and column of the `.kay` source; other frames are left as they are.
export function mapStack(stack: string): string {
  return stack.replace(KAY_FRAME, (frame, file: string, line: string, column: string) => {
    const module = compiledFor(file)
    const position = module && toKay(module, Number(line), Number(column))

    return position ? `${file}:${position.line}:${position.column}` : frame
  })
}

// Bun would print the compiled code around the throw, so an error goes out as its stack mapped to `.kay` lines.
export function logError(error: unknown): void {
  console.error(error instanceof Error && error.stack ? mapStack(error.stack) : error)
}

function toKay(entry: Compiled, line: number, column: number): { line: number, column: number } | undefined {
  entry.lines ??= decodeMappings((JSON.parse(entry.solidMap) as { mappings: string }).mappings)

  let found: Segment | undefined

  for (const segment of entry.lines[line - 1] ?? []) {
    if (segment[0] > column - 1)
      break

    found = segment
  }

  if (!found)
    return undefined

  const source = entry.map.toSource(offsetAt(entry.tsx, { line: found[1] + 1, column: found[2] + 1 }))

  return source === undefined ? undefined : positionAt(entry.source, source)
}

function decodeMappings(mappings: string): Segment[][] {
  const lines: Segment[][] = []
  let sourceLine = 0
  let sourceColumn = 0

  for (const line of mappings.split(';')) {
    const segments: Segment[] = []
    let column = 0

    for (const segment of line.split(',')) {
      if (segment === '')
        continue

      const values = decodeVlq(segment)

      column += values[0]!

      if (values.length < 4)
        continue

      sourceLine += values[2]!
      sourceColumn += values[3]!
      segments.push([column, sourceLine, sourceColumn])
    }

    lines.push(segments)
  }

  return lines
}

function decodeVlq(segment: string): number[] {
  const values: number[] = []
  let value = 0
  let shift = 0

  for (const char of segment) {
    const digit = BASE64_DIGITS.get(char) ?? 0

    value += (digit & VLQ_VALUE) << shift

    if (digit & VLQ_CONTINUATION) {
      shift += 5

      continue
    }

    values.push(value & 1 ? -(value >>> 1) : value >>> 1)
    value = 0
    shift = 0
  }

  return values
}
