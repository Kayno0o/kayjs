import type { Elysia } from 'elysia'
import type { Core } from './core'
import type { OAuthFailure } from './oauth/flow'
import type { Auth } from './request'
import { configError, underKayDev } from 'kay/library'
import { crossSiteResponse } from 'kay/server'
import { rootUsable } from './authorize/metadata'
import { serveOAuthServer } from './authorize/routes'
import { backOf, homeOf, withBack, withQuery } from './core'
import { returnTarget } from './forwardAuth'
import { load } from './load'
import { safeRedirect } from './oauth/redirect'
import { STATE, TAKE_COOKIES } from './request'

// Where `kay dev` answers the dev tool's Auth tab with the session's user.
const DEV_PATH = '/_kay/auth'
// What a provider posting back to the callback may say, carried over to the GET.
const FORM_POST_FIELDS = ['code', 'state', 'error', 'user']
const UNSAFE_FILE_NAME = /[^\w.-]/g

// What the routes read of Elysia's context.
interface RouteContext {
  auth: Pick<Auth, typeof STATE | 'exportData' | 'signOut' | 'stopImpersonating'>
  request: Request
  body: unknown
  query: Record<string, unknown>
  params: Record<string, string | undefined>
  set: { headers: Record<string, unknown> }
  redirect: (url: string, status: 303) => Response
  status: (code: 401 | 403 | 404 | 429, body: string) => unknown
}

// A query value as text: a name repeated in the URL arrives as a list, which no flow takes.
function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

// Where a failed OAuth sign-in goes: the sign-in page with why, keeping the page the visitor asked for, so they come back to it once they sign in another way; the `failurePage` the app gave instead, saying nothing.
function failed(core: Core, failurePage: string | undefined, error: OAuthFailure, redirect?: string | null): string {
  const back = backOf(core, redirect)
  const page = withQuery(core.signInPage, `error=${error}`)

  return failurePage ?? (back === null ? page : withBack(page, back))
}

// The cookies a sign-in or a sign-out adds, on the response the route built or on Elysia's own, as the session plugin's cookie is.
export function sendCookies(context: { set: { headers: Record<string, unknown> } }): void {
  const cookies = (context as unknown as { auth?: Auth }).auth?.[TAKE_COOKIES]() ?? []

  if (cookies.length === 0)
    return

  const response = (context as { responseValue?: unknown }).responseValue

  if (response instanceof Response) {
    for (const cookie of cookies)
      response.headers.append('set-cookie', cookie)

    return
  }

  context.set.headers['set-cookie'] = [context.set.headers['set-cookie'] ?? []].flat().concat(cookies)
}

// The signed-in user's data as a JSON download, linked from their account page.
export async function exportRoute({ auth, set, status }: RouteContext, core: Core) {
  const exported = await auth.exportData()

  if (!exported.ok) {
    if (exported.error === 'limited')
      return status(429, 'Too many exports; try again later')

    if (exported.error === 'impersonating')
      return status(403, 'Not while acting as the user')

    return exported.error === 'stale' ? status(403, 'Sign in again to continue') : status(401, 'Sign in to continue')
  }

  set.headers['content-disposition'] = `attachment; filename="${core.name.replaceAll(UNSAFE_FILE_NAME, '-')}-data.json"`
  set.headers['cache-control'] = 'no-store'

  return exported.data
}

// The sign-out button of any page: a form posting here, with `redirect` for where to go after, a path of the site, else the pages' home or `/`. A post only, so a link or a prefetch signs no one out, and a cross-site one is refused with a 403.
export async function signOutRoute({ auth, body, redirect }: RouteContext, core: Core) {
  await auth.signOut()

  return redirect(safeRedirect(text((body as Record<string, unknown> | undefined)?.redirect), homeOf(core)), 303)
}

// The impersonation banner's button: a form posting here signs the admin back in as themselves, then goes to `redirect`, a path of the site, else the pages' home. A post only, as sign-out is, and a cross-site one is refused with a 403.
export async function stopImpersonatingRoute({ auth, body, redirect, request }: RouteContext, core: Core) {
  if (auth[STATE].crossSite())
    return crossSiteResponse(request, 'request', core.url)

  await auth.stopImpersonating()

  return redirect(safeRedirect(text((body as Record<string, unknown> | undefined)?.redirect), homeOf(core)), 303)
}

