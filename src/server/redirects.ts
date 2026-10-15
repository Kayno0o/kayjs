import type { Elysia } from 'elysia'
import type { ServedPaths } from './served-paths'
import { KayError } from '../compiler/errors'
import { noteRedirect } from './dev-notes'

// A path moved elsewhere, by its old path: `'/blog/:slug': '/posts/:slug'`, a `*` carrying the rest of the path. Permanent, a 308, unless it says otherwise.
export type Redirects = Record<string, string | { to: string, permanent?: boolean }>

const PARAM = /^:([A-Z_$][\w$]*)$/i
const QUERY_OR_HASH = /[?#].*$/
// A target on the site whose `*` starts with a slash would read as another host: `//evil.example`.
const LEADING_SLASHES = /^\/{2,}/
// What the target names from the old path: a `:name`, or the `*`.
const TARGET_PART = /:([A-Z_$][\w$]*)|\*/gi

interface Redirect {
  // The old path as the router registers it, params named by position as pages are.
  path: string
  // The router's name for each param the old path names.
  names: Map<string, string>
  to: string
  status: 307 | 308
}

// Each redirect read and checked, so a target naming a param its old path lacks stops the server rather than redirecting to `:slug`.
export function readRedirects(redirects: Redirects): Redirect[] {
  return Object.entries(redirects).map(([from, target]) => {
    const { to, permanent = true } = typeof target === 'string' ? { to: target } : target

    if (!from.startsWith('/'))
      throw new KayError('redirect-invalid', `kay: the redirect from ${from} needs a path starting with /`)

    const names = new Map<string, string>()
    const segments = from.split('/')
    const path = segments.map((segment, index) => {
      const param = PARAM.exec(segment)

      if (param) {
        names.set(param[1]!, `p${index}`)

        return `:p${index}`
      }

      if (segment === '*' && index === segments.length - 1)
        return segment

      if (segment.includes(':') || segment.includes('*'))
        throw new KayError('redirect-invalid', `kay: the redirect from ${from} has ${segment}, neither a :param nor a final *`)

      return segment
    }).join('/')

    for (const [part, name] of to.matchAll(TARGET_PART)) {
      if (name === undefined ? !path.endsWith('/*') : !names.has(name))
        throw new KayError('redirect-invalid', `kay: the redirect from ${from} goes to ${to}, whose ${part} its path has none of`)
    }

    return { path, names, to, status: permanent ? 308 : 307 }
  })
}

// A redirect target on the site that nothing serves: no page, public file, route kay adds nor other redirect. A `:param` stands for any segment, a `*` for any rest of the path, and a trailing slash is the page's as `trailingSlash` allows.
export function redirectProblems(redirects: Redirects, served: string[]): string[] {
  const paths = [...served, ...Object.keys(redirects)].map(path => path.split('/').slice(1))

  return Object.entries(redirects).flatMap(([from, target]) => {
    const to = typeof target === 'string' ? target : target.to

    // Another site's URL, or a protocol-relative one, is not this site's to check.
    if (!to.startsWith('/') || to.startsWith('//'))
      return []

    const path = to.replace(QUERY_OR_HASH, '')
    const slash = path.length > 1 && path.endsWith('/')
    const segments = (slash ? path.slice(0, -1) : path).split('/').slice(1)

    return paths.some(served => reaches(segments, slash, served)) ? [] : [`the redirect from ${from} goes to ${to}, which nothing on the site serves`]
  })
}

function reaches(target: string[], slash: boolean, path: string[]): boolean {
  for (const [index, segment] of target.entries()) {
    const served = path[index]

    if (segment === '*' || served === '*')
      return true

    if (served === undefined || (segment !== served && !segment.startsWith(':') && !served.startsWith(':')))
      return false
  }

  // A catch-all's own directory is served with its slash only: `/docs/` for `/docs/*`, never `/docs`.
  return target.length === path.length || (slash && target.length === path.length - 1 && path.at(-1) === '*')
}

// A redirect registered before the pages would hide the page serving its old path, or anything else serving it.
export function claimRedirects(served: ServedPaths, redirects: Redirect[]): void {
  for (const { path } of redirects) {
    served.claim({ path, owner: `the redirect from ${path}`, kind: 'redirect' }, taken => taken.kind === 'page' ? `kay: the redirect from ${path} takes a path a page serves; remove the redirect or the page` : `kay: ${taken.owner} and the redirect from ${path} both serve ${path}; remove one`)
  }
}

// Registered before the pages, the query carried over unless the target gives its own.
export function serveRedirects(app: Elysia, redirects: Redirect[], dev?: boolean): void {
  for (const redirect of redirects) {
    app.get(redirect.path, ({ params, request }) => {
      const values = params as Record<string, string>
      // Named params arrive decoded, so they are encoded again; the `*` arrives as the browser sent it.
      const target = redirect.to.replaceAll(TARGET_PART, (_part, name: string | undefined) => name === undefined ? values['*'] ?? '' : encodeURIComponent(values[redirect.names.get(name)!] ?? ''))
      const { search } = new URL(request.url)
      const path = target.startsWith('/') ? target.replace(LEADING_SLASHES, '/') : target
      const location = search !== '' && !path.includes('?') ? `${path}${search}` : path

      noteRedirect(dev, request, `the redirect from ${redirect.path}`)

      return new Response(null, { status: redirect.status, headers: { location } })
    })
  }
}
