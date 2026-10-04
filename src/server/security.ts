import type { SecurityConfig } from '../config'
import type { Prefetch } from './speculation'
import { inlineScriptHashes } from './csp'

export interface SecurityOptions {
  security?: SecurityConfig | false
  prefetch?: Prefetch
  dev?: boolean
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

const HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  // `frame-ancestors` for browsers that predate it.
  'x-frame-options': 'SAMEORIGIN',
}

// The headers every response carries unless the app sets its own, or undefined with `security: false`.
export function securityHeaders(options: SecurityOptions): Record<string, string> | undefined {
  if (options.security === false)
    return undefined

  const headers: Record<string, string> = { ...HEADERS }
  const csp = options.security?.csp

  if (csp !== false)
    headers['content-security-policy'] = policy(csp ?? {}, inlineScriptHashes({ prefetch: options.prefetch, dev: options.dev }))

  for (const [name, value] of Object.entries(options.security?.headers ?? {})) {
    if (value === false)
      delete headers[name.toLowerCase()]
    else
      headers[name.toLowerCase()] = value
  }

  return headers
}

// kay's directives with the app's merged over them, a directive given `false` left out; `script-src` always keeps the hashes of kay's inline scripts.
function policy(overrides: Record<string, string[] | false>, hashes: string[]): string {
  const directives = new Map(Object.entries(DIRECTIVES))

  for (const [name, sources] of Object.entries(overrides)) {
    if (sources === false)
      directives.delete(name)
    else
      directives.set(name, sources)
  }

  const script = directives.get('script-src')

  if (script)
    directives.set('script-src', [...script, ...hashes])

  return [...directives].map(([name, sources]) => sources.length > 0 ? `${name} ${sources.join(' ')}` : name).join('; ')
}
