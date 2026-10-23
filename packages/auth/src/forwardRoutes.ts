import type { BareUser, Core } from './core'
import type { ForwardAuthCore } from './forwardAuth'
import { siteRoot } from './authorize/metadata'
import { returnTarget } from './forwardAuth'

// Printable ASCII, which a header carries as it is.
const PLAIN_HEADER = /^[\u0020-\u007E]*$/

// What the route reads of the request's `auth`.
interface ForwardUser {
  bareUser: () => Promise<BareUser | null>
  via: () => Promise<'session' | 'bearer' | null>
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

// The answer to the route a reverse proxy asks before it lets a request through to a site it guards.
export async function answerForward(ctx: { request: Request }, core: Core, forward: ForwardAuthCore, auth: ForwardUser, granted: (role: string, user: BareUser) => boolean): Promise<Response> {
  const route = `${core.prefix}/forward`
  const { request } = ctx
  const { searchParams } = new URL(request.url)
  // A guest costs nothing to make, and a bearer token opens no site: only a person's session does.
  const user = await auth.bareUser()
  const person = user !== null && !user.guest && await auth.via() === 'session' ? user : null
  const headers = { 'cache-control': 'no-store' }

  if (person !== null) {
    const wanted = searchParams.getAll('role')

    if (wanted.length > 0 && !wanted.some(role => granted(role, person)))
      return new Response(null, { status: 403, headers })

    if (!forward.requireTwoFactor || person.twoFactor) {
      const name = person.username ?? person.email ?? person.id

      return new Response(null, { status: 204, headers: { ...headers, 'remote-user': headerValue(name), 'remote-name': headerValue(name), 'remote-email': headerValue(person.email ?? ''), 'remote-groups': headerValue(person.roles.join(',')) } })
    }
  }

  const root = siteRoot(core, request)
  const original = returnTarget(requestedUrl(request.headers), forward.domains)
  // A signed-in user the second factor is missing for sets it up on the app's security page, where a passkey user adds an authenticator app, which the prebuilt pages have; without them there is nowhere to send them.
  const setup = person !== null ? core.securityPage : undefined

  if (person !== null && setup === undefined)
    return new Response(null, { status: 403, headers })

  const where = setup ?? `${core.signInPage}${original === undefined ? '' : `?redirect=${encodeURIComponent(`${route}/return?to=${encodeURIComponent(original)}`)}`}`

  // A proxy that hands the answer to the browser as it is (Traefik, Caddy) wants the redirect itself; nginx's `auth_request` takes a 401 and its `Location`.
  return new Response(null, { status: searchParams.get('redirect') === '1' ? 302 : 401, headers: { ...headers, location: `${root}${where}` } })
}
