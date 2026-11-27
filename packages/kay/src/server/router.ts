// File-based route matcher: static > [param] > [...catchall] priority sorting + param extraction.

import type { RequestPath } from './request-path'
import { decodeRequestPath } from './request-path'

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
  readonly #dynamicRoutes: RoutePattern<T>[] = []
  #sorted = true

  add(path: string, data: T): void {
    const compiled = compileRoutePattern(path, data)
    if (compiled.isStatic) {
      this.#staticRoutes.set(compiled.path, data)
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

  /** Matches a decoded request path; a string is a URL pathname, decoded first. */
  match(input: string | RequestPath): RouteMatch<T> | undefined {
    const path = typeof input === 'string' ? decodeRequestPath(input) : input
    if (path === undefined)
      return undefined

    if (path.staticPath !== undefined) {
      const exact = this.#staticRoutes.get(normalizePath(path.staticPath))
      if (exact !== undefined)
        return { data: exact, params: {} }
    }

    const dynLen = this.#dynamicRoutes.length
    if (dynLen === 0)
      return undefined

    if (!this.#sorted) {
      this.#dynamicRoutes.sort(compareRoutes)
      this.#sorted = true
    }

    const parts = path.segments
    // A param never receives a separator, a NUL or a dot segment, encoded or not: joined into a path, it would walk out of the folder it names.
    const refused = (k: number): boolean => path.encoded?.has(k) === true || parts[k] === '.' || parts[k] === '..'

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
        if (seg.kind === SegmentKind.CatchAll) {
          for (let k = j; k < parts.length; k++) {
            if (refused(k))
              matched = false
          }
          break
        }
        if (seg.kind === SegmentKind.Param ? refused(j) : seg.value !== parts[j] || path.encoded?.has(j) === true) {
          matched = false
          break
        }
      }

      if (!matched)
        continue

      // Allocate params only for the winning route.
      const params: Record<string, string> = {}
      for (let j = 0; j < segs.length; j++) {
        const seg = segs[j]!
        if (seg.kind === SegmentKind.CatchAll) {
          params[seg.value] = parts.slice(j).join('/')
          break
        }
        if (seg.kind === SegmentKind.Param)
          params[seg.value] = parts[j]!
      }
      return { data: route.data, params }
    }

    return undefined
  }
}
