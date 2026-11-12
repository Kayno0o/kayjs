import type { Duration } from 'kay'
import type { Access } from './access'
import type { AuthOptions } from './auth'
import type { AuthSessionData, Core } from './core'
import type { AccountOptions } from './deletion'
import type { EmailOptions } from './email'
import type { AuthPagesConfig, PagesHandle } from './pages'
import type { AuthStore, LinkType, TokenType } from './store'
import { asConfigError, configError, configuredSite, decide, dispatch, durationSeconds, kv } from 'kay/library'
import { accessOf } from './access'
import { pwnedPassword } from './breached'
import { proofOfWork } from './captcha'
import { authContext } from './events'
import { forwardOf } from './forwardAuth'
import { guardOf } from './guards'
import { deriveKeys } from './keys'
import { resolveLimits } from './limits'
import { log } from './log'
import { mailLanguages } from './mail'
import { createOAuthClient } from './oauth/client'
import { createOAuthTokenRefresher } from './oauth/refresher'
import { organizationsCore } from './organizationsCore'
import { DEFAULT_PREFIX as DEFAULT_PAGES_PREFIX, pagePaths, pagesOf } from './pages'
import { authLimiters } from './rates'
import { resolveRules } from './rules-check'
import { userDataRules } from './userData'

const TRAILING_SLASH = /\/$/

const DEFAULT_REMEMBER_MAX_AGE = 90 * 24 * 60 * 60
const DEFAULT_AUDIT_MAX_AGE = 365 * 24 * 60 * 60
const DEFAULT_GUEST_MAX_AGE = 30 * 24 * 60 * 60
const DEFAULT_UNVERIFIED_MAX_AGE = 30 * 24 * 60 * 60
const LINK_TYPES: LinkType[] = ['verify-email', 'reset-password', 'magic-link', 'change-email']

const MINUTE = 60
const HOUR = 60 * MINUTE

// How long each link and code works, in seconds, unless the `email.maxAge` option says otherwise.
const TOKEN_LIFETIMES: Record<TokenType, number> = {
  'verify-email': 24 * HOUR,
  'reset-password': HOUR,
  'magic-link': 15 * MINUTE,
  'change-email': HOUR,
  'sign-in-code': 10 * MINUTE,
  'verify-code': 10 * MINUTE,
}

// The lifetimes the `maxAge` option sets over the defaults, in seconds, a bad one failing at boot naming it.
export function tokenLifetimes(maxAge: EmailOptions['maxAge']): Record<TokenType, number> {
  const lifetimes = { ...TOKEN_LIFETIMES }
  const named = (key: string): string => `email.maxAge.${key}`
  const unknown = Object.keys(maxAge ?? {}).find(key => !Object.hasOwn(TOKEN_LIFETIMES, key))

  if (unknown !== undefined)
    throw configError('auth', 'links', `${named(unknown)} is no link or code of kayjs-auth`)

  for (const type of Object.keys(lifetimes) as TokenType[]) {
    const wanted = maxAge?.[type]

    if (wanted !== undefined)
      lifetimes[type] = durationSeconds(wanted, named(type))
  }

  return lifetimes
}

// A hook of the options as the positional function the core calls, given its event object.
function hooked<Args extends unknown[], Result>(hook: ((...args: never[]) => Result) | undefined, event: (...args: Args) => object): ((...args: Args) => Result) | undefined {
  return hook && ((...args: Args) => hook(event(...args) as never))
}

// `onSignUp` as the flows call it: told through `dispatch`, so a throw is reported and never fails the sign-up that happened.
function signUpHook(hook: AuthOptions<AuthSessionData, string>['onSignUp']): Core['onSignUp'] {
  return hook && (async (user, profile) => dispatch('auth.onSignUp', [hook as never], { user, profile }, { context: await authContext() }))
}

// `beforeDelete` as the erase asks it: a refusal answers the failure of kind `refused`, carrying the status and message the hook gave.
function deleteHook(hook: AuthOptions<AuthSessionData, string>['beforeDelete']): Core['beforeDelete'] {
  return hook && (async (user, actor) => {
    const answer = await decide('auth.beforeDelete', [hook as never], { user }, await authContext(actor))

    if ('refused' in answer) {
      const { status, message, errors, data } = answer.refused

      return { code: 'refused', status, message, errors, data }
    }

    return undefined
  })
}

