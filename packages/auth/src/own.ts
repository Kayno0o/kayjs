import type { AnyElysia } from 'elysia'
import type { ExtensionApp } from 'kay/server'
import type { AuthOptions, authCore as CreateAuth } from './auth'
import type { AuthSessionData, OAuthApp } from './core'
import type { EmailOptions } from './email'
import type { AuthMailer } from './mail'
import type { ProviderOptions } from './oauth/providers'
import type { AuthPagesConfig, AuthPagesOptions, UserMaker } from './pages'
import type { AuthStore } from './store'
import type { OwnTest } from './test'
import { existsSync } from 'node:fs'
import { normalize, resolve } from 'node:path'
import process from 'node:process'
import { s } from 'kay'
import { appStore, configError } from 'kay/library'
import { session } from 'kay/server'
import { log } from './log'
import { memoryAuth } from './memoryStore'
import { discordProvider, githubProvider, gitlabProvider, googleProvider, microsoftProvider } from './oauth/providers'

/** What a provider preset takes beside its credentials, which the environment supplies when they are left out. */
export interface PresetApp extends ProviderOptions {
  // Read from `<NAME>_CLIENT_ID` (`GITHUB_CLIENT_ID`) when left out.
  clientId?: string | undefined
  // Read from `<NAME>_CLIENT_SECRET` when left out.
  clientSecret?: string | undefined
  label?: string | undefined
  keepTokens?: boolean | undefined
}

// The providers `oauth: { github: true }` names, each over its preset.
const PRESETS = {
  github: githubProvider,
  discord: discordProvider,
  google: googleProvider,
  microsoft: microsoftProvider,
  gitlab: gitlabProvider,
} as unknown as Record<string, (options: ProviderOptions) => OAuthApp['provider']>

/** The hooks an app keeps in `src/auth.ts` as `export const hooks`, or hands to `auth({ hooks })`. */
export type AuthHooks = Partial<Pick<AuthOptions<AuthSessionData, string>, 'allow' | 'authorize' | 'exportData' | 'locate' | 'onAuthEvent' | 'onDelete' | 'onSignUp' | 'profileFields'>>

/** Where kayjs-auth keeps its data when `store` is left out: a pg-orm database at `url`, the database of the app's `store` in kay.config.ts when it names one, else a SQLite file `data/auth.sqlite` (`data/auth.db` where an app already has it). */
export interface StoreUrl {
  url: string
}

type StoreOption = AuthStore | StoreUrl | (() => AuthStore | Promise<AuthStore>)

type Inherited = 'sessions' | 'store' | 'oauth' | 'pages' | 'prefix' | 'email'

/** The options of `auth()` with no module: `authCore`'s own, with the session, the store, the mailer and the OAuth credentials found by convention. */
export interface OwnOptions<Role extends string = string, Prefix extends string = '/auth', Scope extends string = never, OrgRole extends string = never, UserData extends object = Record<string, never>> extends Omit<AuthOptions<AuthSessionData, Role, Prefix, Scope, OrgRole, UserData>, Inherited>, AuthPagesOptions {
  module?: undefined
  server?: undefined
  plugin?: undefined
  // Where the OAuth and page routes live, `/auth` by default.
  prefix?: Prefix | undefined
  // The prebuilt pages are served by default; `false` leaves them out, an object tunes them (`remember`, `profile`). `true` works until 1.93, leave it out.
  pages?: boolean | Pick<AuthPagesConfig, 'profile' | 'remember' | 'main'> | undefined
  // The session cookie's name, `kay_session` by default; kay names it `__Host-` first over https unless `forwardAuth` shares it under a domain.
  cookie?: string | undefined
  // Providers by the name their routes take: `{ github: true }` reads `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` (a preset: github, discord, google, microsoft or gitlab), an object adds options to a preset, and a full `OAuthApp` is an app of any provider.
  oauth?: Record<string, true | PresetApp | OAuthApp> | undefined
  // The users' data: a pg-orm database at `{ url }`, the store itself, or a function building it. `AUTH_DATABASE_URL` when set, else the database of the app's `store` (`sqliteData(path)`, `pgData(url)`), else `data/auth.sqlite` (SQLite; `data/auth.db` where it exists).
  store?: StoreOption | undefined
  // Mail for verification, resets and magic links. Left out, `src/mail.ts` exporting kayjs-mail's `mail` sends them; `false` sends none.
  email?: EmailOptions | false | undefined
  // The hooks as a module the app loads, `() => import('./src/auth')`, in place of `src/auth.ts` exporting `hooks`, which kay reads by convention, bakes into an executable and reloads under `kay dev`.
  hooks?: (() => Promise<{ hooks: AuthHooks }>) | undefined
  // As with a module: templates read `ctx.user` and `ctx.can(role)` with no option, and `true` also reads the user ahead of every page.
  viewer?: boolean | undefined
}

