import type { Elysia } from 'elysia'
import type { ServedPaths } from './served-paths'
import { KayError } from '../compiler/errors'
import { noteRedirect } from './dev-notes'
import { requestUrl } from './request-url'

// A path moved elsewhere, by its old path: `'/blog/:slug': '/posts/:slug'`, a `*` carrying the rest of the path. Permanent, a 308, unless it says otherwise: `permanent: false` for a 307, or `status` for a 301 or 302 that older clients and some crawlers expect, which let a browser turn a POST into a GET where 307 and 308 do not.
export type Redirects = Record<string, string | { to: string, permanent?: boolean, status?: RedirectStatus }>

export type RedirectStatus = 301 | 302 | 307 | 308

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
  status: RedirectStatus
}

const STATUSES = new Set<unknown>([301, 302, 307, 308])
const PERMANENT = new Set<unknown>([301, 308])

// The status a redirect answers with: its `status`, else a 308 or, with `permanent: false`, a 307. A `status` that is none of 301, 302, 307 and 308, or that contradicts `permanent`, is refused.
export function redirectStatus(from: string, target: Redirects[string]): RedirectStatus {
  const { permanent, status }: { permanent?: boolean, status?: RedirectStatus } = typeof target === 'string' ? {} : target

  if (status === undefined)
    return permanent === false ? 307 : 308

  if (!STATUSES.has(status))
    throw new KayError('redirect-invalid', `kay: the redirect from ${from} has status ${String(status)}; it answers 301, 302, 307 or 308`)

  if (permanent !== undefined && permanent !== PERMANENT.has(status))
    throw new KayError('redirect-invalid', `kay: the redirect from ${from} has permanent: ${String(permanent)} and status ${String(status)}, which disagree; set one of them`)

  return status
}

// What `_redirects` for a static host says: the status the config names, else 301 for a permanent redirect and 302 for the rest, as those hosts answer.
export function hostedStatus(from: string, target: Redirects[string]): RedirectStatus {
  const status = redirectStatus(from, target)

  if (typeof target !== 'string' && target.status !== undefined)
    return status

  return status === 308 ? 301 : 302
}

// Each redirect read and checked, so a target naming a param its old path lacks stops the server rather than redirecting to `:slug`.
export function readRedirects(redirects: Redirects): Redirect[] {
  return Object.entries(redirects).map(([from, target]) => {
    const to = typeof target === 'string' ? target : target.to

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

    return { path, names, to, status: redirectStatus(from, target) }
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

// The target with its `:name` parts filled by `param` and its `*` by `rest`.
export function fillTarget(to: string, param: (name: string) => string, rest: string): string {
  return to.replaceAll(TARGET_PART, (_part, name: string | undefined) => name === undefined ? rest : param(name))
}

// Where a redirect to `target` goes: a target on the site loses extra leading slashes, which would read as another host, and the request's query is carried over unless the target gives its own.
export function redirectLocation(target: string, search: string): string {
  const path = target.startsWith('/') ? target.replace(LEADING_SLASHES, '/') : target

  return search !== '' && !path.includes('?') ? `${path}${search}` : path
}

// Registered before the pages, the query carried over unless the target gives its own.
export function serveRedirects(app: Elysia, redirects: Redirect[], dev?: boolean): void {
  for (const redirect of redirects) {
    app.get(redirect.path, ({ params, request }) => {
      const values = (params ?? {}) as Record<string, string>
      // Named params arrive decoded, so they are encoded again; the `*` arrives as the browser sent it.
      const target = fillTarget(redirect.to, name => encodeURIComponent(values[redirect.names.get(name)!] ?? ''), values['*'] ?? '')
      const location = redirectLocation(target, requestUrl(request).search)

      noteRedirect(dev, request, `the redirect from ${redirect.path}`)

      return new Response(null, { status: redirect.status, headers: { location } })
    })
  }
}