// The seconds of a lifetime option, rounded up to whole ones as a cookie's Max-Age and the stored lifetimes take them.
function wholeSeconds(value: Duration, what: string): number {
  return Math.ceil(durationSeconds(value, what))
}

// Seconds an account never verified is kept: only where unverified accounts cannot sign in, as one that can is an account in use.
function unverifiedMaxAge(email: EmailOptions | undefined): number | undefined {
  if (!email)
    return undefined

  if (email.unverifiedMaxAge !== undefined)
    return wholeSeconds(email.unverifiedMaxAge, 'email.unverifiedMaxAge')

  return email.requireVerified ?? true ? DEFAULT_UNVERIFIED_MAX_AGE : undefined
}

// The grace period `account.deleteAfter` sets: a store that cannot list the accounts due is refused, as is a mail link with no page to open.
function deletionOf(options: { account?: AccountOptions | undefined, store: AuthStore }, pages: Core['pages']): Core['deletion'] {
  const account = options.account

  if (account?.deleteAfter === undefined)
    return undefined

  if (!options.store.users.dueForDeletion)
    throw configError('auth', 'account', '`account.deleteAfter` needs a store with `users.dueForDeletion`, as `memoryAuth` and `pgAuth` have')

  if (!pages && account.cancelPage === undefined)
    throw configError('auth', 'account', '`account.deleteAfter` mails a link to cancel the deletion: set `pages` for the prebuilt account page, or `account.cancelPage` to your own')

  return { after: wholeSeconds(account.deleteAfter, 'account.deleteAfter'), cancelPage: account.cancelPage }
}

function auditMaxAge(audit: true | { maxAge?: Duration, ip?: 'full' | 'truncated' }): number {
  return audit === true || audit.maxAge === undefined ? DEFAULT_AUDIT_MAX_AGE : wholeSeconds(audit.maxAge, 'audit.maxAge')
}

// Lets `auth()` hand a `authCore({ pages: true })` its prefix and home, the paths derived from the prefix following, whichever of the two ran first.
export function pagesHandle(core: Core, options: { pages?: boolean | AuthPagesConfig | undefined, signInPage?: string | undefined, twoFactorPage?: string | undefined, sessionsPage?: string | undefined, securityPage?: string | undefined, email?: { links?: Partial<Record<LinkType, string>> | undefined } | undefined }): PagesHandle {
  const own = typeof options.pages === 'object' ? options.pages : {}

  return {
    adopt(given) {
      const pages = core.pages

      if (!pages)
        return

      if (own.prefix !== undefined && own.prefix !== (given.prefix ?? DEFAULT_PAGES_PREFIX))
        throw configError('auth', 'pages', `auth() serves the pages under '${given.prefix ?? DEFAULT_PAGES_PREFIX}' and authCore({ pages: { prefix: '${own.prefix}' } }) sends users to '${own.prefix}'. Give auth({ prefix: '${own.prefix}' }), or drop the prefix of one of them`)

      if (own.home === undefined && given.home !== undefined)
        pages.home = given.home
      else if (own.home !== undefined && given.home !== undefined && own.home !== given.home)
        log.warn(`auth({ home: '${given.home}' }) and authCore({ pages: { home: '${own.home}' } }) differ, and authCore's wins: users go to '${own.home}'. Give home once, or the same in both`)

      if (own.prefix !== undefined || given.prefix === undefined || given.prefix === pages.prefix)
        return

      const paths = pagePaths(given.prefix)

      pages.prefix = given.prefix
      core.signInPage = options.signInPage ?? paths.signIn
      core.twoFactorPage = options.twoFactorPage ?? paths.twoFactor
      core.sessionsPage = options.sessionsPage ?? paths.sessions
      core.securityPage = options.securityPage ?? paths.security

      if (core.email)
        core.email.links = emailLinks(options.email?.links, paths.links)
    },
  }
}

const HAS_SCHEME = /^[a-z][\d+.a-z-]*:\/\//i
const HOST_LIKE = /^(?:[\w-]+(?:\.[\w-]+)+(?::\d+)?|[\w.-]+:\d+)$/

