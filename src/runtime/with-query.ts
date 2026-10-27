import type { QueryChanges } from './navigate-api'
import { withoutBase } from './base'
import { mergeQuery } from './navigate-api'
import { ownDep } from './reactive'

// Defined by the browser build, which never renders on the server: tested where it is read, so the bundler drops the server's code.
declare const KAY_BROWSER: true | undefined

const LEADING_SLASHES = /^[/\\]+/

// Read by a link built in the browser, written when the address changes under it.
let address: ReturnType<typeof ownDep> | undefined
// The path and query the links were last built from, so a refresh that leaves the address alone rebuilds none.
let built = ''

let serverUrl: (() => URL | undefined) | undefined

// Given by the server, which knows the page a load or a render answers.
export function setCurrentUrl(read: () => URL | undefined): void {
  serverUrl = read
}

// Tells the links built by `withQuery` in the browser that the address changed, a swap or a query written in place.
export function addressChanged(): void {
  if (built !== location.pathname + location.search)
    address?.write()
}

// The path of the current page with `changes` merged into its query, to link to it with one filter or sort changed: `a(href={withQuery({ page: 2, filter: null })})`.
// A null, undefined or empty value drops the param, the others keep their place and the hash is left out; the path is the site's own, under the mount point and in the locale of the page as any link of it is.
// In an island it follows the address: the link is built again after each `navigate({ query })`, swap and traversal.
// A page rendered once at build time has no request to read the query of, so it throws there.
export function withQuery(changes: QueryChanges): string {
  const params = new URLSearchParams()
  let path: string

  if (typeof KAY_BROWSER === 'undefined' && typeof document === 'undefined') {
    const url = serverUrl?.()

    if (url === undefined)
      throw new Error('kay: withQuery() reads the query of the request being rendered, and a page rendered once at build time has none; render the page per request, or build the link in an island')

    path = url.pathname

    for (const [name, value] of url.searchParams)
      params.append(name, value)
  }
  else {
    (address ??= ownDep(() => undefined)).read()
    built = location.pathname + location.search
    path = withoutBase(location.pathname)

    for (const [name, value] of new URLSearchParams(location.search))
      params.append(name, value)
  }

  mergeQuery(params, changes)

  // A request path starting with two slashes would read as another host once it is a link's.
  const text = params.toString()

  return `${path.replace(LEADING_SLASHES, '/')}${text === '' ? '' : `?${text}`}`
}