export type OwnPlugin<Role extends string, Prefix extends string, Scope extends string, OrgRole extends string, UserData extends object> = ReturnType<typeof CreateAuth<AuthSessionData, Role, Prefix, Scope, OrgRole, UserData>>['plugin']

// The name kayjs-mail's `mail()` extension lists itself by.
export const MAIL_EXTENSION = '@kaynooo/kayjs-mail'
// A relative SQLite path: `sqlite://data/auth.sqlite`, not `sqlite:///srv/auth.db` or `sqlite://:memory:`.
const SQLITE_FILE = /^sqlite:(?:\/\/)?(?![/:])([^?]+)$/

function isPreset(app: true | PresetApp | OAuthApp): app is true | PresetApp {
  return app === true || !('provider' in app)
}

/** The environment variables an `auth()` with no module reads, for `kay env` to list: the database url and the credentials of the providers asked by name. */
export function ownEnv(options: Pick<OwnOptions, 'oauth' | 'store'>) {
  const names = Object.entries(options.oauth ?? {}).filter(([, app]) => isPreset(app) && (app === true || app.clientId === undefined || app.clientSecret === undefined)).map(([name]) => name)

  return s.Object({
    ...options.store === undefined && { AUTH_DATABASE_URL: s.Optional(s.String({ description: 'the database kayjs-auth keeps its users in, a Postgres or SQLite url; the one of the app\'s store, else data/auth.sqlite (SQLite; data/auth.db where it exists), when unset' })) },
    ...Object.fromEntries(names.flatMap(name => [
      [`${name.toUpperCase()}_CLIENT_ID`, s.String({ description: `the ${name} OAuth app's client id`, requiredInProduction: true })],
      [`${name.toUpperCase()}_CLIENT_SECRET`, s.String({ description: `the ${name} OAuth app's client secret`, requiredInProduction: true })],
    ])),
  })
}

function appOf(name: string, given: true | PresetApp | OAuthApp): OAuthApp {
  if (!isPreset(given))
    return given

  const preset = PRESETS[name]

  if (!preset)
    throw configError('auth', 'oauth', `oauth.${name} is \`true\` or has no \`provider\`, and only ${Object.keys(PRESETS).join(', ')} are presets: give \`{ provider, clientId, clientSecret }\``)

  const { clientId, clientSecret, label, keepTokens, ...options } = given === true ? {} as PresetApp : given
  const key = name.toUpperCase()
  const id = clientId ?? process.env[`${key}_CLIENT_ID`]
  const secret = clientSecret ?? process.env[`${key}_CLIENT_SECRET`]

  if (id === undefined || id === '' || secret === undefined || secret === '')
    throw configError('auth', 'oauth', `oauth.${name} needs ${key}_CLIENT_ID and ${key}_CLIENT_SECRET in the environment, or \`clientId\` and \`clientSecret\``)

  return { provider: preset(options), clientId: id, clientSecret: secret, ...label !== undefined && { label }, ...keepTokens !== undefined && { keepTokens } }
}

function filled(value: string | undefined): string | undefined {
  return value === '' ? undefined : value
}

function isStore(store: AuthStore | StoreUrl): store is AuthStore {
  return 'users' in store
}

// A SQLite file named by a relative path is kept under the project root, wherever the process runs.
function underRoot(url: string, root: string): string {
  const file = SQLITE_FILE.exec(url)?.[1]

  return file === undefined ? url : `sqlite://${resolve(root, file)}`
}

const ABSOLUTE_SQLITE = /^sqlite:\/\/(\/.*)$/

// The same database written two ways (a relative path, or an absolute one) is the same url once resolved under the root.
function sameDatabase(a: string, b: string, root: string): boolean {
  const resolved = (url: string) => underRoot(url, root).replace(ABSOLUTE_SQLITE, (_, file: string) => `sqlite://${normalize(file)}`)

  return resolved(a) === resolved(b)
}

