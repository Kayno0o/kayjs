import type { Elysia } from 'elysia'
import { KayError } from '../compiler/errors'
import { kayLog } from '../runtime/log'
import { nodeNet } from './builtins'

const BRACKETS = /^\[|\]$/g
const LOCAL_NAME = /(?:^|\.)localhost$/
const TRAILING_DOT = /\.$/
const FIX = 'list the host in `security.hosts`, have the proxy pass the real `Host` header, or set `security: { hosts: false }`'
const warned = new Set<string>()

function requestPath(request: Request): string {
  return URL.parse(request.url)?.pathname ?? ''
}

// The host name a `Host` header carries, lowercased without its port or trailing dot, or undefined for one that is no host.
export function hostName(host: string): string | undefined {
  return URL.parse(`http://${host}`)?.hostname.replace(TRAILING_DOT, '')
}

// Whether a host name is localhost, a subdomain of it or an IP address, which a rebinding page cannot make a browser send.
export function isLocalHost(name: string): boolean {
  return LOCAL_NAME.test(name) || nodeNet().isIP(name.replace(BRACKETS, '')) !== 0
}

// Names other than a site's own are refused in production when `security.hosts` is set, as a page of another site renaming itself to this server's address (DNS rebinding) would reach it by its own name.
// Localhost and IP addresses are always let in, as a health check or a collector on the private network reaches the server by them and a rebinding page cannot make a browser send one.
// A `*.example.com` entry answers any one label under the domain, never the bare domain.
export function refuseUnknownHosts(app: Elysia, options: { site: string | undefined, hosts: string[] | true, localeHosts: string[], security: Record<string, string> | undefined, health?: string[] | undefined }): void {
  const listed = [...options.hosts === true ? [] : options.hosts, ...options.localeHosts]
  const wildcards = listed.filter(name => name.startsWith('*.')).map(name => name.slice(1).toLowerCase())
  const allowed = new Set(listed.filter(name => !name.startsWith('*.')).map(name => hostName(name) ?? name.toLowerCase()))
  const siteName = options.site === undefined ? undefined : URL.parse(options.site)?.hostname

  if (siteName !== undefined)
    allowed.add(siteName)

  if (allowed.size === 0 && wildcards.length === 0)
    throw new KayError('config-invalid', 'kay: security.hosts answers to no host name, so every named host would get a 421: set `site` in kay.config.ts (or SITE_URL), or list the names in `security.hosts`')

  app.onRequest(({ request }) => {
    const host = request.headers.get('host')

    if (host === null)
      return

    const name = hostName(host)

    if (name !== undefined && (allowed.has(name) || isLocalHost(name) || wildcards.some(suffix => name.endsWith(suffix) && !name.slice(0, -suffix.length).includes('.') && name.length > suffix.length)))
      return

    // The container's own probe reaches the server by its service name.
    if (options.health?.includes(requestPath(request)))
      return

    if (!warned.has(host) && warned.size < 100) {
      warned.add(host)
      kayLog('warn', `refused a request for the host ${host} with a 421: ${FIX}`)
    }

    return new Response(`Misdirected request: this host is not one the site answers to\n${FIX}\n`, { status: 421, headers: { ...options.security, 'content-type': 'text/plain; charset=utf-8' } })
  })
}