// The keys are derived as `auth()` is made when it has a secret of its own, or a session that cannot derive one, so a bad one fails there; the session's is derived on first use.
function checkKeys(core: Core, options: { secret?: string | string[] | undefined, sessions: { deriveSecret?: unknown } }): void {
  if (options.secret !== undefined || options.sessions.deriveSecret === undefined)
    void core.keys
}

// The origin and the display name the options give: `site` is the origin, which has a scheme.
function siteOptions(options: { site?: string | undefined, name?: string | undefined }): { origin: string | undefined, name: string | undefined } {
  const site = options.site

  if (site !== undefined && !HAS_SCHEME.test(site))
    throw configError('auth', 'site', HOST_LIKE.test(site) ? `\`site\` is the site's origin, such as \`https://${site}\`, and \`${site}\` has no scheme: add it, or give the display name as \`name\`` : `\`site\` is the site's origin, such as \`https://example.com\`, and \`${site}\` is not one: give the display name as \`name\``)

  return { origin: site, name: options.name }
}

function noSecret(): never {
  throw configError('auth', 'secret', '`secret` is missing and the session plugin cannot derive one; pass a secret of at least 32 characters, or a plugin from kay\'s `session()`')
}

// What createCore builds on the site's origin, once it has one.
interface SiteBound {
  url: string | undefined
  oauth: Core['oauth']
  refreshers: Core['refreshers']
  name: string
  passkeys: Core['passkeys']
}

function warnWithoutPrivacy(pages: ReturnType<typeof pagesOf>, options: { signUp?: boolean | undefined, password?: unknown }) {
  if (process.env.NODE_ENV === 'production' && pages && pages.privacy === undefined && (options.signUp ?? true) && options.password !== false)
    log.warn('the stock register page collects an email address and states no purpose and links no privacy policy: set `pages: { privacy: \'/privacy\' }`, with `purpose` for the line above the link')
}

