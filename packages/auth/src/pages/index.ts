import type { AnyElysia } from 'elysia'
import type { KayExtension } from 'kay/server'
import type { CaptchaWidget } from '../captcha'
import type { Core, User } from '../core'
import type { CodedLink, CodeMode } from '../email'
import type { LinkType } from '../store'
import { pickLocale } from '../locale'

export interface AuthPagesOptions {
  // Where the pages are served, `/auth` by default, beside kayjs-auth's own routes: `/auth/sign-in`.
  prefix?: string | undefined
  // Where a sign-in goes when nothing asked for another page, and a sign-out always: `/` by default.
  home?: string | undefined
}

// One input of the profile form the account page shows beside the username.
export interface ProfileField {
  // A string, or the label in each locale of the site by tag (`{ en: 'Bio', fr: 'Biographie' }`): the page shows the one matching its locale, else the first.
  label: string | Record<string, string>
  // An `input` of this type, or a `textarea`; `text` by default.
  type?: 'text' | 'textarea' | 'tel' | 'url' | 'email' | undefined
  autocomplete?: string | undefined
  required?: boolean | undefined
  // The longest value, 500 characters by default.
  maxLength?: number | undefined
}

// A field of the profile form with what the user holds in it.
export interface ProfileFieldView extends Omit<ProfileField, 'label'> {
  name: string
  // The label in the locale asked for.
  label: string
  // The limit in force, 500 characters when the field gave none.
  maxLength: number
  value: string
}

// Why a field was refused: left empty, too long, or in the words of the app's `save`.
export type ProfileProblem = 'required' | 'too-long' | { message: string }

// The profile data an app keeps beside kayjs-auth's users, edited on the account page's profile form.
export interface ProfileOptions<Field extends string = string> {
  fields: Record<Field, ProfileField>
  // What each field holds now for this user, read when the form renders.
  load: (user: User) => Partial<Record<Field, string | null | undefined>> | Promise<Partial<Record<Field, string | null | undefined>>>
  // Stores values already trimmed and checked against `required` and `maxLength`; returns `{ errors }` naming what it refused, by field.
  save: (user: User, values: Record<Field, string>) => void | { errors: Partial<Record<Field, string>> } | Promise<void | { errors: Partial<Record<Field, string>> }>
}

