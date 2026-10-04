import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeBundleMappings } from '../src/build/sourcemap'

export interface SourceMapFile {
  sources: string[]
  mappings: string
}

// A bundle file with its map decoded once, for its bytes and its profiled functions alike.
export interface Chunk {
  // The origin of each of the map's sources, by index.
  origins: string[]
  segments: number[][][]
  pieces: Piece[]
}

// A run of a bundle's text and where it came from.
export interface Piece {
  origin: string
  text: string
}

export interface CallFrame {
  functionName: string
  url: string
  scriptId: string
  lineNumber: number
  columnNumber: number
}

export interface ProfileNode {
  id: number
  callFrame: CallFrame
  children?: number[]
}

// A CPU profile as the inspector protocol returns it, from Chromium and from Bun alike.
export interface CpuProfile {
  nodes: ProfileNode[]
  samples: number[]
  timeDeltas: number[]
}

// A frame's origin, or undefined for a native one, whose time goes to the JavaScript that called it.
export type FrameOrigin = (frame: CallFrame) => string | undefined

export const KAY = 'kay'
export const APP = 'app'
export const BUNDLER = 'bundler'
export const GC = 'GC'
export const ENGINE = 'engine'
// Playwright's evaluations: nearly all of their time is the style and layout the timing loop forces once the DOM holds the result.
export const LAYOUT = 'style and layout'
export const INLINE = 'inline scripts'

// The last `node_modules` of a path names its package.
const PACKAGE = /.*node_modules\/((?:@[^/]+\/)?[^/]+)\//
// What a build with source maps adds to each file: a debug id and the map's URL.
const SOURCE_MAP_COMMENTS = /(?:\n\/\/# (?:debugId|sourceMappingURL)=\S+)+\s*$/
const REPO = resolve(import.meta.dir, '..')
// The profiler's own nodes: `(idle)` is left out, `(program)` and `(root)` are the engine's.
const META_FRAMES = new Map([['(garbage collector)', GC], ['(program)', ENGINE], ['(root)', ENGINE], ['(idle)', undefined]])

// kay (its sources and the entry it generates), the benchmarked app, or the package a file belongs to.
export function originOf(path: string): string {
  const name = PACKAGE.exec(path)?.[1]

  if (name !== undefined)
    return name === 'kay' ? KAY : name

  const file = path.startsWith('file:') ? fileURLToPath(path) : path

  if (!isAbsolute(file))
    return 'other'

  const inRepo = relative(REPO, file)

  if (inRepo.startsWith('src/') || inRepo.includes('/.kay/'))
    return KAY

  return inRepo.startsWith('bench/') ? APP : 'other'
}

export function readChunk(code: string, map: SourceMapFile, mapFile: string): Chunk {
  const origins = map.sources.map(source => originOf(resolve(dirname(mapFile), source)))
  const segments = decodeBundleMappings(map.mappings)

  return { origins, segments, pieces: piecesOf(code, origins, segments) }
}

// A bundle split into runs of text by the source each came from; text no source covers, newlines included, is the bundler's.
function piecesOf(code: string, origins: string[], segments: number[][][]): Piece[] {
  const lines = code.replace(SOURCE_MAP_COMMENTS, '').split('\n')
  const pieces: Piece[] = []

  for (const [index, line] of lines.entries()) {
    const starts = segments[index] ?? []

    pieces.push({ origin: BUNDLER, text: line.slice(0, starts[0]?.[0] ?? line.length) })

    for (const [at, segment] of starts.entries())
      pieces.push({ origin: segment.length >= 4 ? origins[segment[1]!]! : BUNDLER, text: line.slice(segment[0], starts[at + 1]?.[0] ?? line.length) })

    if (index < lines.length - 1)
      pieces.push({ origin: BUNDLER, text: '\n' })
  }

  return pieces.filter(piece => piece.text !== '')
}

export interface OriginBytes {
  raw: number
  // How much smaller the gzipped file gets without this origin's text: what dropping it saves on the wire.
  gzipSaved: number
}

// Raw bytes and gzip savings of each origin over several files, each gzipped on its own as the browser receives it.
export function bytesByOrigin(files: Piece[][]): Map<string, OriginBytes> {
  const totals = new Map<string, OriginBytes>()

  for (const pieces of files) {
    const whole = gzipSize(pieces.map(piece => piece.text).join(''))

    for (const origin of new Set(pieces.map(piece => piece.origin))) {
      const kept = pieces.filter(piece => piece.origin !== origin)
      const total = totals.get(origin) ?? { raw: 0, gzipSaved: 0 }

      total.raw += pieces.filter(piece => piece.origin === origin).reduce((sum, piece) => sum + Buffer.byteLength(piece.text), 0)
      total.gzipSaved += whole - gzipSize(kept.map(piece => piece.text).join(''))
      totals.set(origin, total)
    }
  }

  return totals
}

export function gzipSize(text: string): number {
  return Bun.gzipSync(text).length
}

// Microseconds of each origin in a profile: a sample's time is the delta to the next one, counted for its frame, or for the nearest caller with an origin.
export function timeByOrigin(profile: CpuProfile, originOfFrame: FrameOrigin): Map<string, number> {
  const parents = new Map<number, ProfileNode>()
  const nodes = new Map(profile.nodes.map(node => [node.id, node]))
  const resolved = new Map<number, string | undefined>()
  const totals = new Map<string, number>()

  for (const node of profile.nodes) {
    for (const child of node.children ?? [])
      parents.set(child, node)
  }

  const originOfNode = (node: ProfileNode): string | undefined => {
    if (resolved.has(node.id))
      return resolved.get(node.id)

    const { functionName } = node.callFrame
    const parent = parents.get(node.id)
    const origin = META_FRAMES.has(functionName) ? META_FRAMES.get(functionName) : originOfFrame(node.callFrame) ?? (parent ? originOfNode(parent) : ENGINE)

    resolved.set(node.id, origin)

    return origin
  }

  for (const [index, id] of profile.samples.entries()) {
    const origin = originOfNode(nodes.get(id)!)
    const time = profile.timeDeltas[index + 1] ?? 0

    if (origin !== undefined)
      totals.set(origin, (totals.get(origin) ?? 0) + time)
  }

  return totals
}

// The origin of a bundle position: that of the last segment at or before the column on that line.
function originAt(chunk: Chunk, line: number, column: number): string {
  let found: number[] | undefined

  for (const segment of chunk.segments[line] ?? []) {
    if (segment[0]! > column)
      break

    found = segment
  }

  return found && found.length >= 4 ? chunk.origins[found[1]!]! : BUNDLER
}

// A Chromium frame's origin: a chunk's function by where its first character comes from, a native one left to its caller, and a page's inline scripts together.
export function browserOrigin(chunks: Map<string, Chunk>): FrameOrigin {
  return (frame) => {
    if (frame.url === '')
      return frame.scriptId === '0' ? undefined : LAYOUT

    const chunk = chunks.get(basename(new URL(frame.url).pathname))

    return chunk === undefined ? INLINE : originAt(chunk, frame.lineNumber, frame.columnNumber)
  }
}
