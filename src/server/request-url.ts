const parsed = new WeakMap<Request, URL>()

// The request's URL, parsed once however many of kay's routes, hooks and scopes read it; shared, so never changed.
export function requestUrl(request: Request): URL {
  let url = parsed.get(request)

  if (!url) {
    url = new URL(request.url)
    parsed.set(request, url)
  }

  return url
}