// A GET, so a sign-in link works without JavaScript: give it `data-no-prefetch` so a hover starts nothing.
export async function startOAuthRoute({ auth, params: { provider = '' }, query, redirect, status }: RouteContext, core: Core, failurePage: string | undefined) {
  const started = !core.oauth.has(provider) ? undefined : await (await load.flow()).startOAuth(auth[STATE], provider, { redirect: text(query.redirect), remember: query.remember === undefined ? undefined : query.remember === '1' })

  if (started === undefined)
    return status(404, 'Not Found')

  // kay-allow external-redirect: the provider's authorize URL, else a sign-in page of this site
  return redirect(typeof started === 'string' ? started : failed(core, failurePage, started.error, text(query.redirect)), 303)
}

export async function callbackRoute({ auth, params: { provider = '' }, query, redirect }: RouteContext, core: Core, failurePage: string | undefined) {
  // The flow is read once here and handed to `finishOAuth`. A provider the app lacks still spends a pending flow its state matches, so the flow is not left in the session and its redirect is kept; with none pending, nothing loads.
  const flow = await auth[STATE].session.get('authOAuth')

  if (!core.oauth.has(provider) && flow === undefined)
    return redirect(failed(core, failurePage, 'oauth'), 303)

  const outcome = await (await load.flow()).finishOAuth(auth[STATE], provider, { code: text(query.code), state: text(query.state), error: text(query.error), user: text(query.user) }, flow)

  // kay-allow external-redirect: the flow's own redirect, checked when it started
  return redirect('error' in outcome ? failed(core, failurePage, outcome.error, outcome.redirect) : outcome.redirect, 303)
}

// Apple, or any provider asked for `response_mode=form_post`, comes back with a cross-site POST, which a SameSite=Lax session cookie does not ride on: the GET it is turned into does.
export function formPostRoute({ params: { provider = '' }, body, redirect, status }: Omit<RouteContext, 'auth'>, core: Core) {
  if (!core.oauth.has(provider))
    return status(404, 'Not Found')

  const form = (body ?? {}) as Record<string, unknown>
  const query = new URLSearchParams()

  // Not the ID token Apple posts too: the one the token endpoint answers is the one checked.
  for (const name of FORM_POST_FIELDS) {
    const value = form[name]

    if (typeof value === 'string')
      query.set(name, value)
  }

  return redirect(`${core.prefix}/${provider}/callback?${query}`, 303)
}

// The routes no link of the app's names, so they stay out of the plugin's type: the OAuth server's, the dev tool's and forward auth's.
export function serveUntypedRoutes(plugin: Elysia, core: Core): void {
  if (core.oauthServer)
    serveOAuthServer(plugin, core, ctx => (ctx as { auth: Auth }).auth[STATE])

  // Under `kay dev` alone: the dev tool's Auth tab reads the session here, and signs out at the sign-out route.
  if (underKayDev()) {
    plugin.get(DEV_PATH, async (ctx) => {
      const { auth } = ctx as unknown as { auth: Auth }
      const [user, via] = await Promise.all([auth.bareUser(), auth.via()])

      ctx.set.headers['cache-control'] = 'no-store'

      return { user, via, signOut: `${core.prefix}/sign-out` }
    })
  }

  if (!core.forward)
    return

  if (!rootUsable(core))
    throw configError('forwardAuth sends visitors to the sign-in page by its full URL: set `site` in kay.config.ts, SITE_URL or in createAuth')

  const forward = core.forward
  const route = `${core.prefix}/forward`

  // The route a reverse proxy asks before it lets a request through to a site it guards, and the one a sign-in comes back through to that site.
  plugin
    .get(route, async (ctx) => {
      const answer = (await import('./forwardRoutes')).answerForward

      return answer(ctx, core, forward, (ctx as unknown as { auth: Auth }).auth, (role, user) => core.access.isGranted(role, user.roles))
    })
    // Back from signing in to the guarded site, if it is on the domains the app allows, else home.
    // kay-allow external-redirect: `returnTarget` keeps only an https URL on the allowed domains
    .get(`${route}/return`, ({ query, redirect }) => redirect(returnTarget(typeof query.to === 'string' ? query.to : undefined, forward.domains) ?? homeOf(core), 303))
}
