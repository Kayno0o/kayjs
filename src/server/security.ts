import type { Context } from 'elysia'
import type { KayConfig, SecurityConfig } from '../config'
import type { PageSecurity } from '../runtime'
import type { Prefetch } from './speculation'
import { isNotEmpty } from 'elysia/utils'
import { offlineOf } from '../project'
import { basePath } from './base'
import { inlineScriptHashes, sourceHash } from './csp'
import { REQUEST_ID_HEADER } from './protection'
import { CSP_ENDPOINT, CSP_REPORTS } from './violations'

export interface SecurityOptions {
  security?: SecurityConfig | false | undefined
  prefetch?: Prefetch | undefined
  dev?: boolean | undefined
  base?: string | undefined
  offline?: KayConfig['offline'] | undefined
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

const HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  // `frame-ancestors` for browsers that predate it, following the policy's: see `frameOptions`.
  'x-frame-options': 'SAMEORIGIN',
  // A page this site opens in another window, or that opens one of its pages, gets no handle on it: no `window.opener` across sites.
  'cross-origin-opener-policy': 'same-origin',
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
  const { csp, reports, reportOnly } = options.security ?? {}
  const base = basePath(options.base)
  const hashes = [...inlineScriptHashes({ prefetch: options.prefetch, dev: options.dev, base, offline: offlineOf(options, { dev: options.dev === true }) }), ...(options.scripts ?? []).map(sourceHash)]
  const styles = (options.styles ?? []).map(sourceHash)
  const reportTo = reports === true ? `${base}${CSP_REPORTS}` : reports

  if (reportTo !== undefined)
    headers['reporting-endpoints'] = `${CSP_ENDPOINT}="${reportTo}"`

  const added = pages.flatMap(page => page.csp ? [page.csp] : [])

  if (csp !== false) {
    const directives = policy([csp ?? {}], hashes, styles, reportTo, options.islands, added)
    const frames = frameOptions(directives.get('frame-ancestors'))

    headers['content-security-policy'] = serialized(directives)

    if (frames === undefined)
      delete headers['x-frame-options']
    else
      headers['x-frame-options'] = frames
  }

  if (reportOnly)
    headers['content-security-policy-report-only'] = serialized(policy([csp === false || csp === undefined ? {} : csp, reportOnly], hashes, styles, reportTo, options.islands, added))

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
// The request id every context holds goes on the response itself when it is alone there, so Elysia has no header to copy the response for.
export function ownHeaders(set: Context['set'], copies: HeaderCopies): Record<string, string> {
  const id = requestIdAlone(set.headers)

  if (id !== undefined) {
    delete set.headers[REQUEST_ID_HEADER]

    return { ...copies.secured, [REQUEST_ID_HEADER]: id }
  }

  if (!isNotEmpty(set.headers))
    return copies.secured

  setSecurityHeaders(set, copies.security)

  return copies.plain
}

function requestIdAlone(headers: Context['set']['headers']): string | undefined {
  let id: string | undefined

  for (const name in headers) {
    if (name !== REQUEST_ID_HEADER)
      return undefined

    id = headers[name]
  }

  return id
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
