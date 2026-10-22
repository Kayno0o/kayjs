import type { AnyElysia } from 'elysia'
import type { AuthOptions, createAuth as CreateAuth } from './auth'
import type { AuthSessionData, OAuthApp } from './core'
import type { EmailOptions } from './email'
import type { ProviderOptions } from './oauth/providers'
import type { AuthPagesConfig, AuthPagesOptions, UserMaker } from './pages'
import type { AuthStore } from './store'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { s } from 'kay'
import { configError } from 'kay/library'
import { session } from 'kay/server'
import { log } from './log'
import { memoryAuthStore } from './memoryStore'
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

/** Where kayjs-auth keeps its data when `store` is left out: a pg-orm database at `url`, a SQLite file `data/auth.db` by default. */
export interface StoreUrl {
  url: string
}

type StoreOption = AuthStore | StoreUrl | (() => AuthStore | Promise<AuthStore>)

type Inherited = 'sessions' | 'store' | 'oauth' | 'pages' | 'prefix' | 'email'

/** The options of `auth()` with no module: `createAuth`'s own, with the session, the store, the mailer and the OAuth credentials found by convention. */
export interface OwnOptions<Role extends string = string, Prefix extends string = '/auth', Scope extends string = never, OrgRole extends string = never, UserData extends object = Record<string, never>> extends Omit<AuthOptions<AuthSessionData, Role, Prefix, Scope, OrgRole, UserData>, Inherited>, AuthPagesOptions {
  module?: undefined
  server?: undefined
  plugin?: undefined
  // Where the OAuth and page routes live, `/auth` by default.
  prefix?: Prefix | undefined
  // The prebuilt pages are served by default; `false` leaves them out, an object tunes them (`remember`, `profile`).
  pages?: boolean | Pick<AuthPagesConfig, 'profile' | 'remember'> | undefined
  // Providers by the name their routes take: `{ github: true }` reads `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` (a preset: github, discord, google, microsoft or gitlab), an object adds options to a preset, and a full `OAuthApp` is an app of any provider.
  oauth?: Record<string, true | PresetApp | OAuthApp> | undefined
  // The users' data: a pg-orm database at `{ url }`, the store itself, or a function building it. `data/auth.db` (SQLite) by default, or `KAYJS_AUTH_DATABASE_URL` when set.
  store?: StoreOption | undefined
  // Mail for verification, resets and magic links. Left out, `src/mail.ts` exporting kayjs-mail's `mail` sends them; `false` sends none.
  email?: EmailOptions | false | undefined
  // The hooks as a module the app loads, `() => import('./src/auth')`, in place of `src/auth.ts` exporting `hooks`, which is read by convention but cannot be baked into an executable.
  hooks?: (() => Promise<{ hooks: AuthHooks }>) | undefined
  // Reads the signed-in user before every page renders, as with a module: `false` by default.
  viewer?: boolean | undefined
}

export type OwnPlugin<Role extends string, Prefix extends string, Scope extends string, OrgRole extends string, UserData extends object> = ReturnType<typeof CreateAuth<AuthSessionData, Role, Prefix, Scope, OrgRole, UserData>>['plugin']

