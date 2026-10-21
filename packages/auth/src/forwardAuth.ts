import type { Elysia } from 'elysia'
import type { BareUser, Core } from './core'
import { siteRoot } from './authorize/metadata'
import { homeOf } from './core'

// A domain, or several: the sites behind the proxy are on them or on their subdomains.
export type ForwardDomains = string | string[]

export interface ForwardAuthOptions {
  domains: ForwardDomains
  // Refuses a user without two-factor, sending them to set it up on the account page, instead of letting a password alone open the sites. Off by default.
  requireTwoFactor?: boolean | undefined
}

export interface ForwardAuthCore {
  domains: string[]
  requireTwoFactor: boolean
}

// What the route reads of the request's `auth`.
interface ForwardUser {
  bareUser: () => Promise<BareUser | null>
  via: () => Promise<'session' | 'bearer' | null>
}

const MAX_URL_LENGTH = 2048
// Printable ASCII, which a header carries as it is.
const PLAIN_HEADER = /^[\u0020-\u007E]*$/

// The domains `forwardAuth` names, each a hostname of two labels at least with no scheme, port or path, so one misspelt as `com` or `https://example.com/` stops the app at startup rather than opening a whole suffix or nothing. A public suffix of two labels (`co.uk`, `github.io`) passes: kay carries no suffix list, so naming the app's own domain is the app's to get right.
export function forwardOf(option: ForwardDomains | ForwardAuthOptions | undefined): ForwardAuthCore | undefined {
  if (option === undefined)
    return undefined

  const { domains, requireTwoFactor = false } = typeof option === 'string' || Array.isArray(option) ? { domains: option } : option
  const listed = (typeof domains === 'string' ? [domains] : domains).map(domain => domain.trim().toLowerCase())

  if (listed.length === 0)
    throw new Error('kayjs-auth: `forwardAuth` needs at least one domain: `forwardAuth: \'example.com\'`')

  for (const domain of listed) {
    const labels = domain.split('.')
    const parsed = labels.length > 1 && labels.every(label => label !== '') ? URL.parse(`https://${domain}`) : null

    if (parsed === null || parsed.hostname !== domain)
      throw new Error(`kayjs-auth: \`forwardAuth\` domain '${domain}' is not a hostname such as 'example.com': no scheme, port or path, and at least two labels`)
  }

  return { domains: listed, requireTwoFactor }
}

// Where to send the visitor once signed in: an https URL on one of `domains` or their subdomains, as the browser normalised it, else nothing. Credentials in the URL, another scheme, a lookalike host and a URL of the portal's own sites all fall to nothing.
export function returnTarget(to: string | null | undefined, domains: string[]): string | undefined {
  if (to === null || to === undefined || to === '' || to.length > MAX_URL_LENGTH)
    return undefined

  const url = URL.parse(to)

  if (url === null || url.protocol !== 'https:' || url.username !== '' || url.password !== '')
    return undefined

  return domains.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)) ? url.href : undefined
}

// The URL the proxy was asked for: nginx's `X-Original-URL`, which the config sets to `$scheme://$http_host$request_uri`, else the `X-Forwarded-*` headers Traefik and Caddy send.
function requestedUrl(headers: Headers): string | null {
  const given = headers.get('x-original-url')

  if (given !== null)
    return given

  const host = headers.get('x-forwarded-host')

  return host === null ? null : `${headers.get('x-forwarded-proto') ?? 'https'}://${host}${headers.get('x-forwarded-uri') ?? '/'}`
}

// A value a header carries: printable ASCII as it is, anything else percent-encoded, as a name with an accent or a line break would be refused or split by the proxy.
function headerValue(value: string): string {
  return PLAIN_HEADER.test(value) ? value : encodeURIComponent(value.toWellFormed())
}

// The route a reverse proxy asks before it lets a request through to a site it guards, and the one a sign-in comes back through to that site. On kayjs-auth's own plugin: nothing the app declares beyond `forwardAuth`.
export function serveForwardAuth(plugin: Elysia, core: Core, forward: ForwardAuthCore, authOf: (ctx: unknown) => ForwardUser, granted: (role: string, user: BareUser) => boolean): void {
  const route = `${core.prefix}/forward`

  plugin
    .get(route, async (ctx) => {
      const { request } = ctx
      const { searchParams } = new URL(request.url)
      const auth = authOf(ctx)
      // A guest costs nothing to make, and a bearer token opens no site: only a person's session does.
      const user = await auth.bareUser()
      const person = user !== null && !user.guest && await auth.via() === 'session' ? user : null
      const headers = { 'cache-control': 'no-store' }

      if (person !== null) {
        const wanted = searchParams.getAll('role')

        if (wanted.length > 0 && !wanted.some(role => granted(role, person)))
          return new Response(null, { status: 403, headers })

        // A passkey stands for the password and the second factor both, so a user who holds one passes.
        if (!forward.requireTwoFactor || person.twoFactor || (await core.store.passkeys.listByUser(person.id)).length > 0) {
          const name = person.username ?? person.email ?? person.id

          return new Response(null, { status: 204, headers: { ...headers, 'remote-user': headerValue(name), 'remote-name': headerValue(name), 'remote-email': headerValue(person.email ?? ''), 'remote-groups': headerValue(person.roles.join(',')) } })
        }
      }

      const root = siteRoot(core, request)
      const original = returnTarget(requestedUrl(request.headers), forward.domains)
      // A signed-in user the second factor is missing for sets it up on the app's security page, which the prebuilt pages have; without them there is nowhere to send them.
      const setup = person !== null ? core.securityPage : undefined

      if (person !== null && setup === undefined)
        return new Response(null, { status: 403, headers })

      const where = setup ?? `${core.signInPage}${original === undefined ? '' : `?redirect=${encodeURIComponent(`${route}/return?to=${encodeURIComponent(original)}`)}`}`

      // A proxy that hands the answer to the browser as it is (Traefik, Caddy) wants the redirect itself; nginx's `auth_request` takes a 401 and its `Location`.
      return new Response(null, { status: searchParams.get('redirect') === '1' ? 302 : 401, headers: { ...headers, location: `${root}${where}` } })
    })
    // Back from signing in to the guarded site, if it is on the domains the app allows, else home.
    .get(`${route}/return`, ({ query, redirect }) => redirect(returnTarget(typeof query.to === 'string' ? query.to : undefined, forward.domains) ?? homeOf(core), 303))
}
