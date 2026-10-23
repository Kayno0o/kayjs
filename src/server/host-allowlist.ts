import type { Elysia } from 'elysia'
import { KayError } from '../compiler/errors'
import { nodeNet } from './builtins'

const BRACKETS = /^\[|\]$/g
const LOCAL_NAME = /(?:^|\.)localhost$/
const TRAILING_DOT = /\.$/

// The host name a `Host` header carries, lowercased without its port or trailing dot, or undefined for one that is no host.
export function hostName(host: string): string | undefined {
  return URL.parse(`http://${host}`)?.hostname.replace(TRAILING_DOT, '')
}

// Names other than a site's own are refused in production when `security.hosts` is set, as a page of another site renaming itself to this server's address (DNS rebinding) would reach it by its own name.
// Localhost and IP addresses are always let in, as a health check or a collector on the private network reaches the server by them and a rebinding page cannot make a browser send one.
export function refuseUnknownHosts(app: Elysia, options: { site: string | undefined, hosts: string[] | true, localeHosts: string[], security: Record<string, string> | undefined }): void {
  const allowed = new Set([...options.hosts === true ? [] : options.hosts, ...options.localeHosts].map(name => hostName(name) ?? name.toLowerCase()))
  const siteName = options.site === undefined ? undefined : URL.parse(options.site)?.hostname

  if (siteName !== undefined)
    allowed.add(siteName)

  if (allowed.size === 0)
    throw new KayError('config-invalid', 'kay: security.hosts answers to no host name, so every named host would get a 421: set `site` in kay.config.ts (or SITE_URL), or list the names in `security.hosts`')

  app.onRequest(({ request }) => {
    const host = request.headers.get('host')

    if (host === null)
      return

    const name = hostName(host)

    if (name !== undefined && (allowed.has(name) || LOCAL_NAME.test(name) || nodeNet().isIP(name.replace(BRACKETS, '')) !== 0))
      return

    return new Response('Misdirected request: this host is not one the site answers to\n', { status: 421, headers: { ...options.security, 'content-type': 'text/plain; charset=utf-8' } })
  })
}
