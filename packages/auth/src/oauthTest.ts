import type { Elysia } from 'elysia'
import type { Core } from './core'
import type { OAuthTokens, OAuthUser } from './oauth/types'
import { Elysia as ElysiaApp } from 'elysia'
import { OAuthExchangeError } from './oauth/client'

// What a stubbed provider answers: the account a sign-in comes back with, or why it fails. `access_denied` is a refused consent, `invalid_grant` a code the provider rejects and `server_error` a provider that is down.
export type OAuthStub = { id: string, email?: string | undefined, username?: string | undefined, displayName?: string | undefined, avatar?: string | undefined } | { error: 'access_denied' | 'invalid_grant' | 'server_error' }

export interface OAuthTest {
  // Makes the provider answer with this account, or this failure, for every sign-in until the returned function is called, with no request to the provider; a second stub of the provider replaces the first.
  stub: (provider: string, outcome: OAuthStub) => Promise<() => void>
  // Leaves for the stubbed provider and comes back, as the browser does, and answers the callback's response: a redirect to where the sign-in goes, or to the sign-in page with `?error=`. `redirect` is the page asked for.
  signIn: (provider: string, options?: { redirect?: string | undefined }) => Promise<Response>
}

// A site with a `fetch`, the one `testSite()` returns, is driven through it; one with only its cookies, through the plugin.
export interface OAuthSite {
  cookies: Bun.CookieMap
  fetch?: ((path: string) => Promise<Response>) | undefined
}

type Entry = Core['oauth'] extends Map<string, infer Value> ? Value : never

const STUB_TOKENS: OAuthTokens = { accessToken: 'stub-access-token', refreshToken: 'stub-refresh-token', tokenType: 'Bearer' }
const FAILURE_STATUS = { access_denied: 400, invalid_grant: 400, server_error: 502 }
// The client each stubbed provider had, and what it was stubbed with.
const originals = new WeakMap<Entry, Entry['client']>()
const stubs = new WeakMap<Entry, OAuthStub>()

function userOf(account: Extract<OAuthStub, { id: string }>): OAuthUser {
  const { id, email, username, displayName, avatar } = account
  const at = email?.indexOf('@') ?? -1

  return { providerId: id, username: username ?? (email !== undefined && at > 0 ? email.slice(0, at) : id), displayName, avatar: avatar ?? null, email: email ?? null }
}

// A request to the plugin as the site's browser sends it: the cookies so far go along, and the ones the response sets are kept, redirects not followed. A cookie's `Path`, `Domain` and `Secure` are ignored, as the plugin's routes are the only ones asked and every one of its cookies is for them; a test reaching the whole app passes the site's own `fetch`.
async function throughPlugin(plugin: Elysia, cookies: Bun.CookieMap, path: string): Promise<Response> {
  const cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ')
  const response = await new ElysiaApp().use(plugin).handle(new Request(`http://localhost${path}`, { headers: cookie === '' ? {} : { cookie } }))

  for (const line of response.headers.getSetCookie()) {
    const parsed = Bun.Cookie.parse(line)

    if (parsed.maxAge === 0 || (parsed.expires !== undefined && parsed.expires.getTime() <= Date.now()))
      cookies.delete(parsed.name)
    else
      cookies.set(parsed.name, parsed.value)
  }

  return response
}

export function oauthTest(core: Core, plugin: Elysia, site: OAuthSite): OAuthTest {
  const visit = site.fetch ?? (async (path: string) => throughPlugin(plugin, site.cookies, path))

  const stubbed = (provider: string, outcome: OAuthStub): () => void => {
    const entry = core.oauth.get(provider)

    if (!entry)
      throw new Error(`kayjs-auth: oauth.stub found no provider ${provider} configured, its names are ${[...core.oauth.keys()].join(', ') || 'none'}`)

    if ('id' in outcome && outcome.id === '')
      throw new Error('kayjs-auth: oauth.stub needs the account\'s id')

    const real = originals.get(entry) ?? entry.client
    const failure = 'error' in outcome ? new OAuthExchangeError(FAILURE_STATUS[outcome.error], `OAuth token request failed (${provider}): ${outcome.error}`) : undefined
    const user = 'id' in outcome ? userOf(outcome) : undefined

    originals.set(entry, real)
    stubs.set(entry, outcome)
    entry.client = {
      ...real,
      // A provider whose endpoints are discovered would be asked for them first.
      authorizeUrl: async options => entry.app.provider.discover ? `https://${provider}.stub.invalid/authorize?state=${options?.state ?? ''}` : real.authorizeUrl(options),
      exchangeCode: async () => failure ? Promise.reject(failure) : STUB_TOKENS,
      readUser: async () => user ?? Promise.reject(failure),
      fetchUser: async () => user ?? Promise.reject(failure),
      revokeToken: async () => Promise.resolve(false),
    }

    return () => {
      entry.client = real
      originals.delete(entry)
      stubs.delete(entry)
    }
  }

  return {
    stub: async (provider, outcome) => Promise.resolve(stubbed(provider, outcome)),

    async signIn(provider, options = {}) {
      const entry = core.oauth.get(provider)
      const outcome = entry && stubs.get(entry)

      if (!outcome)
        throw new Error(`kayjs-auth: oauth.signIn found no stub for ${provider}: call oauth.stub first`)

      const start = await visit(`${core.prefix}/${provider}${options.redirect === undefined ? '' : `?redirect=${encodeURIComponent(options.redirect)}`}`)
      const location = start.headers.get('location')

      if (location === null)
        throw new Error(`kayjs-auth: oauth.signIn found no redirect to ${provider}, the sign-in route answered ${start.status}`)

      const state = encodeURIComponent(new URL(location, 'http://localhost').searchParams.get('state') ?? '')
      const answer = 'error' in outcome && outcome.error === 'access_denied' ? 'error=access_denied' : 'code=stub-code'

      return visit(`${core.prefix}/${provider}/callback?${answer}&state=${state}`)
    },
  }
}
