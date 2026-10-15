import type { AnyElysia } from 'elysia'
import type { KayExtension } from 'kay/server'
import type { CaptchaWidget } from '../captcha'
import type { Core } from '../core'
import type { CodedLink, CodeMode } from '../email'
import type { LinkType } from '../store'

export interface AuthPagesOptions {
  // Where the pages are served, `/auth` by default, beside kayjs-auth's own routes: `/auth/sign-in`.
  prefix?: string | undefined
  // Where a sign-in goes when nothing asked for another page, and a sign-out always: `/` by default.
  home?: string | undefined
}

export interface AuthPages<Server extends AnyElysia = AnyElysia> extends KayExtension<Server> {
  prefix: string
  home: string
}

// What the config enables, for a page to show only what works.
export interface AuthFeatures {
  // The OAuth providers in the order configured, by the name their routes take, with what a button calls them.
  providers: { name: string, label: string }[]
  // Whether mail is set up: magic links, password resets, verification and email changes.
  email: boolean
  // What sign-in and verification mails carry, a link, a code or both; null without mail.
  codes: Record<CodedLink, CodeMode> | null
  // Whether visitors make their own accounts: registering, and signing in with a provider account no user has linked.
  signUp: boolean
  // Whether password sign-in waits for a verified address, the default with mail.
  requireVerified: boolean
  passkeys: boolean
  // The CAPTCHA widget to show where `captchaRequired` says one is needed, `'proof-of-work'` for kay's, whose field carries `captchaChallenge`, or null without one.
  captcha: CaptchaWidget | 'proof-of-work' | null
  // What a bearer token may be limited to; any token may do anything without them.
  scopes: string[]
  // Where kayjs-auth's own routes live: `${prefix}/github` starts a GitHub sign-in.
  prefix: string
  // Where a sign-in that failed goes, and where a guard sends an anonymous visitor once the prebuilt pages are on.
  signInPage: string
  // The prebuilt pages' prefix and home; null without them.
  pages: { prefix: string, home: string } | null
}

const DEFAULT_PREFIX = '/auth'

export function featuresOf(core: Core): AuthFeatures {
  return {
    providers: [...core.oauth].map(([name, { app }]) => ({ name, label: app.label ?? app.provider.label ?? name })),
    email: core.email !== undefined,
    codes: core.email?.codes ?? null,
    signUp: core.signUp,
    requireVerified: core.email?.requireVerified ?? false,
    passkeys: core.passkeys !== undefined,
    captcha: !core.captcha ? null : 'proofOfWork' in core.captcha ? 'proof-of-work' : core.captcha.widget ?? null,
    scopes: [...core.scopes],
    prefix: core.prefix,
    signInPage: core.signInPage,
    pages: core.pages ?? null,
  }
}

// The pages `authPages()` serves for `createAuth({ pages })` to send users to, each under the prefix.
export function pagePaths(prefix: string) {
  return {
    signIn: `${prefix}/sign-in`,
    twoFactor: `${prefix}/two-factor`,
    sessions: `${prefix}/account/sessions`,
    links: {
      'verify-email': `${prefix}/verify-email`,
      'reset-password': `${prefix}/reset-password`,
      'magic-link': `${prefix}/magic-link`,
      'change-email': `${prefix}/confirm-email`,
    } satisfies Record<LinkType, string>,
  }
}

// The sign-in, register, mailed-link and account pages, for `extensions` in kay.config.ts. Give `createAuth` the same `prefix` and `home` as `pages`, or `pages: true` for the defaults.
// `server` hands `pages()` the app's `auth.plugin`, so the app mounts nothing else and `kay check` types `ctx.locals.auth` and links to kayjs-auth's routes: a function importing it, called only when `pages()` builds the app, so kay.config.ts never loads the app's database.
export function authPages<Server extends AnyElysia = AnyElysia>(options: AuthPagesOptions & { server?: (() => Server | Promise<Server>) | undefined } = {}): AuthPages<Server> {
  return {
    name: '@kaynooo/kayjs-auth',
    server: options.server,
    routes: { dir: `${import.meta.dir}/routes`, prefix: options.prefix ?? DEFAULT_PREFIX },
    messages: `${import.meta.dir}/messages`,
    prefix: options.prefix ?? DEFAULT_PREFIX,
    home: options.home ?? '/',
  }
}

// The prefix and home `createAuth` reads off its `pages` option.
export function pagesOf(pages: boolean | AuthPagesOptions | undefined): { prefix: string, home: string } | undefined {
  if (pages == null || pages === false)
    return undefined

  return { prefix: (pages === true ? undefined : pages.prefix) ?? DEFAULT_PREFIX, home: (pages === true ? undefined : pages.home) ?? '/' }
}