// What `createAuth`'s `pages` option takes: `authPages`' own options and the profile data of the app.
export interface AuthPagesConfig extends AuthPagesOptions {
  // Extra fields on the account page's profile form, with where they are read and stored.
  profile?: ProfileOptions | undefined
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

// The dev tool's Auth tab, which kay loads on dev pages.
const DEV_TOOL = { module: `${import.meta.dir}/../devTool.ts` }

function captchaFeature(captcha: Core['captcha']): AuthFeatures['captcha'] {
  if (!captcha)
    return null

  return 'proofOfWork' in captcha ? 'proof-of-work' : captcha.widget ?? null
}

export function featuresOf(core: Core): AuthFeatures {
  return {
    providers: [...core.oauth].map(([name, { app }]) => ({ name, label: app.label ?? app.provider.label ?? name })),
    email: core.email !== undefined,
    codes: core.email?.codes ?? null,
    signUp: core.signUp,
    requireVerified: core.email?.requireVerified ?? false,
    passkeys: core.passkeys !== undefined,
    captcha: captchaFeature(core.captcha),
    scopes: [...core.scopes],
    prefix: core.prefix,
    signInPage: core.signInPage,
    pages: core.pages ? { prefix: core.pages.prefix, home: core.pages.home } : null,
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

// The module `src/auth.ts` is: the `createAuth` result as its `auth` export or its default one.
export type AuthModule = { auth: { plugin: AnyElysia } } | { default: { plugin: AnyElysia } }

// The plugin of an `AuthModule`, for `kay check` to type `ctx.locals.auth` off.
export type PluginOf<Module> = Module extends { auth: { plugin: infer Plugin extends AnyElysia } } ? Plugin : Module extends { default: { plugin: infer Plugin extends AnyElysia } } ? Plugin : never

async function pluginIn<Module extends AuthModule>(load: () => Promise<Module>): Promise<PluginOf<Module>> {
  const module: Partial<Record<'auth' | 'default', { plugin: AnyElysia }>> = await load()
  const auth = module.auth ?? module.default

  if (!auth)
    throw new Error('kayjs-auth: the module `authPages` or `authExtension` loads exports no `auth`, nor a default `createAuth` result')

  return auth.plugin as PluginOf<Module>
}

// kayjs-auth for `extensions` in kay.config.ts, as the whole declaration: `authExtension(() => import('./src/auth'))` for the module making `auth` with `createAuth`, exported as `auth` or by default. The module loads as the server starts, never as the config is read, so the config stays off the app's database, and `kay check` types `ctx.locals.auth` and links to kayjs-auth's routes off it.
export function authExtension<Module extends AuthModule>(load: () => Promise<Module>): KayExtension<PluginOf<Module>> {
  return { name: 'auth', server: async () => pluginIn(load), devTool: DEV_TOOL }
}

// The sign-in, register, mailed-link and account pages, for `extensions` in kay.config.ts. Give `createAuth` the same `prefix` and `home` as `pages`, or `pages: true` for the defaults.
// `auth` loads the app's `auth` as `authExtension` does, so the app mounts nothing else and `kay check` types `ctx.locals.auth` and links to kayjs-auth's routes; `server` hands `pages()` any other plugin carrying it.
export function authPages<Module extends AuthModule>(options: AuthPagesOptions & { auth: () => Promise<Module> }): AuthPages<PluginOf<Module>>
export function authPages<Server extends AnyElysia = AnyElysia>(options?: AuthPagesOptions & { server?: (() => Server | Promise<Server>) | undefined }): AuthPages<Server>
export function authPages(options: AuthPagesOptions & { auth?: (() => Promise<AuthModule>) | undefined, server?: (() => AnyElysia | Promise<AnyElysia>) | undefined } = {}): AuthPages {
  return {
    name: '@kaynooo/kayjs-auth',
    server: options.auth ? async () => pluginIn(options.auth!) : options.server,
    routes: { dir: `${import.meta.dir}/routes`, prefix: options.prefix ?? DEFAULT_PREFIX },
    devTool: DEV_TOOL,
    messages: `${import.meta.dir}/messages`,
    prefix: options.prefix ?? DEFAULT_PREFIX,
    home: options.home ?? '/',
  }
}

// The prefix and home `createAuth` reads off its `pages` option.
export function pagesOf(pages: boolean | AuthPagesConfig | undefined): { prefix: string, home: string, profile?: ProfileOptions } | undefined {
  if (pages == null || pages === false)
    return undefined

  const options = pages === true ? {} : pages

  return { prefix: options.prefix ?? DEFAULT_PREFIX, home: options.home ?? '/', ...options.profile && { profile: options.profile } }
}

// The label of a profile field in `locale`: a plain string as it is, a map by locale tag the entry matching `locale` exactly or by language, else the first.
export function profileLabel(label: ProfileField['label'], locale: string | undefined): string {
  if (typeof label === 'string')
    return label

  const tags = Object.keys(label)

  return tags.length === 0 ? '' : label[pickLocale(tags, [locale])] ?? ''
}

// What `load` answered for a field as the text the form shows: nothing is empty, and anything else than a string is the app's mistake, told rather than shown as empty.
export function profileValue(name: string, held: unknown): string {
  if (held === undefined || held === null)
    return ''

  if (typeof held !== 'string')
    throw new TypeError(`kayjs-auth: pages.profile.load answered a ${typeof held} for the field "${name}", which takes a string, null or undefined`)

  return held
}
