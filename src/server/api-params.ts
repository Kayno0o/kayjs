// Elysia 1.4.31 writes every `/` of a decoded path value as `%2F`, so a handler cannot tell `a%2Fb` from `a%252Fb`: a route with a `:name` segment re-reads its values from the request's path, each decoded once, as before. It also gives Bun's params object, whose properties cannot be redefined, a plain copy, which a `params` schema's defaults need. A static route, and a `*` which Elysia leaves as written, get nothing.
const NAMED_SEGMENT = /:/
const QUERY_OR_HASH = /[?#]/
const OPTIONAL_MARK = /\?$/

interface ParamsContext { params?: Record<string, unknown>, route?: string, request: Request }

// The options of a route at `path`, to spread into the ones it is registered with.
export function decodedRoute(path: string): { transform?: typeof decodedParams } {
  return NAMED_SEGMENT.test(path) ? { transform: decodedParams } : {}
}

// The hooks of a route Elysia registered itself, with the decoding in front of its `transform` ones.
export function withDecodedParams(route: { method: string, path?: string, hooks?: unknown }): unknown {
  const hooks = route.hooks as { transform?: unknown } | undefined

  if (hooks && route.method !== 'WS' && NAMED_SEGMENT.test(route.path ?? ''))
    hooks.transform = [decodedParams, ...[hooks.transform ?? []].flat()]

  return hooks
}

function decodedParams(context: ParamsContext): void {
  const { params } = context

  if (params === undefined)
    return

  if (Object.values(params).some(value => typeof value === 'string' && value.includes('%2F')))
    context.params = { ...params, ...reread(params, context.route ?? '', context.request.url) }
  else if (Object.getPrototypeOf(params) !== Object.prototype)
    context.params = { ...params }
}

// The values of the pattern's `:name` segments read from the url's path, kept only where they are what Elysia handed on with its slashes written `%2F`, so a path that did not match the pattern as read leaves the value as it is, a malformed escape the one Bun decoded.
function reread(params: Record<string, unknown>, pattern: string, url: string): Record<string, string> {
  const start = url.indexOf('/', url.indexOf('//') + 2)
  const end = url.search(QUERY_OR_HASH)
  const given = url.slice(start, end === -1 ? undefined : end).split('/')
  const names = pattern.split('/')
  const found: Record<string, string> = {}

  // A pattern without a wildcard ends where the path does, whatever a base puts before it, and a trailing slash is one segment more.
  const offset = names.includes('*') ? 0 : given.length - names.length - (given.at(-1) === '' && names.at(-1) !== '' ? 1 : 0)

  for (const [index, name] of names.entries()) {
    const raw = given[index + offset]

    if (!name.startsWith(':') || raw === undefined)
      continue

    const key = name.slice(1).replace(OPTIONAL_MARK, '')
    const value = decodeOnce(raw)

    if (typeof params[key] === 'string' && value !== undefined && value.replaceAll('/', '%2F') === params[key])
      found[key] = value
  }

  return found
}

function decodeOnce(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw)
  }
  catch {
    return undefined
  }
}
