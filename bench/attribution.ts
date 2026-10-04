import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeBundleMappings } from '../src/build/sourcemap'

export interface SourceMapFile {
  sources: string[]
  mappings: string
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

export const SOLID = 'Solid'
export const KAY = 'kay'
export const APP = 'app'
export const BUNDLER = 'bundler'
export const GC = 'GC'
export const ENGINE = 'engine'

// Solid's packages and the serializer it hydrates with.
const SOLID_PACKAGES = new Set(['solid-js', '@solidjs/signals', '@solidjs/web', 'seroval', 'seroval-plugins'])
// The last `node_modules` of a path names its package.
const PACKAGE = /.*node_modules\/((?:@[^/]+\/)?[^/]+)\//
const SOURCE_MAP_COMMENT = /\n\/\/# sourceMappingURL=\S+\s*$/
const REPO = resolve(import.meta.dir, '..')
// The profiler's own nodes: `(idle)` is left out, `(program)` and `(root)` are the engine's.
const META_FRAMES = new Map([['(garbage collector)', GC], ['(program)', ENGINE], ['(root)', ENGINE], ['(idle)', undefined]])

// Solid, kay (its sources and the entry it generates), the benchmarked app, or the package a file belongs to.
export function originOf(path: string): string {
  const name = PACKAGE.exec(path)?.[1]

  if (name !== undefined)
    return SOLID_PACKAGES.has(name) ? SOLID : name === 'kay' ? KAY : name

  const inRepo = relative(REPO, path.startsWith('file:') ? fileURLToPath(path) : path)

  if (inRepo.startsWith('src/') || inRepo.includes('/.kay/'))
    return KAY

  return inRepo.startsWith('bench/') ? APP : 'other'
}

// A bundle split into runs of text by the source each came from; text no source covers, newlines included, is the bundler's.
export function piecesOf(code: string, map: SourceMapFile, mapFile: string): Piece[] {
  const origins = map.sources.map(source => originOf(resolve(dirname(mapFile), source)))
  const lines = code.replace(SOURCE_MAP_COMMENT, '').split('\n')
  const segments = decodeBundleMappings(map.mappings)
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

// The source a bundle's position comes from: the last segment at or before the column on that line.
export function sourceAt(map: SourceMapFile, segments: number[][][], line: number, column: number): string | undefined {
  let found: number[] | undefined

  for (const segment of segments[line] ?? []) {
    if (segment[0]! > column)
      break

    found = segment
  }

  return found && found.length >= 4 ? map.sources[found[1]!] : undefined
}