// Every table of the database that is not kayjs-auth's own, which sharing the app's database must leave alone: pg-orm's sync would drop them.
function foreignTables(names: readonly string[]): RegExp {
  return new RegExp(`^(?!(?:${names.join('|')})$)`)
}

const OWN_FILE = 'data/auth.sqlite'
// What the file was called before 1.88 gave every default data file the `.sqlite` extension: an app whose users are in it keeps it.
const LEGACY_OWN_FILE = 'data/auth.db'
const warned = new Set<string>()
let warnedOldDatabaseName = false

// The database url: `AUTH_DATABASE_URL`, else the name before 1.91, `KAYJS_AUTH_DATABASE_URL`, which warns once.
function databaseUrlFromEnv(): string | undefined {
  const given = filled(process.env.AUTH_DATABASE_URL)

  if (given !== undefined)
    return given

  const old = filled(process.env.KAYJS_AUTH_DATABASE_URL)

  if (old !== undefined && !warnedOldDatabaseName) {
    warnedOldDatabaseName = true
    log.warn('KAYJS_AUTH_DATABASE_URL is now AUTH_DATABASE_URL: rename it in your .env or compose service, the old name is read until 1.94')
  }

  return old
}

async function storeOf(store: StoreOption | undefined, root: string, shared: string | undefined, exporting: boolean | undefined): Promise<AuthStore> {
  if (typeof store === 'function')
    return store()

  if (store !== undefined && isStore(store))
    return store

  // An empty value, as .env.example lists it, is not a url.
  const given = store?.url ?? databaseUrlFromEnv()

  // Tests start from no users each run, as a file kept between them would not, and a static export reads none and creates or migrates no table.
  if (exporting || (given === undefined && process.env.NODE_ENV === 'test'))
    return memoryAuth()

  // The database of the app's own `store` when it names one, so `sqliteData` or `pgData(url)` in kay.config.ts is the only place to say where the data lives.
  // An app whose users are already in `data/auth.db` keeps them there, so an upgrade loses no one.
  const file = existsSync(resolve(root, LEGACY_OWN_FILE)) ? LEGACY_OWN_FILE : OWN_FILE
  const kept = given === undefined && shared !== undefined && existsSync(resolve(root, file))
  const url = kept ? undefined : given ?? shared

  if (kept && !warned.has(root)) {
    warned.add(root)
    log.warn(`auth() keeps its users in ${file}, which exists, though the app's store names a database: to use that database, move the users into it and set AUTH_DATABASE_URL to its url (or delete the file when it holds none)`)
  }

  let orm: typeof import('@kaynooo/pg-orm')
  let pg: typeof import('./pg')

  try {
    orm = await import('@kaynooo/pg-orm')
    pg = await import('./pg')
  }
  catch (error) {
    throw configError('auth', 'store', 'the store of auth() is a pg-orm database, and @kaynooo/pg-orm is not installed: install it, or give `store` an AuthStore', { cause: error })
  }

  const db = new orm.Database({ url: underRoot(url ?? `sqlite://${file}`, root), tables: [...pg.authTables] })

  await db.sync(!kept && url !== undefined && shared !== undefined && sameDatabase(url, shared, root) ? { ignoreTables: [foreignTables(pg.authTables.map(table => table.name))] } : undefined)

  return pg.pgAuth(db)
}

// The hooks of `src/auth.ts`, which an app mounting its own `authCore` result from there has not meant for this.
function conventionalHooks(loaded: Record<string, unknown> | undefined): AuthHooks | undefined {
  const own = loaded?.auth

  if (typeof own === 'object' && own !== null && 'plugin' in own)
    throw configError('auth', 'module', 'src/auth.ts exports `auth`, a authCore result, while auth() builds its own: give `auth({ module: \'./src/auth\' })` for kay to mount it, or `auth({ server: false })` if you mount it by hand')

  return loaded?.hooks as AuthHooks | undefined
}

interface MailModule { enqueue?: (message: never) => unknown, send?: (message: never) => unknown, erase?: AuthMailer['erase'], subscriptions?: AuthMailer['subscriptions'] }

