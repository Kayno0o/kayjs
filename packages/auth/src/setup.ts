import type { Duration } from 'kay'
import type { AuthOptions } from './auth'
import type { AuthSessionData, Core } from './core'
import type { EmailOptions } from './email'
import type { AuthPagesConfig, PagesHandle } from './pages'
import type { AuthStore, LinkType, TokenType } from './store'
import { asConfigError, configError, configuredSite, durationSeconds } from 'kay/library'
import { pwnedPassword } from './breached'
import { proofOfWork } from './captcha'
import { forwardOf } from './forwardAuth'
import { deriveKeys } from './keys'
import { resolveLimits } from './limits'
import { log } from './log'
import { localeTemplates } from './mail'
import { createOAuthClient } from './oauth/client'
import { createOAuthTokenRefresher } from './oauth/refresher'
import { organizationsCore } from './organizationsCore'
import { DEFAULT_PREFIX as DEFAULT_PAGES_PREFIX, pagePaths, pagesOf } from './pages'
import { resolveRules } from './rules'
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
    throw configError(`${named(unknown)} is no link or code of kayjs-auth`)

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

function auditMaxAge(audit: true | { maxAge?: Duration, ip?: 'full' | 'truncated' }): number {
  return audit === true || audit.maxAge === undefined ? DEFAULT_AUDIT_MAX_AGE : wholeSeconds(audit.maxAge, 'audit.maxAge')
}

// Lets `auth()` hand a `createAuth({ pages: true })` its prefix and home, the paths derived from the prefix following, whichever of the two ran first.
export function pagesHandle(core: Core, options: { pages?: boolean | AuthPagesConfig | undefined, signInPage?: string | undefined, twoFactorPage?: string | undefined, sessionsPage?: string | undefined, email?: { links?: Partial<Record<LinkType, string>> | undefined } | undefined }): PagesHandle {
  const own = typeof options.pages === 'object' ? options.pages : {}

  return {
    adopt(given) {
      const pages = core.pages

      if (!pages)
        return

      if (own.prefix !== undefined && own.prefix !== (given.prefix ?? DEFAULT_PAGES_PREFIX))
        throw configError(`auth() serves the pages under '${given.prefix ?? DEFAULT_PAGES_PREFIX}' and createAuth({ pages: { prefix: '${own.prefix}' } }) sends users to '${own.prefix}'. Give auth({ prefix: '${own.prefix}' }), or drop the prefix of one of them`)

      if (own.home === undefined && given.home !== undefined)
        pages.home = given.home
      else if (own.home !== undefined && given.home !== undefined && own.home !== given.home)
        log.warn(`auth({ home: '${given.home}' }) and createAuth({ pages: { home: '${own.home}' } }) differ, and createAuth's wins: users go to '${own.home}'. Give home once, or the same in both`)

      if (own.prefix !== undefined || given.prefix === undefined || given.prefix === pages.prefix)
        return

      const paths = pagePaths(given.prefix)

      pages.prefix = given.prefix
      core.signInPage = options.signInPage ?? paths.signIn
      core.twoFactorPage = options.twoFactorPage ?? paths.twoFactor
      core.sessionsPage = options.sessionsPage ?? paths.sessions
      core.securityPage = paths.security

      if (core.email)
        core.email.links = emailLinks(options.email?.links, paths.links)
    },
  }
}

const HAS_SCHEME = /^[a-z][\d+.a-z-]*:\/\//i
const HOST_LIKE = /^(?:[\w-]+(?:\.[\w-]+)+(?::\d+)?|[\w.-]+:\d+)$/

// The origin and the display name the options give: `site` is the origin, which has a scheme.
function siteOptions(options: { site?: string | undefined, name?: string | undefined }): { origin: string | undefined, name: string | undefined } {
  const site = options.site

  if (site !== undefined && !HAS_SCHEME.test(site))
    throw configError(HOST_LIKE.test(site) ? `\`site\` is the site's origin, such as \`https://${site}\`, and \`${site}\` has no scheme: add it, or give the display name as \`name\`` : `\`site\` is the site's origin, such as \`https://example.com\`, and \`${site}\` is not one: give the display name as \`name\``)

  return { origin: site, name: options.name }
}

function noSecret(): never {
  throw configError('`secret` is missing and the session plugin cannot derive one; pass a secret of at least 32 characters, or a plugin from kay\'s `session()`')
}

// What createCore builds on the site's origin, once it has one.
interface SiteBound {
  url: string | undefined
  oauth: Core['oauth']
  refreshers: Core['refreshers']
  name: string
  passkeys: Core['passkeys']
}