export function createCore<Data extends AuthSessionData, Role extends string, Prefix extends string, Scope extends string, OrgRole extends string, UserData extends object>(options: AuthOptions<Data, Role, Prefix, Scope, OrgRole, UserData>): Core {
  const prefix = options.prefix ?? '/auth'

  const oauthApps = Object.entries(options.oauth ?? {})
  const { origin, name } = siteOptions(options)
  const given = origin?.replace(TRAILING_SLASH, '')
  const languages = options.email && mailLanguages(options.email)
  const pages = pagesOf(options.pages)
  const passkeyOptions = options.passkeys === false ? undefined : options.passkeys
  const paths = pages && pagePaths(pages.prefix)
  const access = accessOf<Role>(options)
  const admin = options.admin

  if (process.env.NODE_ENV === 'production' && admin !== undefined && options.twoFactor !== false && !(typeof options.twoFactor === 'object' && options.twoFactor.require !== undefined))
    log.warn('`admin` is on and no `twoFactor.require` names it, so an admin can sign in without two-factor: set `twoFactor: { require: [\'admin\'] }`')

  warnWithoutPrivacy(pages, options)

  const needsUrl = oauthApps.length > 0 || options.email !== undefined
  let bound: SiteBound | undefined
  // What a core with no origin yet builds: with nothing to build on it is the same each time, so it is kept until an origin turns up.
  let waiting: SiteBound | undefined

  // What depends on the site's origin: `url` if given, else the `site` of kay.config.ts or SITE_URL, which a server knows once it set up. An auth made while the app's modules load asks again when first used, and keeps what it built once it has an origin.
  const bind = (): SiteBound => {
    if (bound)
      return bound

    const url = given ?? configuredSite()?.origin.replace(TRAILING_SLASH, '')

    if (needsUrl && url === undefined)
      throw configError('auth', 'site', 'OAuth sign-in and mailed links need the site\'s public origin to build their URLs: set `site` in kay.config.ts or SITE_URL, or in authCore')

    if (url === undefined && waiting)
      return waiting

    const clients: Core['oauth'] = new Map()

    for (const [name, app] of oauthApps)
      clients.set(name, { app, client: createOAuthClient(app.provider, { clientId: app.clientId, clientSecret: app.clientSecret, redirectUri: `${url}${prefix}/${name}/callback` }) })

    const made: SiteBound = {
      url,
      oauth: clients,
      refreshers: new Map(),
      name: name ?? (url === undefined ? 'kayjs-auth' : new URL(url).host),
      passkeys: url === undefined || options.passkeys === false
        ? undefined
        : { id: passkeyOptions?.rpId ?? new URL(url).hostname, name: passkeyOptions?.rpName ?? name ?? new URL(url).host, origins: passkeyOptions?.origins ?? [new URL(url).origin], userVerification: passkeyOptions?.userVerification ?? 'preferred' },
    }

    if (url === undefined)
      waiting = made
    else
      bound = made

    refreshersFor(made)

    return made
  }

  // Without a mailer registering signs the new user in, so it cannot answer alike for a held address and a free one.
  if (process.env.NODE_ENV === 'production' && (options.signUp ?? true) && options.password !== false && !(options.email?.requireVerified ?? options.email !== undefined))
    log.warn('password sign-up is open with no `email` option or with `requireVerified` off, so `password.register` answers `taken` for an address that has an account and tells a guest which addresses exist: set `email` with a mailer (and `requireVerified` on), or `signUp: false`')

  let keys: Core['keys'] | undefined
  const core: Core = {
    store: options.store,
    rates: authLimiters(options.store),
    // On first use, as the session's secret may be the config's, which is not read while a module loads.
    get keys() {
      return keys ??= deriveKeys(options.secret ?? options.sessions.deriveSecret?.('kayjs-auth') ?? noSecret())
    },
    get url() {
      return bind().url
    },
    settle() {
      if (needsUrl)
        bind()
    },
    prefix,
    signInPage: options.signInPage ?? paths?.signIn ?? '/',
    ownSignInPage: options.signInPage,
    twoFactorPage: options.twoFactorPage ?? paths?.twoFactor ?? '/two-factor',
    pages,
    get name() {
      return bind().name
    },
    limits: resolveLimits(options.rateLimit),
    rules: asConfigError(() => resolveRules(options.rules)),
    sessionsPage: options.sessionsPage ?? paths?.sessions,
    securityPage: options.securityPage ?? paths?.security,
    locate: options.locate,
    scopes: new Set(options.scopes),
    get passkeys() {
      return bind().passkeys
    },
    switches: { password: options.password !== false, passkeys: options.passkeys !== false, magicLink: options.magicLink !== false, twoFactor: options.twoFactor !== false },
    ...typeof options.twoFactor === 'object' && options.twoFactor.require !== undefined && { twoFactorRequire: options.twoFactor.require },
    captcha: options.captcha === false ? undefined : options.captcha ?? proofOfWork(),
    breached: breachedCheck(options.breachedPasswords),
    email: options.email && {
      ...options.email,
      maxAge: tokenLifetimes(options.email.maxAge),
      links: emailLinks(options.email.links, paths?.links),
      requireVerified: options.email.requireVerified ?? true,
      get locales() {
        return languages!.locales()
      },
      get templates() {
        return languages!.templates()
      },
      codes: typeof options.email.codes === 'string' ? { 'magic-link': options.email.codes, 'verify-email': options.email.codes } : { 'magic-link': 'link', 'verify-email': 'link', ...options.email.codes },
    },
    oauthServer: oauthServerOf(options, pages),
    forward: forwardOf(options.forwardAuth, options.twoFactor !== false),
    get oauth() {
      return bind().oauth
    },
    get refreshers() {
      return bind().refreshers
    },
    allow: options.allow,
    signUp: options.signUp ?? true,
    defaultRoles: [...(options.defaultRoles ?? [])],
    roles: options.roles && new Set(Object.keys(options.roles)),
    hierarchy: options.roles,
    access: access as unknown as Access<string>,
    ...admin !== undefined && { admin: async user => access.authorize(user, admin, 'write', {}) },
    guard: guardOptions => guardOf(core, guardOptions),
    onSignUp: signUpHook(options.onSignUp),
    onProviderProfile: hooked(options.profileFields, (user, profile) => ({ user, profile })),
    userData: options.user && userDataRules(options.user),
    beforeDelete: deleteHook(options.beforeDelete),

    guestMaxAge: options.guests === undefined ? DEFAULT_GUEST_MAX_AGE : wholeSeconds(options.guests.maxAge, 'guests.maxAge'),
    unverifiedMaxAge: unverifiedMaxAge(options.email),
    deletion: deletionOf(options, pages),
    onExport: hooked(options.exportData, user => ({ user })),
    onEvent: options.onEvent,

    organizations: options.organizations && organizationsCore(options.organizations, access),
    pruned: { at: 0 },
    audit: options.audit == null || options.audit === false ? undefined : { maxAge: auditMaxAge(options.audit), prunedAt: 0, ip: options.audit === true ? 'truncated' : options.audit.ip ?? 'truncated' },
    rememberMaxAge: wholeSeconds(options.remember?.maxAge ?? `${DEFAULT_REMEMBER_MAX_AGE}s`, 'remember.maxAge'),
  }

  checkKeys(core, options)

  function refreshersFor(made: SiteBound): void {
    for (const [name, { client }] of made.oauth) {
      made.refreshers.set(name, createOAuthTokenRefresher({
        oauth: client,
        key: subject => `${name}:${subject.identity.providerId}`,
        load: subject => subject.credential,
        save: async (subject, tokens) => {
          // A refusal can be a race another process won, its rotated token saved since this one was read: that one stays.
          if (tokens === null && (await core.store.identities.find(name, subject.identity.providerId))?.refreshToken !== subject.identity.refreshToken)
            return

          const sealed = (await import('./oauth/flow')).sealTokens(core, name, subject.identity.providerId, tokens)

          // A refresh that rotates no refresh token leaves the one held usable.
          await core.store.identities.update(name, subject.identity.providerId, tokens && tokens.refreshToken === undefined ? { ...sealed, refreshToken: subject.identity.refreshToken } : sealed)
        },
        onError: error => log.error(`refreshing a ${name} token failed`, error),
      }))
    }
  }

  if (given !== undefined || configuredSite() !== undefined)
    bind()

  return core
}

