import type { DefinitionBase, EphemeralType, MetadataBase, RouteBase, SingletonBase, TSchema } from 'elysia'
import type { Duration, Guard } from 'kay'
import type { KayConfig, Session } from 'kay/server'
import type { Access } from './access'
import type { IssueTokenResult, TokenOptions } from './bearer'
import type { CaptchaOptions } from './captcha'
import type { AuthSessionData, BareUser, OAuthApp, Profile, User } from './core'
import type { EmailOptions } from './email'
import type { AuthEventInfo } from './events'
import type { ForwardAuthOptions, ForwardDomains } from './forwardAuth'
import type { ScopeRequirement } from './gate'
import type { RouteGuardOptions } from './guards'
import type { LimitsOption } from './limits'
import type { OrganizationsOptions } from './organizations'
import type { AuthPagesConfig } from './pages'
import type { CreateUserInput, CreateUserResult } from './password'
import type { AuthRequirement } from './request'
import type { CredentialRules } from './rules'
import type { AuthStore } from './store'
import type { Level, PolicyContext } from './types'
import { Elysia } from 'elysia'
import { requestOfContext } from 'kay/library'
import { banned, linkedUser } from './core'
import { gateOf, guardOf, memberOf } from './guards'
import { load } from './load'
import { AUTH_OF, CHECK_USER, PAGES_OF } from './pages'
import { requestAuth, socketUser } from './request'
import { callbackRoute, exportRoute, formPostRoute, sendCookies, serveUntypedRoutes, signOutRoute, startOAuthRoute, stopImpersonatingRoute } from './routes'
import { createCore, pagesHandle } from './setup'
import { testHelpers } from './testHelpers'
import { readRequestWith } from './viewer'

export type { AuthSessionData, BareUser, OAuthApp, Off, Profile, User } from './core'
export { Auth, SIGNED_IN_HINT } from './request'
export type { AuthRequirement, RequireUserOptions } from './request'

// The plugin kay's `session()` returns, whichever data the app keeps beside kayjs-auth's.
export interface SessionPlugin<Data extends AuthSessionData> {
  '~Ephemeral': { derive: { readonly session: Session<Data> } }
  // A key for one purpose from each of the session's secrets, in their order.
  'deriveSecret'?: (purpose: string) => string[]
  // Tells the plugin kayjs-auth ends sessions itself, so it does not warn that a cookie with no store cannot be revoked.
  'endsSessionsElsewhere'?: () => void
  // Names the domains `forwardAuth` shares the session under, which the cookie takes when the visited host is on one and the session names no `domain`.
  'sharesUnder'?: (domains: string[]) => void
}

