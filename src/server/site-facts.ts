// What an extension's server plugin cannot see of the app it is used by: the route that serves a path, and whether an extension counts visitors behind the visitor's yes.
// Read when a request comes, as the pages are registered after the plugins.
export interface SiteFacts {
  // The page route serving a router path, written as `/blog/:slug`, undefined for a path no page serves.
  pageRoute: (path: string) => string | undefined
  asksConsent: boolean
  // The mount point the app is served under, `''` at the root, which a path a browser names starts with even when a proxy took it off the request.
  base: string
}

const facts = new WeakMap<object, SiteFacts>()

export function setSiteFacts(app: object, site: SiteFacts): void {
  facts.set(app, site)
}

export function siteFacts(app: object): SiteFacts | undefined {
  return facts.get(app)
}
