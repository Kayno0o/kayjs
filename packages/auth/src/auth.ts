import type { AnyElysia } from 'elysia'
import type { Guard } from 'kay'
import type { Session } from 'kay/server'
import type { Keys } from './keys'
import type { RoleHierarchy } from './roles'
import type { AuthStore, UserRecord } from './store'
import type { Level, PolicyContext, Predicate, Requirement } from './types'
import { Elysia } from 'elysia'
import { createGate } from './gate'
import { deriveKeys } from './keys'
import { createRoleHierarchy } from './roles'

const READ_METHODS = new Set(['GET', 'HEAD'])

// What kay-auth keeps in the app's kay session: the app's session type includes it, `session<AuthSessionData & { cart: Cart }>(...)`.
export interface AuthSessionData {
  auth?: SignedIn
}

interface SignedIn {
  user: string
  // The user's session version when they signed in: raising it signs this session out.
  version: number
}

// A user as the app sees them, secrets left out.
export interface User {
  id: string
  email: string | null
  emailVerified: boolean
  username: string | null
  roles: string[]
  hasPassword: boolean
  twoFactor: boolean
}

// What a route, a guard or a gate asks of the user: a role, a predicate, or a list of which any one passes.
export type AuthRequirement<Role extends string> = Requirement<User, Role>

// The plugin kay's `session()` returns, whichever data the app keeps beside kay-auth's.
export interface SessionPlugin<Data extends AuthSessionData> { '~Ephemeral': { derive: { readonly session: Session<Data> } } }

export interface AuthOptions<Data extends AuthSessionData, Role extends string> {
  sessions: SessionPlugin<Data>
  // At least 32 characters, from the environment; each use gets its own key derived from it. A list rotates them: the first writes, every one reads.
  secret: string | string[]
  store: AuthStore
  // Each role and the roles it includes: `{ admin: ['editor'], editor: [] }`.
  roles?: Record<Role, NoInfer<Role>[]>
  // Replaces the default decision, which reads a string as a role and runs a predicate; use it with `decide` for grants on single records.
  authorize?: (user: User | null, requirement: AuthRequirement<Role>, level: Level, ctx: PolicyContext) => Promise<boolean>
}

interface Core {
  store: AuthStore
  keys: Keys
}

// Auth for one request, as `auth` in the context: `ctx.locals.auth` in a page, an action or a guard.
export class Auth {
  private resolving?: Promise<UserRecord | null>

  constructor(private readonly session: Session<AuthSessionData>, private readonly core: Core) {}

  // The signed-in user, or null; read once per request, on first use.
  async user(): Promise<User | null> {
    const record = await this.record()

    return record && publicUser(record)
  }

  // Signs `user` in on this session, under a new session id so one planted before is worth nothing.
  async signIn(user: Pick<User, 'id'>): Promise<void> {
    const record = await this.core.store.users.get(user.id)

    if (!record)
      throw new Error(`kay-auth: no user ${user.id} to sign in`)

    await this.session.regenerate()
    await this.session.set('auth', { user: record.id, version: record.sessionVersion })
    this.resolving = Promise.resolve(record)
  }

  // Signs this session out. A session held in the cookie alone stays valid wherever it was copied until it expires; `signOutEverywhere` ends those too.
  async signOut(): Promise<void> {
    await this.session.unset('auth')
    await this.session.regenerate()
    this.resolving = Promise.resolve(null)
  }

  // Signs the user out of every session they hold, this one included unless `keepThisOne`, as after a password change.
  async signOutEverywhere(options: { keepThisOne?: boolean } = {}): Promise<void> {
    const record = await this.record()

    if (!record)
      return

    const updated = await this.core.store.users.update(record.id, { sessionVersion: record.sessionVersion + 1 })

    if (updated && options.keepThisOne) {
      await this.session.set('auth', { user: updated.id, version: updated.sessionVersion })
      this.resolving = Promise.resolve(updated)

      return
    }

    await this.signOut()
  }

  private async record(): Promise<UserRecord | null> {
    this.resolving ??= this.resolve()

    return this.resolving
  }