export interface AuthOptions<Data extends AuthSessionData, Role extends string, Prefix extends string = '/auth', Scope extends string = never, OrgRole extends string = never, UserData extends object = Record<string, never>> {
  sessions: SessionPlugin<Data>
  // At least 32 characters, from the environment; each use gets its own key derived from it. A list rotates them: the first writes, every one reads. Left out, kayjs-auth derives its own from the session's secret, so one secret serves both.
  secret?: string | string[] | undefined
  store: AuthStore
  // The site's public origin, such as `https://example.com`, which OAuth callbacks, mailed links and passkeys are built on: the `site` of kay.config.ts (or SITE_URL) when left out, so an app on kay sets it once.
  site?: string | undefined
  // Where kayjs-auth's routes live, `/auth` by default: `/auth/discord` starts a Discord sign-in.
  prefix?: Prefix | undefined
  // The site's name, as mails and authenticator apps show it; the origin's host by default.
  name?: string | undefined
  // Where a sign-in that failed goes, with `?error=` saying why; the prebuilt sign-in page with `pages`, else `/`. Without `pages`, it is also where `guard()` and `requireUser()` send an anonymous visitor opening a page.
  signInPage?: string | undefined
  // Where every failed OAuth sign-in goes instead, with no reason in the URL, so that whether an account may sign in does not leak, as with an `allow` list.
  failurePage?: string | undefined
  // Where a sign-in goes to ask for the second factor, `/two-factor` by default: a page whose form posts the code to an action calling `verifyTwoFactor`.
  twoFactorPage?: string | undefined
  // The prebuilt pages, `auth()` as kay.config.ts lists it or `true` for its defaults: the sign-in, two-factor and sessions pages and the mailed links default to them.
  pages?: boolean | AuthPagesConfig | undefined
  // Mail for email verification, password resets, magic links and email changes.
  email?: EmailOptions | undefined
  // OAuth apps by the name their routes take: `{ discord: { provider: discordProvider(), clientId, clientSecret } }`.
  oauth?: Record<string, OAuthApp> | undefined
  // Asked with every provider account before any user is touched; false refuses the sign-in, as an allowlist does.
  allow?: ((profile: Profile) => boolean | Promise<boolean>) | undefined
  // Whether visitors make their own accounts, by registering, as a guest or with a provider account no user has linked: true by default. Without it users come from `auth.createUser` alone, and the prebuilt pages offer no registering.
  signUp?: boolean | undefined
  // Called once a new user exists, to create the app's own records for them. It gets one object: `user`, and the provider's `profile` for a sign-up by a provider account.
  onSignUp?: ((event: { user: User, profile: Profile | undefined }) => void | Promise<void>) | undefined
  // Called with the provider's profile whenever one answers for a user: every OAuth sign-in, the first included after `onSignUp`, and a link.
  // What the app keeps on each user, an object schema such as `s.Object({ avatar: s.Optional(s.String()) })`: `auth.user()` returns it typed as `data`, `profileFields` fills it, and a store keeps it as JSON.
  user?: (TSchema & { static: UserData }) | undefined
  // Called on every provider sign-in, the first and a link included, with `{ user, profile }`: the user as the app has them and the provider's profile. It runs before any second factor. What it returns is laid over `user().data`, only the fields `user` declares, and kept when the result fits the schema; return nothing to keep what is there, such as an avatar.
  profileFields?: ((event: { user: User<UserData>, profile: Profile }) => { [Field in keyof UserData]?: UserData[Field] | undefined } | void | Promise<{ [Field in keyof UserData]?: UserData[Field] | undefined } | void>) | undefined
  // Called once a user is deleted, to delete the app's own records for them.
  onDelete?: ((event: { user: User }) => void | Promise<void>) | undefined
  // Deletes a guest whose account is older than `maxAge` (a string such as '30d') and who has no session left, calling `onDelete` as for any user; 30 days by default.
  guests?: { maxAge: Duration } | undefined
  // What the app keeps about a user, added to their `exportData()` as `app`: their posts, their orders. Called with `{ user }`.
  exportData?: ((event: { user: User }) => unknown) | undefined
  // Called with every change to what protects an account, the ones mailed to the user, and with every sign-in, sign-out and failed sign-in of a known account, for an audit log of the app's own. It gets one object: `event`, `user`, `context` (where from, and who acted when not the user), and the fields of its kind, such as the `role` of a `role-granted` or the `method` of a `signed-in`.
  onAuthEvent?: ((info: AuthEventInfo) => void | Promise<void>) | undefined
  // Keeps the same events in the store's audit log, for `auditLog()`; `maxAge` a string such as '365d', a year by default. Each entry keeps the address cut to its /24 (IPv4) or /48 (IPv6) unless `ip` is 'full'.
  audit?: boolean | { maxAge?: Duration, ip?: 'full' | 'truncated' } | undefined
  // What a bearer token may be limited to, such as `['posts:read', 'posts:write']`: a route asks for one with `scope:`.
  scopes?: readonly Scope[] | undefined
  // Each role and the roles it includes: `{ admin: ['editor'], editor: [] }`.
  roles?: Record<Role, NoInfer<Role>[]> | undefined
  // Teams or workspaces users belong to, with roles of their own in each: `{ roles: { owner: ['admin'], admin: ['member'], member: [] }, owner: 'owner' }`.
  organizations?: OrganizationsOptions<OrgRole, NoInfer<Role>> | undefined
  // Who may list, ban and impersonate users and grant them roles, such as `'admin'`; nobody without it.
  admin?: AuthRequirement<NoInfer<Role>> | undefined
  // The roles every new user starts with, by password or by provider, such as a site's `user`. An unverified account holding only these counts as given none: see `requireVerified`.
  defaultRoles?: NoInfer<Role>[] | undefined
  // How long a session lives unseen when its sign-in asked to be remembered, `remember: true`: `remember: { maxAge: '90d' }`, 90 days by default. The other lifetimes are the session plugin's own: its `maxAge` without a choice, its `browserMaxAge` for `remember: false`, and its `absoluteMaxAge` from the sign-in however much it is used, "remember me" included.
  remember?: { maxAge?: Duration | undefined } | undefined
  // The password and username rules, over the defaults of 10 to 128 characters and 2 to 32: `{ password: { min: 12, check: p => /\d/.test(p) ? undefined : 'Add a digit.' }, username: { min: 3, max: 16 } }`. The server, the prebuilt pages and `features().rules` all follow them, and an island passes the same object, or `features().rules`, to `passwordProblem` and `usernameProblem` from `@kaynooo/kayjs-auth/rules`.
  rules?: CredentialRules | undefined
  // The app's page listing where the user is signed in, linked from new sign-in mails: `/account/sessions`.
  sessionsPage?: string | undefined
  // Where an address is, shown beside each session, from a geolocation database of the app's: `ip => cityOf(ip)`.
  locate?: ((ip: string) => string | null | undefined | Promise<string | null | undefined>) | undefined
  // Attempts allowed per client address and per account, over `DEFAULT_LIMITS`: `rateLimit: { signIn: { max: 10, window: '15m' } }`.
  rateLimit?: LimitsOption | undefined
  // Passkeys are made for `site`'s host and its origin; `rpId` widens them to a parent domain, `origins` lists every origin the site's pages are served from, and `rpName` is the name the authenticator shows (`name` by default). `userVerification` is how hard answering a second factor with a passkey asks for a PIN or a biometric, `'preferred'` by default: adding a passkey, signing in with one and re-proving always require it, as a passkey alone is two factors.
  passkeys?: { rpId?: string, origins?: string[], rpName?: string, userVerification?: 'required' | 'preferred' | 'discouraged' } | false | undefined
  // Password sign-in, registering, resets and changes; false answers `{ ok: false, error: 'off' }` from their methods and hides them from the prebuilt pages. On by default.
  password?: boolean | undefined
  // Sign-in links and codes mailed to the address (they need `email`); false answers `off` from their methods and the pages show none. On by default.
  magicLink?: boolean | undefined
  // Authenticator-app two-step verification: false answers `off` from setting it up, turning it on and new recovery codes, and the account page offers none. A user who turned it on before is still asked for the code at sign-in. On by default.
  twoFactor?: boolean | undefined
  // A CAPTCHA asked of registering, password sign-in, password resets and magic links: kay's proof of work by default, `proofOfWork({ difficulty })` to tune it, `{ verify: turnstile(secret) }` for a third party's, false for none.
  captcha?: CaptchaOptions | false | undefined
  // Refuses a new password Have I Been Pwned lists, with `true`, or that a check of the app's own finds.
  breachedPasswords?: boolean | ((password: string) => boolean | Promise<boolean>) | undefined
  // The proxies in front, read as kay.config.ts's `proxy` is, for a plain Elysia app that kay's `pages()` does not serve; a kay app sets it in kay.config.ts instead.
  proxy?: KayConfig['proxy'] | undefined
  // MCP clients sign in to the app by OAuth, on by default with `pages` and a store keeping it (`memoryAuthStore` and `pgStore` do): kayjs-auth serves the discovery documents, the authorization and token endpoints and the consent page, and the tokens it issues are bearer tokens. `false` turns it off; `fetch` reads the metadata document a client names by its URL, over the public internet only unless the app's own says otherwise.
  oauthServer?: boolean | { fetch?: ((url: string) => Promise<Response>) | undefined, defaultScopes?: readonly Scope[] | undefined } | undefined
  // A route for a reverse proxy to ask before it lets a request through to a site it guards (nginx `auth_request`, Traefik or Caddy forward auth): `${prefix}/forward` answers 204 with `Remote-User`, `Remote-Name`, `Remote-Email` and `Remote-Groups` for a signed-in person's session, or 401 with the sign-in page's URL as `Location`, which returns to the guarded site afterwards when it is on these domains or their subdomains. `requireTwoFactor` also refuses a user who has not set it up.
  forwardAuth?: ForwardDomains | ForwardAuthOptions | undefined
  // Replaces the default decision, which reads a string as a role and runs a predicate; use it with `decide` for grants on single records.
  authorize?: ((user: BareUser | null, requirement: AuthRequirement<Role>, level: Level, ctx: PolicyContext) => Promise<boolean>) | undefined
}

