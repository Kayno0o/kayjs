import type { Context } from 'elysia'
import type { KayConfig, SecurityConfig } from '../config'
import type { PageSecurity } from '../runtime'
import type { Prefetch } from './speculation'
import { offlineOf } from '../project'
import { BUILD_HEADER } from '../runtime/swap'
import { basePath } from './base'
import { inlineScriptHashes, sourceHash } from './csp'
import { requestIdHeader } from './protection'
import { CSP_ENDPOINT, CSP_REPORTS } from './violations'

export interface SecurityOptions {
  security?: SecurityConfig | false | undefined
  prefetch?: Prefetch | undefined
  dev?: boolean | undefined
  // The origin the site is public at: HSTS is sent when it is https.
  site?: string | undefined
  base?: string | undefined
  offline?: KayConfig['offline'] | undefined
  lateStyles?: KayConfig['lateStyles'] | undefined
  // The sources the islands need, added to kay's directives and the app's own: see ClientManifest.
  islands?: Record<string, string[]> | undefined
  // The inline scripts and styles kay writes in every head, such as the fonts' rules.
  scripts?: string[] | undefined
  styles?: string[] | undefined
}

// Strict where it costs a site nothing: scripts only from itself plus kay's own inline ones, no plugins, no foreign forms or frames. Images may come from any https host, and inline styles stay allowed, since `style` attributes are everyday template code.
const DIRECTIVES: Record<string, string[]> = {
  'default-src': ['\'self\''],
  'script-src': ['\'self\''],
  'style-src': ['\'self\'', '\'unsafe-inline\''],
  'img-src': ['\'self\'', 'data:', 'https:'],
  'font-src': ['\'self\''],
  'connect-src': ['\'self\''],
  'object-src': ['\'none\''],
  'base-uri': ['\'self\''],
  'form-action': ['\'self\''],
  'frame-ancestors': ['\'self\''],
}

// The directives kay's inline scripts and styles are let through by.
const SCRIPT_DIRECTIVES = ['script-src', 'script-src-elem']
const STYLE_DIRECTIVES = ['style-src', 'style-src-elem']
const UNSAFE_INLINE = '\'unsafe-inline\''
const NONE = '\'none\''
const SELF = '\'self\''

// The directives a browser reads in turn in place of one the policy lacks, as CSP3 has them, which a page adding sources to it starts from; any other fetch directive falls back to `default-src` alone.
const FALLBACKS: Record<string, string[]> = {
  'script-src-elem': ['script-src', 'default-src'],
  'script-src-attr': ['script-src', 'default-src'],
  'style-src-elem': ['style-src', 'default-src'],
  'style-src-attr': ['style-src', 'default-src'],
  'worker-src': ['child-src', 'script-src', 'default-src'],
  'frame-src': ['child-src', 'default-src'],
}
const FETCH_DIRECTIVE = /-src(?:-elem|-attr)?$/

// A year, with neither `includeSubDomains` nor `preload`, which bind more than the site itself and which no later deploy takes back.
const HSTS = 'max-age=31536000'

const HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  // `frame-ancestors` for browsers that predate it, following the policy's: see `frameOptions`.
  'x-frame-options': 'SAMEORIGIN',
  // A page this site opens in another window, or that opens one of its pages, gets no handle on it: no `window.opener` across sites.
  'cross-origin-opener-policy': 'same-origin',
  // A page of another site may link here, but not load what this one serves into itself, as Spectre-style reads would.
  'cross-origin-resource-policy': 'same-site',
  // Features a site rarely uses, refused to it and to anything it embeds, so an injected script cannot ask for them.
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
  // No Flash or Acrobat cross-domain policy file is honoured.
  'x-permitted-cross-domain-policies': 'none',
}

// The headers every response carries unless the app sets its own, or undefined with `security: false`; with the `security` settings of a page and its layouts, outermost first, those of its responses.
export function securityHeaders(options: SecurityOptions, pages: PageSecurity[] = []): Record<string, string> | undefined {
  const pageHeaders = pages.flatMap(page => page.headers ? [page.headers] : [])

  // A site sending none still sends what a page asks for.
  if (options.security === false)
    return pageHeaders.length > 0 ? withHeaders({}, pageHeaders) : undefined

  const headers: Record<string, string> = { ...HEADERS }

  // Browsers ignore it over http, so a proxy terminating TLS needs no special case; development stays free of it so localhost is not pinned to https.
  if (options.dev !== true && URL.parse(options.site ?? '')?.protocol === 'https:')
    headers['strict-transport-security'] = HSTS

  const { csp, reports, reportOnly } = options.security ?? {}
  const base = basePath(options.base)
  const hashes = [...inlineScriptHashes({ prefetch: options.prefetch, dev: options.dev, base, offline: offlineOf(options, { dev: options.dev === true }), lateStyles: options.lateStyles }), ...(options.scripts ?? []).map(sourceHash)]
  const styles = [...new Set((options.styles ?? []).map(sourceHash))]
  const reportTo = reports === true ? `${base}${CSP_REPORTS}` : reports

  if (reportTo !== undefined)
    headers['reporting-endpoints'] = `${CSP_ENDPOINT}="${reportTo}"`

  const added = pages.flatMap(page => page.csp === undefined || page.csp === false ? [] : [page.csp])
  const enforced = csp !== false && !pages.some(page => page.csp === false)

  if (enforced) {
    const directives = policy([csp ?? {}], hashes, styles, reportTo, options.islands, added)
    const frames = frameOptions(directives.get('frame-ancestors'))

    headers['content-security-policy'] = serialized(directives)

    if (frames === undefined)
      delete headers['x-frame-options']
    else
      headers['x-frame-options'] = frames
  }

  if (reportOnly)
    headers['content-security-policy-report-only'] = serialized(policy([enforced ? csp ?? {} : {}, reportOnly], hashes, styles, reportTo, options.islands, added))

  return withHeaders(headers, [options.security?.headers ?? {}, ...pageHeaders])
}

