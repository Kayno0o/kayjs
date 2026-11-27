// A request path, percent-decoded once for every lookup: the asset, public and prerendered maps, the middleware scopes, and the routers with their params.

const UNSAFE_ENCODED_RE = /%(?:2f|5c|00)/i

class DecodedPath {
  #segments: readonly string[] | undefined

  constructor(
    /** Every segment decoded; undefined when one encodes a separator or NUL, so no file, page or prerendered lookup can match it. */
    readonly staticPath: string | undefined,
    /** Safe segments decoded and the others left encoded, so encoding a letter cannot step past a middleware scope. */
    readonly scopedPath: string,
    /** Indexes in `segments` of those left encoded. */
    readonly encoded: ReadonlySet<number> | undefined,
    segments?: readonly string[],
  ) {
    this.#segments = segments
  }

  /** The segments of `scopedPath` after its leading slash, one trailing slash dropped. */
  get segments(): readonly string[] {
    if (this.#segments === undefined) {
      const path = this.scopedPath.length > 1 && this.scopedPath.endsWith('/') ? this.scopedPath.slice(0, -1) : this.scopedPath
      this.#segments = path === '/' ? [] : path.slice(1).split('/')
    }
    return this.#segments
  }
}

export type RequestPath = DecodedPath

/** Decodes a URL pathname segment by segment; undefined for a malformed escape, which the server answers 400. */
export function decodeRequestPath(pathname: string): RequestPath | undefined {
  if (!pathname.includes('%'))
    return new DecodedPath(pathname, pathname, undefined)
  const parts = pathname.split('/')
  let encoded: Set<number> | undefined
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]!
    if (!part.includes('%'))
      continue
    let decoded: string
    try {
      decoded = decodeURIComponent(part)
    }
    catch {
      return undefined
    }
    if (UNSAFE_ENCODED_RE.test(part))
      (encoded ??= new Set()).add(i - 1)
    else
      parts[i] = decoded
  }
  const scopedPath = parts.join('/')
  return new DecodedPath(encoded === undefined ? scopedPath : undefined, scopedPath, encoded)
}

/** A path kay already holds decoded, such as a route's or a public file's, taken as it is. */
export function literalPath(path: string): RequestPath {
  return new DecodedPath(path, path, undefined)
}

/** The path made of the first `count` segments of `path`. */
export function pathPrefix(path: RequestPath, count: number): RequestPath {
  const segments = path.segments.slice(0, count)
  const joined = `/${segments.join('/')}`
  let encoded: Set<number> | undefined
  for (const index of path.encoded ?? []) {
    if (index < count)
      (encoded ??= new Set()).add(index)
  }
  return new DecodedPath(encoded === undefined ? joined : undefined, joined, encoded, segments)
}
