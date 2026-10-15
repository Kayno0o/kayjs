// Who answered a request with a redirect, noted where kay builds the response, for the dev tool's Request tab to say of the request that follows it; kept only while the request lives.
const redirects = new WeakMap<Request, string>()

// Written in development only: a production server keeps no bookkeeping for a tool it does not serve.
export function noteRedirect(dev: boolean | undefined, request: Request, by: string): void {
  if (dev)
    redirects.set(request, by)
}

export function redirectedBy(request: Request): string | undefined {
  return redirects.get(request)
}
