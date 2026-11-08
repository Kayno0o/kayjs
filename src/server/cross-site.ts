import { configuredSite } from '../runtime/site'
import { PAGE_HEADER } from '../runtime/swap'
import { requestRecord } from './request-record'
import { LOCAL_HOST, overHttps, requestUrl } from './request-url'

// The methods that change nothing, which any page may send anywhere.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
// What a post from the site's own pages carries in `Sec-Fetch-Site`; `none` is the user's own doing, such as a bookmark.
const SAME_SITE_FETCH = new Set(['same-origin', 'none'])

// Names the page a refused post was answered with, on the forms that page holds: the browser then shows the action's URL, which their next post sends as its `Referer`.
export const BACK_PARAMETER = 'kay_back'

const UNPRINTABLE = /[\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]/gu
const SHOWN_MOST = 100

// What a refused request sent, which a visitor controls, so cut to a line of printable text.
function shown(value: string): string {
  const text = value.replace(UNPRINTABLE, '')

  if (text.length <= SHOWN_MOST)
    return text

  const last = text.charCodeAt(SHOWN_MOST - 1)
  const cut = last >= 0xD800 && last <= 0xDBFF ? SHOWN_MOST - 1 : SHOWN_MOST

  return `${text.slice(0, cut)}...`
}

const TEXT = 'text/plain; charset=utf-8'

// The 403 for a request `isCrossSite` refused, saying what it sent and what kay took for the site, so a proxy changing the host is fixed in one step.
export function crossSiteResponse(request: Request, what: 'action' | 'request', site?: string): Response {
  const origin = request.headers.get('origin')
  const fetchSite = request.headers.get('sec-fetch-site')
  const head = `Cross-site ${what} refused`
  let reason: string

  const from = origin === null ? null : URL.parse(origin)

  if (origin !== null && (!sameHost(request, from, site) || downgraded(request, from, site))) {
    const own = [requestUrl(request).origin, configuredSite()?.origin, site === undefined ? undefined : URL.parse(site)?.origin].filter((value, index, all) => value !== undefined && all.indexOf(value) === index)

    reason = `Origin ${shown(origin)} ${downgraded(request, from, site) ? 'is an http: origin on an https site, not this site' : 'is not this site'} (${own.join(' or ')}; set or fix site in kay.config.ts if a proxy changes the host)`
  }
  else {
    const seen = shown(fetchSite ?? '')

    reason = seen === '' && origin === null
      ? 'the request sent an empty Sec-Fetch-Site and no Origin, not same-origin or none'
      : `Sec-Fetch-Site is ${seen === '' ? 'empty' : seen}${origin === null ? ' and the request has no Origin' : ''}, not same-origin or none`
  }

  return new Response(`${head}: ${reason}`, { status: 403, headers: { 'content-type': TEXT } })
}

// A browser names where a request comes from in `Origin`, and in `Sec-Fetch-Site` too, which it sends even when it leaves `Origin` out.
export function isCrossSite(request: Request, site?: string): boolean {
  const origin = request.headers.get('origin')
  const fetchSite = request.headers.get('sec-fetch-site')

  const from = origin === null ? null : URL.parse(origin)

  return (origin !== null && (!sameHost(request, from, site) || downgraded(request, from, site))) || (fetchSite !== null && !SAME_SITE_FETCH.has(fetchSite))
}

// The requests an `api({ cors })` module let in from another site, which a library checking Origin itself, such as kayjs-auth, leaves alone.
const corsAdmitted = new WeakSet<Request>()

export function admitCrossSite(request: Request): void {
  corsAdmitted.add(request)
}

// Whether a browser on another site sent `request`, which no `api({ cors })` module let in.
export function unadmittedCrossSite(request: Request): boolean {
  return crossSiteOnce(request, undefined) && !corsAdmitted.has(request)
}

// Whether a browser's cross-site POST or websocket upgrade should be refused, for code on a plain Elysia app that kay's own actions and API do not reach; `site` is the app's public URL, whose host counts as the request's own.
export function crossSiteRefused(request: Request, site?: string): boolean {
  return (!SAFE_METHODS.has(request.method) || request.headers.get('upgrade')?.toLowerCase() === 'websocket') && crossSiteOnce(request, site) && !corsAdmitted.has(request)
}

// What `isCrossSite` answered for a request is kept, as kayjs-auth asks again on every session read of one.
function crossSiteOnce(request: Request, site: string | undefined): boolean {
  const record = requestRecord(request)
  const known = record.crossSite

  if (known !== undefined && known.site === site)
    return known.crossSite

  const crossSite = isCrossSite(request, site)

  record.crossSite = { site, crossSite }

  return crossSite
}

// The host of `site` in kay.config.ts, parsed once per origin.
let siteHost: { origin: string, host: string | undefined } | undefined

function configuredHost(): string | undefined {
  const site = configuredSite()

  if (site === undefined)
    return undefined

  if (siteHost?.origin !== site.origin)
    siteHost = { origin: site.origin, host: URL.parse(site.origin)?.host }

  return siteHost.host
}

// Hosts rather than origins: behind a TLS-terminating proxy the browser says https while the request arrives as http. The host of `site` in kay.config.ts counts too, for a proxy that does not pass the browser's `Host` on.
function sameHost(request: Request, url: URL | null, appUrl?: string): url is URL {
  if (url === null)
    return false

  const { host } = url

  return host === requestUrl(request).host || host === configuredHost() || (appUrl !== undefined && host === URL.parse(appUrl)?.host)
}

// Whether an `Origin` is an `http:` one on an https site, a downgrade only a network attacker makes; a machine tried locally may run either.
// Only the `Origin` header is held to it: the page names a post carries are paths resolved against the request's own URL, which is `http:` behind a TLS-terminating proxy.
function downgraded(request: Request, url: URL | null, appUrl?: string): boolean {
  return url !== null && url.protocol === 'http:' && !LOCAL_HOST.test(url.hostname) && (overHttps(request) || appUrl?.startsWith('https:') === true)
}

// The page a post came from on this site: the one its form names when a refused post rendered it, else the one kay's script names, else its `Referer`; worked out once however many of the post's stages ask.
export function postedFrom(request: Request): string | undefined {
  const record = requestRecord(request)

  if (record.postedFrom === undefined)
    record.postedFrom = fromWhere(request) ?? null

  return record.postedFrom ?? undefined
}

function fromWhere(request: Request): string | undefined {
  const resolved = (named: string | null) => named === null ? null : URL.parse(named, request.url)
  const back = resolved(requestUrl(request).searchParams.get(BACK_PARAMETER))

  if (sameHost(request, back))
    return back.href

  const sent = resolved(request.headers.get(PAGE_HEADER))

  if (sameHost(request, sent))
    return sent.href

  const referer = request.headers.get('referer')

  return referer !== null && sameHost(request, URL.parse(referer)) ? referer : undefined
}
