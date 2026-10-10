import type { SourceMap } from '../compiler'
import { dirname, relative, resolve } from 'node:path'
import process from 'node:process'
import { browserGlobalMissing } from '../compiler/globals'
import { offsetAt, positionAt } from '../compiler/mapping'
import { withoutTwin } from '../compiler/twin'

// What a `.kay` file compiled to, run as it is: a position in it maps straight back through kay's own map.
interface Compiled {
  source: string
  tsx: string
  map: SourceMap
}

// A segment of a bundle's map, fields absolute: generated column, then source, line, column and name when it has them.
type BundleSegment = number[]

interface BundleMap {
  sources: string[]
  sourcesContent?: (string | null)[]
  mappings: string
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_DIGITS = new Map([...BASE64].map((char, index) => [char, index]))
// A stack line is `at fn (path:line:column)` or `at path:line:column`, and the path may hold spaces and parentheses.
const FRAME_START = /^\s*at\s+/
const PATH_IN_PARENTHESES = /\s\((?=\/|[A-Z]:[\\/])/i
// A static component's `?island` twin is a module of its own, with its own map, shown as its `.kay` file.
const FRAME_POSITION = /\.kay(?:\?island)?:(\d+):(\d+)/
// Anything else mentioning a position, such as an error message.
const KAY_POSITION = /([^\s()]+\.kay(?:\?island)?):(\d+):(\d+)/g
const FIRST_KAY_POSITION = /([^\s()]+\.kay):(\d+):(\d+)/
const VLQ_CONTINUATION = 32
const VLQ_VALUE = 31

// Bun reports positions in the JavaScript a plugin returns and ignores any source map with it, so kay maps `.kay` frames itself.
// A file the compile cache served compiles again for its maps only when a stack needs them.
const compiled = new Map<string, Compiled | (() => Compiled)>()
// A file's browser build differs from its server one, so island bundles read maps of their own.
const browserCompiled = new Map<string, Compiled | (() => Compiled)>()
const mappedBundles = new Map<string, Promise<void>>()

export function registerSourceMap(file: string, entry: Compiled | (() => Compiled), browser = false): void {
  (browser ? browserCompiled : compiled).set(file, entry)
}

function compiledFor(file: string, registry = compiled): Compiled | undefined {
  let entry = registry.get(file)

  if (typeof entry === 'function') {
    entry = entry()
    registry.set(file, entry)
  }

  return entry
}

// Bun maps a bundle to the JavaScript a plugin returned and ignores any map that came with it, so the `.kay` sources of an island bundle's map are pointed on at their `.kay` lines and text.
// Done once per file, when a browser first asks for it: a module the compile cache served compiles again for its map.
export async function mapBundleToKay(mapFile: string): Promise<void> {
  let mapping = mappedBundles.get(mapFile)

  if (!mapping)
    mappedBundles.set(mapFile, mapping = rewriteBundleMap(mapFile))

  await mapping
}

// A new client build writes its maps afresh, under names an earlier one may have used.
export function forgetBundleMaps(): void {
  mappedBundles.clear()
}

async function rewriteBundleMap(mapFile: string): Promise<void> {
  const bundle = await Bun.file(mapFile).json() as BundleMap
  const entries = bundle.sources.map(source => compiledFor(resolve(dirname(mapFile), source), browserCompiled))

  if (entries.every(entry => entry === undefined))
    return

  const lines = decodeBundleMappings(bundle.mappings).map(segments => segments.map((segment) => {
    const entry = segment.length > 1 ? entries[segment[1]!] : undefined

    if (!entry)
      return segment

    const position = toKay(entry, segment[2]! + 1, segment[3]! + 1)

    // A segment the `.kay` source has no counterpart for keeps its column only.
    return position ? [segment[0]!, segment[1]!, position.line - 1, position.column - 1, ...segment.slice(4)] : [segment[0]!]
  }))

  bundle.sourcesContent = bundle.sources.map((_source, index) => entries[index]?.source ?? bundle.sourcesContent?.[index] ?? null)
  bundle.mappings = encodeBundleMappings(lines)
  await Bun.write(mapFile, JSON.stringify(bundle))
}

export function decodeBundleMappings(mappings: string): BundleSegment[][] {
  const fields = [0, 0, 0, 0, 0]

  return mappings.split(';').map((line) => {
    fields[0] = 0

    return line.split(',').filter(segment => segment !== '').map((segment) => {
      const values = decodeVlq(segment)

      for (const [index, value] of values.entries())
        fields[index]! += value

      return fields.slice(0, values.length)
    })
  })
}

function encodeBundleMappings(lines: BundleSegment[][]): string {
  const fields = [0, 0, 0, 0, 0]

  return lines.map((segments) => {
    fields[0] = 0

    return segments.map(segment => segment.map((value, index) => {
      const delta = value - fields[index]!

      fields[index] = value

      return encodeVlq(delta)
    }).join('')).join(',')
  }).join(';')
}

function encodeVlq(value: number): string {
  let rest = value < 0 ? (-value << 1) | 1 : value << 1
  let encoded = ''

  do {
    const digit = rest & VLQ_VALUE

    rest >>>= 5
    encoded += BASE64[rest > 0 ? digit | VLQ_CONTINUATION : digit]
  } while (rest > 0)

  return encoded
}

// Points every `.kay` frame of a stack at the line and column of the `.kay` source; other frames are left as they are.
export function mapStack(stack: string): string {
  return stack.split('\n').map((text) => {
    const position = FRAME_POSITION.exec(text)
    const start = FRAME_START.exec(text)

    if (!position || !start)
      return text.replace(KAY_POSITION, (found, file: string, line: string, column: string) => mapPosition(file, line, column) ?? found)

    const parenthesised = text.search(PATH_IN_PARENTHESES)
    const from = parenthesised !== -1 && parenthesised < position.index ? parenthesised + 2 : start[0].length
    const file = text.slice(from, position.index + position[0].indexOf(':'))
    const end = position.index + position[0].length

    return `${text.slice(0, from)}${mapPosition(file, position[1]!, position[2]!) ?? text.slice(from, end)}${text.slice(end)}`
  }).join('\n')
}

function mapPosition(file: string, line: string, column: string): string | undefined {
  const module = compiledFor(file)
  const position = module && toKay(module, Number(line), Number(column))

  return position ? `${withoutTwin(file)}:${position.line}:${position.column}` : undefined
}

// Bun would print the compiled code around the throw, so an error goes out as its stack mapped to `.kay` lines, after what to do about a browser-only global.
// A `heading` goes in the same call, so no other line comes between them.
export function logError(error: unknown, heading?: string): void {
  const stack = error instanceof Error && error.stack !== undefined && error.stack !== '' ? mapStack(error.stack) : undefined
  const hint = stack !== undefined && stack !== '' ? browserOnlyHint(error, stack) : undefined
  const text = hint !== undefined && hint !== '' ? `${hint}\n${stack}` : stack

  if (heading === undefined)
    console.error(text ?? error)
  else
    console.error(`${heading}\n${text ?? Bun.inspect(error)}`)
}

// What a server render failing on a browser-only global should say: the global, the `.kay` line reading it, and the two ways out.
export function browserOnlyHint(error: unknown, mappedStack: string): string | undefined {
  const name = browserGlobalMissing(error)

  if (name === undefined)
    return undefined

  const at = FIRST_KAY_POSITION.exec(mappedStack)
  const where = at ? `${relative(process.cwd(), at[1]!)}:${at[2]}:${at[3]}` : 'a component'

  return `\`${name}\` exists only in the browser, and rendering ${where} on the server read it: read it in \`effect\` or \`onMount\`, or render the component in the browser only with \`--- client\``
}

function toKay(entry: Compiled, line: number, column: number): { line: number, column: number } | undefined {
  const source = entry.map.toSource(offsetAt(entry.tsx, { line, column }))

  return source === undefined ? undefined : positionAt(entry.source, source)
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