readRequestWith(requestOfContext)

// Auth for a kay app or a plain Elysia one, on the app's kay session.
export function createAuth<Data extends AuthSessionData, Role extends string = string, Prefix extends string = '/auth', const Scope extends string = never, OrgRole extends string = never, UserData extends object = Record<string, never>>(options: AuthOptions<Data, Role, Prefix, Scope, OrgRole, UserData>) {
  const core = createCore(options)
  const access = core.access as unknown as Access<Role>

  options.sessions.endsSessionsElsewhere?.()

  if (core.forward)
    options.sessions.sharesUnder?.(core.forward.domains)

  const plugin = new Elysia({ name: 'kayjs-auth' })
    // Typed as a plain instance: `AnyElysia` would merge `any` routes into the app's, and every link would check.
    .use(options.sessions as unknown as Elysia)
    .onStart(() => core.settle())
    .derive(ctx => ({ auth: requestAuth<Scope, Role, OrgRole, UserData>(ctx, core, options.proxy) }))
    .onAfterHandle({ as: 'global' }, sendCookies)
    // The session's derive reaches this instance only; lifting both globally lets them reach every route the app declares after it, however deep the plugin is used.
    .as('global')
    // Typed as their literal paths, so `kay check` checks links to them once the app registers its Elysia app.
    .get(`${core.prefix}/export` as `${Prefix}/export`, async ctx => exportRoute(ctx, core))
    .post(`${core.prefix}/sign-out` as `${Prefix}/sign-out`, async ctx => signOutRoute(ctx, core))
    .post(`${core.prefix}/stop-impersonating` as `${Prefix}/stop-impersonating`, async ctx => stopImpersonatingRoute(ctx, core))
    .get(`${core.prefix}/:provider` as `${Prefix}/:provider`, async ctx => startOAuthRoute(ctx, core, options.failurePage))
    .get(`${core.prefix}/:provider/callback` as `${Prefix}/:provider/callback`, async ctx => callbackRoute(ctx, core, options.failurePage))
    .post(`${core.prefix}/:provider/callback` as `${Prefix}/:provider/callback`, ctx => formPostRoute(ctx, core))

  serveUntypedRoutes(plugin as unknown as Elysia, core)

  return withPluginOwner({
    [PAGES_OF]: core.pages && pagesHandle(core, options),
    // What `kay auth create-user` asks before the password: what `createUser` would refuse the login for.
    [CHECK_USER]: async (input: CreateUserInput) => (await load.password()).userProblems(core, input),
    // `.use(auth.plugin)` before kay's pages: it adds `auth` to the context and kayjs-auth's routes, and uses the session plugin itself.
    plugin,
    hasRole: access.hasRole,
    isGranted: (role: Role, user: BareUser) => access.isGranted(role, user.roles),
    memberOf: (role?: OrgRole, memberOptions: { param?: string } = {}) => memberOf(core, role, memberOptions),
    socketUser,
    ...testHelpers<Role, UserData>(core, plugin as unknown as Elysia),

    // A user made by the app, as a script or an admin page makes one: checked as registering is, open with `signUp: false` too, signing no one in and mailing no one.
    async createUser(input: Omit<CreateUserInput, 'roles'> & { roles?: Role[] | undefined }): Promise<CreateUserResult> {
      return (await load.password()).createUser(core, input)
    },

    // A bearer token for `userId` taking no proof and sending no mail, for a flow the app gates itself, such as pairing a device, or a script. `token` adopts one the app handed out before, so its devices keep working through a migration.
    async issueToken(userId: string, label: string, tokenOptions: TokenOptions<Scope> & { token?: string | undefined } = {}): Promise<IssueTokenResult> {
      return (await load.bearer()).issueToken(core, userId, label, tokenOptions)
    },

    // The user a bearer token belongs to, for a websocket handshake sending one in its first message; null for a banned one. A token bound to a resource (an OAuth token asked for one) is accepted only with `url`, the address of the handshake, under that resource.
    async userFromToken(token: string, url?: string): Promise<User | null> {
      const owner = await (await load.bearer()).tokenUser(core, token, url ?? null)

      return owner && !banned(owner.record) ? linkedUser(core, owner.record) : null
    },

    // Closes every route of the Elysia instance it is used on unless the user meets `require`, signed in by default. A route takes `auth: <requirement>` to ask for more and `auth: false` to stay open.
    gate(gateOptions: { require?: AuthRequirement<Role>, scope?: ScopeRequirement<Scope> } = {}) {
      const gate = gateOf<Role, Scope>(core, gateOptions)

      return <Base extends string, Single extends SingletonBase, Defs extends DefinitionBase, Meta extends MetadataBase, Routes extends RouteBase, Eph extends EphemeralType, Vol extends EphemeralType>(app: Elysia<Base, Single, Defs, Meta, Routes, Eph, Vol>) => gate(app.use(plugin))
    },
    guard: (guardOptions: RouteGuardOptions<Role, Scope> = {}): Guard => guardOf(core, guardOptions),
  })
}

// `kay auth create-user` reaches the app's auth through its plugin when the extension was given the plugin alone.
function withPluginOwner<Auth extends { plugin: object }>(auth: Auth): Auth {
  Object.defineProperty(auth.plugin, AUTH_OF, { value: auth })

  return auth
}
