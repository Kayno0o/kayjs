// File-based route matcher: static > [param] > [...catchall] priority sorting + param extraction.

export interface RoutePattern<T> {
  path: string
  segments: string[]
  isStatic: boolean
  hasCatchAll: boolean
  score: number
  data: T
}

export interface RouteMatch<T> {
  data: T
  params: Record<string, string>
}

export function compileRoutePattern<T>(path: string, data: T): RoutePattern<T> {
  const clean = path === '/' ? '' : path.replace(/^\/|\/$/g, '')
  const segments = clean === '' ? [] : clean.split('/')
  let isStatic = true
  let hasCatchAll = false
  let score = 0

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!
    if (seg.startsWith('*')) {
      isStatic = false
      hasCatchAll = true
      score += 1
    }
    else if (seg.startsWith(':')) {
      isStatic = false
      score += 10
    }
    else {
      score += 100
    }
  }

  return { path, segments, isStatic, hasCatchAll, score, data }
}

export class Router<T> {
  readonly #staticRoutes = new Map<string, T>()
  readonly #dynamicRoutes: RoutePattern<T>[] = []

  add(path: string, data: T): void {
    const compiled = compileRoutePattern(path, data)
    if (compiled.isStatic) {
      this.#staticRoutes.set(path, data)
    }
    else {
      this.#dynamicRoutes.push(compiled)
      this.#dynamicRoutes.sort((a, b) => b.score - a.score || b.segments.length - a.segments.length)
    }
  }

  match(pathname: string): RouteMatch<T> | undefined {
    const norm = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname

    const exact = this.#staticRoutes.get(norm)
    if (exact !== undefined)
      return { data: exact, params: {} }

    const parts = norm === '/' ? [] : norm.slice(1).split('/')

    for (let i = 0; i < this.#dynamicRoutes.length; i++) {
      const route = this.#dynamicRoutes[i]!
      const segs = route.segments

      if (!route.hasCatchAll && parts.length !== segs.length)
        continue
      if (route.hasCatchAll && parts.length < segs.length - 1)
        continue

      const params: Record<string, string> = {}
      let matched = true

      for (let j = 0; j < segs.length; j++) {
        const seg = segs[j]!
        if (seg.startsWith('*')) {
          const name = seg.slice(1) || 'rest'
          params[name] = parts.slice(j).map(decodeSegment).join('/')
          break
        }
        else if (seg.startsWith(':')) {
          const rawSeg = parts[j]!
          if (/%2f/i.test(rawSeg)) {
            matched = false
            break
          }
          params[seg.slice(1)] = decodeSegment(rawSeg)
        }
        else if (seg !== parts[j]) {
          matched = false
          break
        }
      }

      if (matched)
        return { data: route.data, params }
    }

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