const MAIL_REGISTERED = /\bmail\(/

function isPreset(app: true | PresetApp | OAuthApp): app is true | PresetApp {
  return app === true || !('provider' in app)
}

/** The environment variables an `auth()` with no module reads, for `kay env` to list: the database url and the credentials of the providers asked by name. */
export function ownEnv(options: Pick<OwnOptions, 'oauth' | 'store'>) {
  const names = Object.entries(options.oauth ?? {}).filter(([, app]) => isPreset(app) && (app === true || app.clientId === undefined || app.clientSecret === undefined)).map(([name]) => name)

  return s.Object({
    ...options.store === undefined && { KAYJS_AUTH_DATABASE_URL: s.Optional(s.String({ description: 'the database kayjs-auth keeps its users in, a Postgres or SQLite url; data/auth.db (SQLite) when unset' })) },
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
    throw configError(`oauth.${name} is \`true\` or has no \`provider\`, and only ${Object.keys(PRESETS).join(', ')} are presets: give \`{ provider, clientId, clientSecret }\``)

  const { clientId, clientSecret, label, keepTokens, ...options } = given === true ? {} as PresetApp : given
  const key = name.toUpperCase()
  const id = clientId ?? process.env[`${key}_CLIENT_ID`]
  const secret = clientSecret ?? process.env[`${key}_CLIENT_SECRET`]

  if (id === undefined || id === '' || secret === undefined || secret === '')
    throw configError(`oauth.${name} needs ${key}_CLIENT_ID and ${key}_CLIENT_SECRET in the environment, or \`clientId\` and \`clientSecret\``)

  return { provider: preset(options), clientId: id, clientSecret: secret, ...label !== undefined && { label }, ...keepTokens !== undefined && { keepTokens } }
}

function isStore(store: AuthStore | StoreUrl): store is AuthStore {
  return 'users' in store
}

async function storeOf(store: StoreOption | undefined): Promise<AuthStore> {
  if (typeof store === 'function')
    return store()

  if (store !== undefined && isStore(store))
    return store

  const url = store?.url ?? process.env.KAYJS_AUTH_DATABASE_URL

  // Tests start from no users each run, as a file kept between them would not.
  if (url === undefined && process.env.NODE_ENV === 'test')
    return memoryAuthStore()

  let orm: typeof import('@kaynooo/pg-orm')
  let pg: typeof import('./pg')

  try {
    orm = await import('@kaynooo/pg-orm')
    pg = await import('./pg')
  }
  catch (error) {
    throw configError('the store of auth() is a pg-orm database, and @kaynooo/pg-orm is not installed: install it, or give `store` an AuthStore', { cause: error })
  }

  const db = new orm.Database({ url: url ?? 'sqlite://data/auth.db', tables: [...pg.authTables] })

  await db.sync()

  return pg.pgStore(db)
}

// The hooks of `src/auth.ts`, which an app mounting its own `createAuth` result from there has not meant for this.
async function conventionalHooks(): Promise<AuthHooks | undefined> {
  const loaded = await conventional('src/auth.ts')
  const own = loaded?.auth

  if (typeof own === 'object' && own !== null && 'plugin' in own)
    throw configError('src/auth.ts exports `auth`, a createAuth result, while auth() builds its own: give `auth({ module: \'./src/auth\' })` for kay to mount it, or `auth({ plugin: false })` if you mount it by hand')

  return loaded?.hooks as AuthHooks | undefined
}

// The module by convention at `path` under the working directory, undefined when the app has none.
async function conventional(path: string): Promise<Record<string, unknown> | undefined> {
  const file = resolve(process.cwd(), path)

  return existsSync(file) ? await import(file) as Record<string, unknown> : undefined
}

async function emailOf(email: OwnOptions['email']): Promise<EmailOptions | undefined> {
  if (email === false)
    return undefined

  if (email !== undefined)
    return email

  const mail = (await conventional('src/mail.ts'))?.mail as { enqueue?: (message: never) => unknown, send?: (message: never) => unknown } | undefined
  const send = mail?.enqueue ?? mail?.send

  if (send === undefined)
    return undefined

  // kayjs-mail registered in kay.config.ts brings its wording, views and theme to the mails, as `kay add auth` writes it.
  if (!MAIL_REGISTERED.test(existsSync(resolve(process.cwd(), 'kay.config.ts')) ? readFileSync(resolve(process.cwd(), 'kay.config.ts'), 'utf8') : ''))
    return { mailer: { send: send as never } }

  try {
    const { authMailer } = await import('@kaynooo/kayjs-mail')

    return { mailer: authMailer(send as never) }
  }
  catch {
    return { mailer: { send: send as never } }
  }
}

/** The `createAuth` an `auth()` with no module makes as the server starts: kay's session, the store, the mailer and the hooks found, the pages on. */
export async function buildOwn(options: OwnOptions): Promise<UserMaker & { plugin: AnyElysia }> {
  const { createAuth } = await import('./auth')
  const { hooks: loadHooks, store, oauth, email, pages, prefix, home, ...rest } = options
  const hooks = loadHooks ? (await loadHooks()).hooks : await conventionalHooks()
  const mailer = await emailOf(email)

  if (store === undefined && process.env.NODE_ENV === 'production' && process.env.KAYJS_AUTH_DATABASE_URL === undefined)
    log.warn('auth() keeps its users in data/auth.db, a SQLite file: set KAYJS_AUTH_DATABASE_URL, or `store`, for a database that outlives a deploy')

  const made = createAuth({
    ...hooks,
    ...rest,
    ...prefix !== undefined && { prefix },
    sessions: session<AuthSessionData>(),
    store: await storeOf(store),
    ...oauth && { oauth: Object.fromEntries(Object.entries(oauth).map(([name, app]) => [name, appOf(name, app)])) },
    ...mailer && { email: mailer },
    pages: pages === false ? undefined : { prefix: prefix ?? '/auth', home: home ?? '/', ...typeof pages === 'object' && pages },
  })

  return made as unknown as UserMaker & { plugin: AnyElysia }
}