function oauthServerOf(options: { oauthServer?: boolean | { fetch?: ((url: string) => Promise<Response>) | undefined, defaultScopes?: readonly string[] | undefined } | undefined, scopes?: readonly string[] | undefined, store: AuthStore }, pages: Core['pages']): Core['oauthServer'] {
  const wanted = options.oauthServer

  if (wanted === false || (wanted === undefined && !(pages && options.store.oauth)))
    return undefined

  if (!pages || !options.store.oauth)
    throw configError('auth', 'oauthServer', '`oauthServer` needs the prebuilt `pages`, for its consent page, and a store with `oauth`, as `memoryAuth` and `pgAuth` have')

  const custom = typeof wanted === 'object' ? wanted.fetch : undefined
  const defaultScopes = typeof wanted === 'object' ? [...new Set(wanted.defaultScopes)] : []

  if (defaultScopes.some(scope => !options.scopes?.includes(scope)))
    throw configError('auth', 'scopes', '`oauthServer.defaultScopes` names a scope that `scopes` does not declare')

  // Switched on by the app, not by the pages and the store alone, which every app with the prebuilt pages has.
  if (wanted !== undefined && (options.scopes?.length ?? 0) === 0)
    log.warn('oauthServer is on but authCore declares no `scopes`, so every OAuth token gets every scope: declare `scopes` and give routes a `scope:`')

  return { fetchDocument: async url => (await import('./authorize/clients')).documentFetcher(custom)(url), documents: kv('auth:oauth-documents'), defaultScopes }
}

// On by default in production, where `false` turns it off.
function breachedCheck(option: boolean | ((password: string) => boolean | Promise<boolean>) | undefined): ((password: string) => boolean | Promise<boolean>) | undefined {
  if (option === true || (option === undefined && process.env.NODE_ENV === 'production'))
    return pwnedPassword

  return typeof option === 'function' ? option : undefined
}

// The page each mailed link opens: the app's, else the prebuilt one.
function emailLinks(links: Partial<Record<LinkType, string>> | undefined, pages: Record<LinkType, string> | undefined): Record<LinkType, string> {
  const merged = Object.fromEntries(LINK_TYPES.map(type => [type, links?.[type] ?? pages?.[type]]))
  const missing = LINK_TYPES.filter(type => merged[type] === undefined)

  if (missing.length > 0)
    throw configError('auth', 'email', `email.links needs a page for ${missing.join(', ')}, or \`pages\` for the prebuilt ones`)

  return merged as Record<LinkType, string>
}
