import type { AnyElysia } from 'elysia'
import type { KayExtension } from 'kay/server'
import type { CaptchaWidget } from '../captcha'
import type { BareUser, Core } from '../core'
import type { CodedLink, CodeMode } from '../email'
import type { CreateUserInput, CreateUserResult } from '../password'
import type { LinkType } from '../store'
import { resolve } from 'node:path'
import { configError } from 'kay/library'
import { pickLocale } from '../locale'

export interface AuthPagesOptions {
  // Where the pages are served, `/auth` by default, beside kayjs-auth's own routes: `/auth/sign-in`. `createAuth` reads it when `auth()` loads it with `module`.
  prefix?: string | undefined
  // Where a sign-in goes when nothing asked for another page, and a sign-out always: `/` by default.
  home?: string | undefined
}

export type RememberMode = 'checkbox' | 'always' | 'never'

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
  load: (user: BareUser) => Partial<Record<Field, string | null | undefined>> | Promise<Partial<Record<Field, string | null | undefined>>>
  // Stores values already trimmed and checked against `required` and `maxLength`; returns `{ errors }` naming what it refused, by field.
  save: (user: BareUser, values: Record<Field, string>) => void | { errors: Partial<Record<Field, string>> } | Promise<void | { errors: Partial<Record<Field, string>> }>
}

// What `createAuth`'s `pages` option takes: `auth()`'s own options and the profile data of the app.
export interface AuthPagesConfig extends AuthPagesOptions {
  // The "keep me signed in" choice of the sign-in and register pages: `'checkbox'` shows a box that decides (unchecked is the same short session by every way of signing in, OAuth and passkeys included), `'always'` hides it and keeps every sign-in `remember.maxAge`, `'never'` hides it and ends every session with the browser. `'checkbox'` by default.
  remember?: RememberMode | undefined
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
  // Whether MCP clients sign in to this app through its own OAuth server, which the account page then lists the approved ones of.
  oauthServer: boolean
  // Where a sign-in that failed goes, and where a guard sends an anonymous visitor once the prebuilt pages are on.
  signInPage: string
  // The prebuilt pages' prefix and home; null without them.
  pages: { prefix: string, home: string, remember: RememberMode } | null
  // The password and username limits, for a page or an island to show and check with: `passwordProblem(value, features.rules)`. The password rule's `check` stays on the server and in the app's own `rules`.
  rules: { password: { min: number, max: number }, username: { min: number, max: number } }
}

export const DEFAULT_PREFIX = '/auth'

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
    oauthServer: core.oauthServer !== undefined,
    signInPage: core.signInPage,
    rules: { password: { min: core.rules.password.min, max: core.rules.password.max }, username: { ...core.rules.username } },
    pages: core.pages ? { prefix: core.pages.prefix, home: core.pages.home, remember: core.pages.remember } : null,
  }
}