function withHeaders(headers: Record<string, string>, layers: Record<string, string | false>[]): Record<string, string> {
  for (const layer of layers) {
    for (const [name, value] of Object.entries(layer)) {
      if (value === false)
        delete headers[name.toLowerCase()]
      else
        headers[name.toLowerCase()] = value
    }
  }

  return headers
}

// One set of a file route's headers, as it is and with the security headers, which such a route sends itself: set on the context instead, they make Elysia copy its response into a second one.
export interface HeaderCopies {
  plain: Record<string, string>
  secured: Record<string, string>
  security: [name: string, value: string][]
}

export function headerCopies(headers: Record<string, string>, security: Record<string, string> | undefined): HeaderCopies {
  return { plain: headers, secured: security ? { ...security, ...headers } : headers, security: Object.entries(security ?? {}) }
}

// The security headers set on the context, under any the app set there first.
export function setSecurityHeaders(set: Context['set'], security: [name: string, value: string][]): void {
  for (const [name, value] of security)
    set.headers[name] ??= value
}

// The copy a file route answers with: the secured one when the context holds no header, since the response's own would win over the app's; else the plain one, the security headers going on the context as on every other route.
// The request id and build every context holds go on the response itself when it is alone there, so Elysia has no header to copy the response for.
export function ownHeaders(set: Context['set'], copies: HeaderCopies): Record<string, string> {
  const own = takeOwnHeaders(set)

  if (own !== undefined)
    return { ...copies.secured, ...own }

  if (Object.keys(set.headers).length === 0)
    return copies.secured

  setSecurityHeaders(set, copies.security)

  return copies.plain
}

// The names a response was given from the context, by response: a response answered twice, as a constant is, has them taken off before it gets the second request's.
const carried = new WeakMap<Response, string[]>()

// The names a response was given from the context by an earlier request.
export function carriedNames(response: Response): readonly string[] {
  return carried.get(response) ?? []
}

// What the context holds goes onto the response itself, so Elysia has no header to copy the response for; a response of the route's own wins over the context, as it does in Elysia's merge.
// Left to Elysia's copy: a cookie (the jar's, or a header of the context's), a status the response would not keep, a response that streams, and headers that cannot be written (`Response.redirect`).
// A static response is cloned by Elysia after this runs, so it carries the headers of the request that is answered, not the one before.
export function carryContext<T extends Response>(set: Context['set'], response: T): T {
  const { status } = set
  const { headers } = response
  const names: string[] = []

  try {
    for (const name of carried.get(response) ?? [])
      headers.delete(name)

    carried.delete(response)

    if (set.cookie || set.headers['set-cookie'] !== undefined || (status !== undefined && status !== 200 && (typeof status !== 'number' || response.status === 200)) || headers.get('transfer-encoding') === 'chunked')
      return response

    for (const name in set.headers) {
      if (!headers.has(name)) {
        headers.set(name, set.headers[name] as string)
        names.push(name)
      }
    }
  }
  catch {
    // Immutable headers, nothing written: the context's go on through Elysia's copy.
    return response
  }

  carried.set(response, names)
  set.headers = {}

  if (status !== 200)
    set.status = 200

  return response
}

// The same for headers built per request: the security headers go under what the response sets, and the request id on the response when it is alone on the context.
export function ownedHeaders(set: Context['set'], headers: Record<string, string>, security: [name: string, value: string][]): Record<string, string> {
  const own = takeOwnHeaders(set)

  if (own === undefined && Object.keys(set.headers).length > 0) {
    setSecurityHeaders(set, security)

    return headers
  }

  Object.assign(headers, own)

  for (const [name, value] of security)
    headers[name] ??= value

  return headers
}

// The request id and the build every context holds, when they are all that is there, taken off it for the response to carry.
function takeOwnHeaders(set: Context['set']): Record<string, string> | undefined {
  const own: Record<string, string> = {}

  for (const name in set.headers) {
    if (name !== requestIdHeader() && name !== BUILD_HEADER)
      return undefined

    own[name] = String(set.headers[name])
  }

  if (Object.keys(own).length === 0)
    return undefined

  for (const name in own)
    delete set.headers[name]

  return own
}

