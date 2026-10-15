// Who answered a request with a redirect, noted where kay builds the response, for the dev tool's Request tab to say of the request that follows it; kept only while the request lives.
const redirects = new WeakMap<Request, string>()

export function noteRedirect(request: Request, by: string): void {
  redirects.set(request, by)
}

export function redirectedBy(request: Request): string | undefined {
  return redirects.get(request)
}
