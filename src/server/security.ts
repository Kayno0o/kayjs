import type { Context } from 'elysia'
import type { KayConfig, SecurityConfig } from '../config'
import type { Prefetch } from './speculation'
import { isNotEmpty } from 'elysia/utils'
import { basePath } from './base'
import { inlineScriptHashes, sourceHash } from './csp'
import { CSP_ENDPOINT, CSP_REPORTS } from './violations'

export interface SecurityOptions {
  security?: SecurityConfig | false | undefined
  prefetch?: Prefetch | undefined
  dev?: boolean | undefined
  base?: string | undefined
  offline?: KayConfig['offline'] | undefined
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

const HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  // `frame-ancestors` for browsers that predate it.
  'x-frame-options': 'SAMEORIGIN',
  // A page this site opens in another window, or that opens one of its pages, gets no handle on it: no `window.opener` across sites.
  'cross-origin-opener-policy': 'same-origin',
  // Features a site rarely uses, refused to it and to anything it embeds, so an injected script cannot ask for them.
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
  // No Flash or Acrobat cross-domain policy file is honoured.
  'x-permitted-cross-domain-policies': 'none',
}

// The headers every response carries unless the app sets its own, or undefined with `security: false`.
export function securityHeaders(options: SecurityOptions): Record<string, string> | undefined {
  if (options.security === false)
    return undefined

  const headers: Record<string, string> = { ...HEADERS }
  const { csp, reports, reportOnly } = options.security ?? {}
  const base = basePath(options.base)
  const hashes = [...inlineScriptHashes({ prefetch: options.prefetch, dev: options.dev, base, offline: options.offline !== undefined && !options.dev }), ...(options.scripts ?? []).map(sourceHash)]
  const styles = (options.styles ?? []).map(sourceHash)
  const reportTo = reports === true ? `${base}${CSP_REPORTS}` : reports

  if (reportTo !== undefined)
    headers['reporting-endpoints'] = `${CSP_ENDPOINT}="${reportTo}"`

  if (csp !== false)
    headers['content-security-policy'] = policy([csp ?? {}], hashes, styles, reportTo)

  if (reportOnly)
    headers['content-security-policy-report-only'] = policy([csp === false || csp === undefined ? {} : csp, reportOnly], hashes, styles, reportTo)

  for (const [name, value] of Object.entries(options.security?.headers ?? {})) {
    if (value === false)
      delete headers[name.toLowerCase()]
    else
      headers[name.toLowerCase()] = value
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
export function ownHeaders(set: Context['set'], copies: HeaderCopies): Record<string, string> {
  if (!isNotEmpty(set.headers))
    return copies.secured

  setSecurityHeaders(set, copies.security)

  return copies.plain
}

// kay's directives with each layer of the app's merged over them in turn, a directive given `false` left out; `script-src` and `script-src-elem` always keep the hashes of kay's inline scripts, and `style-src` and `style-src-elem` those of its inline styles.
// A hash switches `'unsafe-inline'` off, so a style directive allowing it gets none.
// `report-uri` is for browsers that predate `report-to`, which those that know it read instead.
function policy(layers: Record<string, string[] | false>[], hashes: string[], styles: string[], reportTo: string | undefined): string {
  const directives = new Map(Object.entries(DIRECTIVES))

  for (const overrides of layers) {
    for (const [name, sources] of Object.entries(overrides)) {
      if (sources === false)
        directives.delete(name)
      else
        directives.set(name, sources)
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

  return [...directives].map(([name, sources]) => sources.length > 0 ? `${name} ${sources.join(' ')}` : name).join('; ')
}