  private async resolve(): Promise<UserRecord | null> {
    const signedIn = await this.session.get('auth')

    if (!signedIn)
      return null

    const record = await this.core.store.users.get(signedIn.user)

    if (record && record.sessionVersion === signedIn.version)
      return record

    // Deleted, or signed out everywhere since.
    await this.session.unset('auth')

    return null
  }
}

// Auth for a kay app or a plain Elysia one, on the app's kay session.
export function createAuth<Data extends AuthSessionData, Role extends string = string>(options: AuthOptions<Data, Role>) {
  const core: Core = { store: options.store, keys: deriveKeys(options.secret) }
  const { hasRole, isGranted } = createRoleHierarchy<User, Role>(options.roles ?? {} as RoleHierarchy<Role>, user => user.roles as Role[])

  const plugin = new Elysia({ name: 'kay-auth' })
    .use(options.sessions as unknown as AnyElysia)
    .derive(({ session }) => ({ auth: new Auth(session as unknown as Session<AuthSessionData>, core) }))
    // The session's derive reaches this instance only; lifting both lets them reach the app's routes.
    .as('scoped')

  const evaluate = async (user: User, requirement: AuthRequirement<Role>, ctx: PolicyContext): Promise<boolean> => {
    if (Array.isArray(requirement)) {
      for (const rule of requirement) {
        if (await evaluate(user, rule, ctx))
          return true
      }

      return false
    }

    if (typeof requirement === 'function')
      return Boolean(await requirement(user, ctx))

    if (typeof requirement === 'string')
      return isGranted(requirement, user.roles as Role[])

    // A grant on one record needs the app's own `authorize`.
    return requirement.resourceId == null && isGranted(requirement.type, user.roles as Role[])
  }

  const authorize = options.authorize ?? (async (user, requirement, _level, ctx) => user !== null && evaluate(user, requirement, ctx))
  const signedIn: Predicate<User> = user => user !== null

  return {
    // `.use(auth.plugin)` before kay's pages: it adds `auth` to the context, and uses the session plugin itself.
    plugin,
    hasRole,
    isGranted: (role: Role, user: User) => isGranted(role, user.roles as Role[]),

    // Closes every route of the Elysia instance it is used on unless the user meets `require`, signed in by default. A route takes `auth: <requirement>` to ask for more and `auth: false` to stay open.
    gate(gateOptions: { require?: AuthRequirement<Role> } = {}) {
      const gate = createGate<User, Role>({
        principal: ctx => authOf(ctx).user(),
        authorize,
        defaultRequirement: gateOptions.require ?? signedIn,
      })

      return (app: AnyElysia) => gate(app.use(plugin))
    },

    // A `_guard.ts` default export. An anonymous visitor goes to `redirect` with where they were going as `?redirect=`, or gets a 401 without one, as does any post; a user who does not meet `require` gets a 403.
    guard(guardOptions: { redirect?: string, require?: AuthRequirement<Role> } = {}): Guard {
      return async (ctx) => {
        const user = await authOf(ctx.locals).user()
        const reading = READ_METHODS.has(ctx.request.method)

        if (!user) {
          if (guardOptions.redirect !== undefined && reading)
            ctx.redirect(`${guardOptions.redirect}?redirect=${encodeURIComponent(ctx.url.pathname + ctx.url.search)}`)

          ctx.deny(401, 'Sign in to continue')
        }

        if (guardOptions.require !== undefined && !(await authorize(user, guardOptions.require, reading ? 'read' : 'write', {})))
          ctx.deny(403)
      }
    },
  }
}

function authOf(ctx: object): Auth {
  const auth = (ctx as { auth?: unknown }).auth

  if (!(auth instanceof Auth))
    throw new Error('kay-auth: no `auth` in this context; `.use(auth.plugin)` before the routes and pages that read it')

  return auth
}

function publicUser(record: UserRecord): User {
  return {
    id: record.id,
    email: record.email,
    emailVerified: record.emailVerifiedAt !== null,
    username: record.username,
    roles: [...record.roles],
    hasPassword: record.passwordHash !== null,
    twoFactor: record.totpEnabledAt !== null,
  }
}