// The pages `auth()` serves for `createAuth({ pages })` to send users to, each under the prefix.
export function pagePaths(prefix: string) {
  return {
    signIn: `${prefix}/sign-in`,
    twoFactor: `${prefix}/two-factor`,
    sessions: `${prefix}/account/sessions`,
    security: `${prefix}/account/security`,
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

// What `createAuth` hands `auth()` to settle the prefix and home between them, whichever of the two was made first.
export const PAGES_OF = Symbol('kayjs-auth.pages')

export interface PagesHandle {
  // Takes the prefix and home `auth()` was given where `createAuth({ pages })` set none of its own, and throws when both name another prefix.
  adopt: (given: { prefix?: string | undefined, home?: string | undefined }) => void
}

// Set on the plugin of a `createAuth` result, so what has the plugin alone finds the `auth` it came from.
export const AUTH_OF = Symbol('kayjs-auth.auth')

// Set on the extensions kayjs-auth gives, answering the app's `auth` for the commands, given the project root.
export const LOAD_AUTH = Symbol('kayjs-auth.load')

// Set on the `createAuth` result, answering what `createUser` would refuse a login for.
export const CHECK_USER = Symbol('kayjs-auth.checkUser')

// What `kay auth create-user` needs of the app's `auth`.
export interface UserMaker {
  // What `createUser` would refuse the login for, asked before the password is.
  [CHECK_USER]: (input: Omit<CreateUserInput, 'roles'> & { roles?: string[] | undefined }) => Promise<Partial<Record<'email' | 'username' | 'password', string>>>
  createUser: (input: Omit<CreateUserInput, 'roles'> & { roles?: string[] | undefined }) => Promise<CreateUserResult>
}

// The commands both extensions add.
const COMMANDS = { 'auth create-user': `${import.meta.dir}/../createUserCommand.ts` }

// The `auth` of a module: the `createAuth` result as its `auth` export or its default one.
function authOfModule(module: Partial<Record<'auth' | 'default', { plugin: AnyElysia, [PAGES_OF]?: PagesHandle | undefined }>>) {
  const auth = module.auth ?? module.default

  if (!auth)
    throw configError('the auth module exports no `auth`, the `createAuth` result')

  return auth
}

// The `auth` behind a plugin handed as `server`.
async function authOfServer(server: (() => AnyElysia | Promise<AnyElysia>) | undefined): Promise<UserMaker> {
  const plugin = await server?.() as { [AUTH_OF]?: UserMaker } | undefined
  const auth = plugin?.[AUTH_OF]

  if (!auth)
    throw configError('the `server` of auth() is not the `plugin` of a `createAuth` result, so its commands cannot reach the app\'s auth; give `module: \'./src/auth\'` instead')

  return auth
}

async function pluginIn<Module extends AuthModule>(load: () => Promise<Module>, given?: { prefix?: string | undefined, home?: string | undefined }): Promise<PluginOf<Module>> {
  const auth = authOfModule(await load())

  if (given)
    auth[PAGES_OF]?.adopt(given)

  return auth.plugin as PluginOf<Module>
}

/** @deprecated Use `auth({ module, pages: false })`, which `kay check --fix` rewrites it to. */
// kayjs-auth for `extensions` in kay.config.ts, as the whole declaration: `authExtension(() => import('./src/auth'))` for the module making `auth` with `createAuth`, exported as `auth` or by default. The module loads as the server starts, never as the config is read, so the config stays off the app's database, and `kay check` types `ctx.locals.auth` and links to kayjs-auth's routes off it.
export function authExtension<Module extends AuthModule>(load: () => Promise<Module>): KayExtension<PluginOf<Module>> {
  const extension: KayExtension<PluginOf<Module>> = { name: 'auth', server: async () => pluginIn(load), devTool: DEV_TOOL, commands: COMMANDS }

  return Object.assign(extension, { [LOAD_AUTH]: async () => authOfModule(await load()) as unknown as UserMaker })
}

/** @deprecated Use `auth({ module })`, which `kay check --fix` rewrites it to. */
// The sign-in, register, mailed-link and account pages, for `extensions` in kay.config.ts. With `auth`, `createAuth({ pages: true })` takes this `prefix` and `home`; one given in both places must match for the prefix.
// `auth` loads the app's `auth` as `authExtension` does, so the app mounts nothing else and `kay check` types `ctx.locals.auth` and links to kayjs-auth's routes; `server` hands `pages()` any other plugin carrying it.
export function authPages<Module extends AuthModule>(options: AuthPagesOptions & { auth: () => Promise<Module> }): AuthPages<PluginOf<Module>>
export function authPages<Server extends AnyElysia = AnyElysia>(options?: AuthPagesOptions & { server?: (() => Server | Promise<Server>) | undefined }): AuthPages<Server>
export function authPages(options: AuthPagesOptions & { auth?: (() => Promise<AuthModule>) | undefined, server?: (() => AnyElysia | Promise<AnyElysia>) | undefined } = {}): AuthPages {
  const extension: AuthPages = {
    name: '@kaynooo/kayjs-auth',
    server: options.auth ? async () => pluginIn(options.auth!, { prefix: options.prefix, home: options.home }) : options.server,
    routes: { dir: `${import.meta.dir}/routes`, prefix: options.prefix ?? DEFAULT_PREFIX },
    devTool: DEV_TOOL,
    commands: COMMANDS,
    prefix: options.prefix ?? DEFAULT_PREFIX,
    home: options.home ?? '/',
  }

  return Object.assign(extension, { [LOAD_AUTH]: options.auth ? async () => authOfModule(await options.auth!()) as unknown as UserMaker : async () => authOfServer(options.server) })
}

export interface AuthExtensionOptions extends AuthPagesOptions {
  // The file exporting the app's `auth`, the `createAuth` result, as a path from the project root: `'./src/auth'`. kay imports it as the server starts, never as the config is read, so the config stays off the app's database, and `kay check` types `ctx.locals.auth` and links to kayjs-auth's routes off it.
  module?: string | undefined
  // Any other plugin carrying a `createAuth` result, as a function, in place of `module`.
  server?: (() => AnyElysia | Promise<AnyElysia>) | undefined
  // `false` leaves out the prebuilt pages and serves the plugin alone, for an app writing every page itself. `true` by default.
  pages?: boolean | undefined
}

// The `auth` an app's module exports, for `prepare` to hand it the prefix and home `auth()` was given.
function authOfExport(exported: unknown, module: string): { [PAGES_OF]?: PagesHandle | undefined } {
  if (typeof exported !== 'object' || exported === null || !('plugin' in exported))
    throw new Error(`kayjs-auth: ${module} exports no \`auth\`: export the \`createAuth\` result as \`export const auth = createAuth(...)\``)

  return exported as { [PAGES_OF]?: PagesHandle | undefined }
}

// kayjs-auth for `extensions` in kay.config.ts, as the whole declaration: `auth({ module: './src/auth' })`, the module exporting the `auth` made with `createAuth`. Its plugin is used before the pages, so the app mounts nothing else and declares no `Register`, and `prefix` and `home` reach `createAuth({ pages: true })`; the prebuilt pages come with it unless `pages: false`.
export function auth(options: AuthExtensionOptions = {}): AuthPages {
  const { module, server, pages = true, prefix = DEFAULT_PREFIX, home } = options

  if (module !== undefined && server !== undefined)
    throw new Error('kayjs-auth: auth() takes `module` or `server`, not both')

  const given = { prefix: options.prefix, home }
  const extension: AuthPages = {
    name: '@kaynooo/kayjs-auth',
    ...module !== undefined && { serverModule: { path: module, export: 'auth', prepare: (exported: unknown) => pages ? authOfExport(exported, module)[PAGES_OF]?.adopt(given) : undefined } },
    ...module === undefined && server !== undefined && { server },
    ...pages && { routes: { dir: `${import.meta.dir}/routes`, prefix } },
    devTool: DEV_TOOL,
    commands: COMMANDS,
    prefix,
    home: home ?? '/',
  }

  const load = async (root: string): Promise<UserMaker> => module === undefined ? authOfServer(server) : authOfModule({ auth: ((await import(resolve(root, module))) as { auth: { plugin: AnyElysia } }).auth }) as unknown as UserMaker

  return Object.assign(extension, { [LOAD_AUTH]: load })
}

// The prefix and home `createAuth` reads off its `pages` option.
export function pagesOf(pages: boolean | AuthPagesConfig | undefined): { prefix: string, home: string, remember: RememberMode, profile?: ProfileOptions } | undefined {
  if (pages == null || pages === false)
    return undefined

  const options = pages === true ? {} : pages

  return { prefix: options.prefix ?? DEFAULT_PREFIX, home: options.home ?? '/', remember: options.remember ?? 'checkbox', ...options.profile && { profile: options.profile } }
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