export function createCore<Data extends AuthSessionData, Role extends string, Prefix extends string, Scope extends string, OrgRole extends string, UserData extends object>(options: AuthOptions<Data, Role, Prefix, Scope, OrgRole, UserData>): Core {
  const prefix = options.prefix ?? '/auth'

  const oauthApps = Object.entries(options.oauth ?? {})
  const { origin, name } = siteOptions(options)
  const given = origin?.replace(TRAILING_SLASH, '')
  const locales = options.email?.locales !== undefined && options.email.locales.length > 0 ? [...options.email.locales] : ['en']
  const pages = pagesOf(options.pages)
  const passkeyOptions = options.passkeys === false ? undefined : options.passkeys
  const paths = pages && pagePaths(pages.prefix)

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
      throw configError('OAuth sign-in and mailed links need the site\'s public origin to build their URLs: set `site` in kay.config.ts or SITE_URL, or in createAuth')

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

  const core: Core = {
    store: options.store,
    keys: deriveKeys(options.secret ?? options.sessions.deriveSecret?.('kayjs-auth') ?? noSecret()),
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
    securityPage: paths?.security,
    locate: options.locate,
    scopes: new Set(options.scopes),
    get passkeys() {
      return bind().passkeys
    },
    switches: { password: options.password !== false, passkeys: options.passkeys !== false, magicLink: options.magicLink !== false, twoFactor: options.twoFactor !== false },
    captcha: options.captcha === false ? undefined : options.captcha ?? proofOfWork(),
    breached: breachedCheck(options.breachedPasswords),
    email: options.email && {
      ...options.email,
      maxAge: tokenLifetimes(options.email.maxAge),
      links: emailLinks(options.email.links, paths?.links),
      requireVerified: options.email.requireVerified ?? true,
      locales,
      templates: localeTemplates(locales, options.email.templates, options.email.translations),
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
    onSignUp: hooked(options.onSignUp, (user, profile) => ({ user, profile })),
    onProviderProfile: hooked(options.profileFields, (user, profile) => ({ user, profile })),
    userData: options.user && userDataRules(options.user),
    onDelete: hooked(options.onDelete, user => ({ user })),
    guestMaxAge: options.guests === undefined ? DEFAULT_GUEST_MAX_AGE : wholeSeconds(options.guests.maxAge, 'guests.maxAge'),
    unverifiedMaxAge: unverifiedMaxAge(options.email),
    onExport: hooked(options.exportData, user => ({ user })),
    onAuthEvent: options.onAuthEvent,
    organizations: options.organizations && organizationsCore(options.organizations),
    pruned: { at: 0, running: Promise.resolve() },
    audit: options.audit == null || options.audit === false ? undefined : { maxAge: auditMaxAge(options.audit), prunedAt: 0, ip: options.audit === true ? 'truncated' : options.audit.ip ?? 'truncated' },
    rememberMaxAge: wholeSeconds(options.remember?.maxAge ?? `${DEFAULT_REMEMBER_MAX_AGE}s`, 'remember.maxAge'),
  }

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
    throw configError('`oauthServer` needs the prebuilt `pages`, for its consent page, and a store with `oauth`, as `memoryAuthStore` and `pgStore` have')

  const custom = typeof wanted === 'object' ? wanted.fetch : undefined
  const defaultScopes = typeof wanted === 'object' ? [...new Set(wanted.defaultScopes)] : []

  if (defaultScopes.some(scope => !options.scopes?.includes(scope)))
    throw configError('`oauthServer.defaultScopes` names a scope that `scopes` does not declare')

  // Switched on by the app, not by the pages and the store alone, which every app with the prebuilt pages has.
  if (wanted !== undefined && (options.scopes?.length ?? 0) === 0)
    log.warn('oauthServer is on but createAuth declares no `scopes`, so every OAuth token gets every scope: declare `scopes` and give routes a `scope:`')

  return { fetchDocument: async url => (await import('./authorize/clients')).documentFetcher(custom)(url), documents: new Map(), defaultScopes }
}

function breachedCheck(option: boolean | ((password: string) => boolean | Promise<boolean>) | undefined): ((password: string) => boolean | Promise<boolean>) | undefined {
  if (option === true)
    return pwnedPassword

  return typeof option === 'function' ? option : undefined
}

// The page each mailed link opens: the app's, else the prebuilt one.
function emailLinks(links: Partial<Record<LinkType, string>> | undefined, pages: Record<LinkType, string> | undefined): Record<LinkType, string> {
  const merged = Object.fromEntries(LINK_TYPES.map(type => [type, links?.[type] ?? pages?.[type]]))
  const missing = LINK_TYPES.filter(type => merged[type] === undefined)

  if (missing.length > 0)
    throw configError(`email.links needs a page for ${missing.join(', ')}, or \`pages\` for the prebuilt ones`)

  return merged as Record<LinkType, string>
}