// `email` with the mail module's erase and export of an address on its mailer, unless the mailer has its own, so an erased account takes its mailing lists with it whichever way the app wrote `email`.
function withPrivacy(email: EmailOptions, mail: MailModule | undefined): EmailOptions {
  const erase = email.mailer.erase === undefined && typeof mail?.erase === 'function' ? mail.erase.bind(mail) : undefined
  const subscriptions = email.mailer.subscriptions === undefined && typeof mail?.subscriptions === 'function' ? mail.subscriptions.bind(mail) : undefined

  if (erase === undefined && subscriptions === undefined)
    return email

  // The app's mailer stays the prototype, so a method of it reading `this` still works.
  return { ...email, mailer: Object.create(email.mailer, { ...erase && { erase: { value: erase, enumerable: true } }, ...subscriptions && { subscriptions: { value: subscriptions, enumerable: true } } }) as AuthMailer }
}

// The mailer `mail()` of kay.config.ts built with no module, which an app with no `src/mail.ts` sends through.
async function registeredMailer(app: ExtensionApp): Promise<unknown> {
  if (!app.extensions.includes(MAIL_EXTENSION))
    return undefined

  let mail: typeof import('@kaynooo/kayjs-mail')

  try {
    mail = await import('@kaynooo/kayjs-mail')
  }
  catch {
    return undefined
  }

  // A failure of the registered loader is the app's to see.
  return mail.registeredMailer()
}

export async function emailOf(email: OwnOptions['email'], app: ExtensionApp): Promise<EmailOptions | undefined> {
  if (email === false)
    return undefined

  const mail = (app.modules.mail?.mail ?? await registeredMailer(app)) as MailModule | undefined

  if (email !== undefined)
    return withPrivacy(email, mail)

  const send = mail?.enqueue ?? mail?.send

  if (send === undefined)
    return undefined

  // kayjs-mail registered in kay.config.ts brings its wording, views and theme to the mails, as `kay add auth` writes it.
  if (!app.extensions.includes(MAIL_EXTENSION))
    return withPrivacy({ mailer: { send: send as never } }, mail)

  try {
    const { authMailer } = await import('@kaynooo/kayjs-mail')

    return withPrivacy({ mailer: authMailer(send as never) }, mail)
  }
  catch {
    return withPrivacy({ mailer: { send: send as never } }, mail)
  }
}

// The auth each test site's `auth()` with no module built, by the site's cookies, which `authTest` signs that site in through.
const builtFor = new WeakMap<Bun.CookieMap, OwnTest>()

export function builtOwn(site: { cookies: Bun.CookieMap }): OwnTest | undefined {
  return builtFor.get(site.cookies)
}

/** The `authCore` an `auth()` with no module makes as the server starts: kay's session, the store, the mailer and the hooks found, the pages on. */
export async function buildOwn(options: OwnOptions, app: ExtensionApp): Promise<UserMaker & { plugin: AnyElysia }> {
  const { authCore } = await import('./auth')
  const { hooks: loadHooks, store, oauth, email, pages, prefix, home, cookie, ...rest } = options
  const hooks = loadHooks ? (await loadHooks()).hooks : conventionalHooks(app.modules.hooks)
  const mailer = await emailOf(email, app)

  if (store === undefined && app.database === undefined && process.env.NODE_ENV === 'production' && databaseUrlFromEnv() === undefined) {
    const file = existsSync(resolve(app.root, LEGACY_OWN_FILE)) ? LEGACY_OWN_FILE : OWN_FILE

    log.warn(appStore()?.sql === undefined
      ? `auth() keeps its users in ${file}, a SQLite file: set the app's \`store\` (\`sqliteData\` or \`pgData\`) in kay.config.ts, AUTH_DATABASE_URL, or auth's \`store\`, for a database that outlives a deploy`
      : `auth() keeps its users in ${file}, a SQLite file, because pgData was given a connection and names no url: set AUTH_DATABASE_URL or pass auth({ store: pgAuth(db) }) for a database that outlives a deploy`)
  }

  const made = authCore({
    ...hooks,
    ...rest,
    ...prefix !== undefined && { prefix },
    sessions: session<AuthSessionData>(cookie === undefined ? {} : { cookie }),
    store: await storeOf(store, app.root, app.database, app.exporting),
    ...oauth && { oauth: Object.fromEntries(Object.entries(oauth).map(([name, app]) => [name, appOf(name, app)])) },
    ...mailer && { email: mailer },
    pages: pages === false ? undefined : { prefix: prefix ?? '/auth', home: home ?? '/', ...typeof pages === 'object' && pages },
  })

  if (app.testCookies)
    builtFor.set(app.testCookies, made)

  return made as unknown as UserMaker & { plugin: AnyElysia }
}