const HASH_OR_NONCE = /^'(?:nonce-|sha(?:256|384|512)-)/i

// Whether the site's policy lets an element carry a `style` attribute, its report-only one included, which would log each: the first of `style-src-attr`, `style-src` and `default-src` it sets must allow `'unsafe-inline'`, which a nonce or a hash in it switches off.
export function allowsStyleAttributes(csp: Record<string, string[] | false> | false | undefined, reportOnly?: Record<string, string[] | false>): boolean {
  if (csp === false)
    return reportOnly === undefined || allowsStyles({ ...DIRECTIVES, ...reportOnly })

  return allowsStyles({ ...DIRECTIVES, ...csp }) && (reportOnly === undefined || allowsStyles({ ...DIRECTIVES, ...csp, ...reportOnly }))
}

function allowsStyles(directives: Record<string, string[] | false | undefined>): boolean {
  for (const name of ['style-src-attr', 'style-src', 'default-src']) {
    const sources = directives[name]

    if (sources === undefined || sources === false)
      continue

    return sources.includes(UNSAFE_INLINE) && !sources.some(source => HASH_OR_NONCE.test(source))
  }

  return true
}

// kay's directives, plus the sources its islands need, with each layer of the app's merged over them in turn, a directive given `false` left out; `script-src` and `script-src-elem` always keep the hashes of kay's inline scripts, and `style-src` and `style-src-elem` those of its inline styles.
// A hash switches `'unsafe-inline'` off, so a style directive allowing it gets none.
// A page's sources are then added to what the site's directives hold.
// `report-uri` is for browsers that predate `report-to`, which those that know it read instead.
function policy(layers: Record<string, string[] | false>[], hashes: string[], styles: string[], reportTo: string | undefined, islands: Record<string, string[]> = {}, added: Record<string, string[] | false>[] = []): Map<string, string[]> {
  const directives = new Map(Object.entries(DIRECTIVES))
  const removed = new Set<string>()

  for (const overrides of layers) {
    for (const [name, sources] of Object.entries(overrides)) {
      if (sources === false) {
        directives.delete(name)
        removed.add(name)
      }
      else {
        directives.set(name, sources)
        removed.delete(name)
      }
    }
  }

  // What the islands run is a fact of the build, so it joins the app's own sources too, unless the app removed that directive or set it to 'none'.
  for (const [name, sources] of Object.entries(islands)) {
    const own = directives.get(name)

    if (!removed.has(name) && !own?.includes(NONE))
      directives.set(name, [...new Set([...own ?? [], ...sources])])
  }

  for (const sources of added) {
    // A directive the layer adds starts from what the policy held before it, whatever order the layer lists them in.
    const before = new Map(directives)

    for (const [name, value] of Object.entries(sources)) {
      if (value === false) {
        directives.delete(name)
      }
      else {
        const own = before.get(name) ?? fallbackSources(before, name)

        directives.set(name, [...new Set([...own.filter(source => source !== NONE), ...value])])
      }
    }
  }

  if (reportTo !== undefined) {
    directives.set('report-uri', [reportTo])
    directives.set('report-to', [CSP_ENDPOINT])
  }

  // A browser reads `script-src-elem` over `script-src` for script tags, so whichever the policy holds lets kay's through.
  for (const name of SCRIPT_DIRECTIVES) {
    const sources = directives.get(name)

    if (sources)
      directives.set(name, [...sources, ...hashes])
  }

  for (const name of STYLE_DIRECTIVES) {
    const sources = directives.get(name)

    if (sources && styles.length > 0 && !sources.includes(UNSAFE_INLINE))
      directives.set(name, [...sources, ...styles])
  }

  return directives
}

function serialized(directives: Map<string, string[]>): string {
  return [...directives].map(([name, sources]) => sources.length > 0 ? `${name} ${sources.join(' ')}` : name).join('; ')
}

// What X-Frame-Options says of the policy's `frame-ancestors`: DENY for `'none'` or no source at all, SAMEORIGIN for `'self'` alone, and nothing for any other source, which it cannot name, or without the directive.
function frameOptions(sources: string[] | undefined): string | undefined {
  if (sources === undefined)
    return undefined

  const kinds = new Set(sources.map(source => source.toLowerCase()))
  const [only] = kinds

  if (only === undefined || (kinds.size === 1 && only === NONE))
    return 'DENY'

  return kinds.size === 1 && only === SELF ? 'SAMEORIGIN' : undefined
}

// What the browser enforces for a fetch directive the policy lacks: that of the directive it falls back to, or nothing for any other.
function fallbackSources(directives: Map<string, string[]>, name: string): string[] {
  if (!FETCH_DIRECTIVE.test(name) || name === 'default-src')
    return []

  for (const fallback of FALLBACKS[name] ?? ['default-src']) {
    const sources = directives.get(fallback)

    if (sources)
      return sources
  }

  return []
}
