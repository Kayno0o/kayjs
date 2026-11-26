// File-based route matcher: static > [param] > [...catchall] priority sorting + param extraction.

const ENCODED_SLASH_RE = /%2f/i
const UNSAFE_ENCODED_RE = /%(?:2f|5c|00)/i

const enum SegmentKind {
  Static = 0,
  Param = 1,
  CatchAll = 2,
}

interface CompiledSegment {
  kind: SegmentKind
  /** Exact literal for Static, parameter name for Param/CatchAll. */
  value: string
}

interface RoutePattern<T> {
  path: string
  segments: CompiledSegment[]
  isStatic: boolean
  hasCatchAll: boolean
  data: T
}

export interface RouteMatch<T> {
  data: T
  params: Record<string, string>
}

function normalizePath(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

/**
 * Segment specificity rank: Static (3) > Param (2) > End of exact route (1) > CatchAll (0).
 * Lexicographic comparison guarantees exact static > exact parametric > catch-all for any shared prefix
 * (e.g. `/docs/:slug` beats `/docs/:section/*rest`, and `/docs/:a/:b` beats `/docs/*rest`).
 */
function segmentRank(seg: CompiledSegment | undefined): number {
  if (seg === undefined)
    return 1
  if (seg.kind === SegmentKind.Static)
    return 3
  if (seg.kind === SegmentKind.Param)
    return 2
  return 0
}

function compareRoutes<T>(a: RoutePattern<T>, b: RoutePattern<T>): number {
  const len = Math.max(a.segments.length, b.segments.length)
  for (let i = 0; i < len; i++) {
    const diff = segmentRank(b.segments[i]) - segmentRank(a.segments[i])
    if (diff !== 0)
      return diff
  }
  return 0
}

function compileRoutePattern<T>(path: string, data: T): RoutePattern<T> {
  const norm = normalizePath(path)
  const clean = norm === '/' ? '' : norm.replace(/^\/|\/$/g, '')
  const rawSegments = clean === '' ? [] : clean.split('/')
  const segments: CompiledSegment[] = []
  let isStatic = true
  let hasCatchAll = false

  for (let i = 0; i < rawSegments.length; i++) {
    const seg = rawSegments[i]!
    if (seg.startsWith('*')) {
      isStatic = false
      hasCatchAll = true
      segments.push({ kind: SegmentKind.CatchAll, value: seg.slice(1) || 'rest' })
    }
    else if (seg.startsWith(':')) {
      isStatic = false
      segments.push({ kind: SegmentKind.Param, value: seg.slice(1) })
    }
    else {
      segments.push({ kind: SegmentKind.Static, value: seg })
    }
  }

  return { path: norm, segments, isStatic, hasCatchAll, data }
}

export class Router<T> {
  readonly #staticRoutes = new Map<string, T>()
  readonly #staticSegmentCounts = new Set<number>()
  readonly #dynamicRoutes: RoutePattern<T>[] = []
  #sorted = true

  add(path: string, data: T): void {
    const compiled = compileRoutePattern(path, data)
    if (compiled.isStatic) {
      this.#staticRoutes.set(compiled.path, data)
      this.#staticSegmentCounts.add(compiled.segments.length)
    }
    else {
      const existing = this.#dynamicRoutes.findIndex(r => r.path === compiled.path)
      if (existing !== -1)
        this.#dynamicRoutes[existing] = compiled
      else
        this.#dynamicRoutes.push(compiled)
      this.#sorted = false
    }
  }

  match(pathname: string): RouteMatch<T> | undefined {
    const norm = normalizePath(pathname)

    const exact = this.#staticRoutes.get(norm)
    if (exact !== undefined)
      return { data: exact, params: {} }

    let parts: string[] | undefined
    if (this.#staticRoutes.size > 0 && norm.includes('%') && !UNSAFE_ENCODED_RE.test(norm)) {
      parts = norm === '/' ? [] : norm.slice(1).split('/')
      if (this.#staticSegmentCounts.has(parts.length)) {
        const decoded = tryDecodeStatic(norm)
        if (decoded !== undefined) {
          const decodedExact = this.#staticRoutes.get(decoded)
          if (decodedExact !== undefined)
            return { data: decodedExact, params: {} }
        }
      }
    }

    const dynLen = this.#dynamicRoutes.length
    if (dynLen === 0)
      return undefined

    if (!this.#sorted) {
      this.#dynamicRoutes.sort(compareRoutes)
      this.#sorted = true
    }

    parts ??= norm === '/' ? [] : norm.slice(1).split('/')

    for (let i = 0; i < dynLen; i++) {
      const route = this.#dynamicRoutes[i]!
      const segs = route.segments

      if (!route.hasCatchAll && parts.length !== segs.length)
        continue
      if (route.hasCatchAll && parts.length < segs.length - 1)
        continue

      let matched = true
      for (let j = 0; j < segs.length; j++) {
        const seg = segs[j]!
        if (seg.kind === SegmentKind.CatchAll)
          break
        if (seg.kind === SegmentKind.Param) {
          if (ENCODED_SLASH_RE.test(parts[j]!)) {
            matched = false
            break
          }
        }
        else if (seg.value !== parts[j]) {
          const part = parts[j]!
          if (!part.includes('%') || UNSAFE_ENCODED_RE.test(part) || tryDecodeStatic(part) !== seg.value) {
            matched = false
            break
          }
        }
      }

      if (!matched)
        continue

      // Allocate and decode params only for the winning route.
      const params: Record<string, string> = {}
      for (let j = 0; j < segs.length; j++) {
        const seg = segs[j]!
        if (seg.kind === SegmentKind.CatchAll) {
          params[seg.value] = parts.slice(j).map(decodeSegment).join('/')
          break
        }
        if (seg.kind === SegmentKind.Param)
          params[seg.value] = decodeSegment(parts[j]!)
      }
      return { data: route.data, params }
    }

    return undefined
  }
}

function tryDecodeStatic(str: string): string | undefined {
  try {
    return decodeURIComponent(str)
  }
  catch {
    return undefined
  }
}

function decodeSegment(str: string): string {
  try {
    return decodeURIComponent(str)
  }
  catch {
    return str
  }
}
