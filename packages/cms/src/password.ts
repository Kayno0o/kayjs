import type { Duration, Guard, RateStore } from 'kay'
import type { LazyGuard } from 'kay/library'
import { createHash, createHmac, scryptSync, timingSafeEqual } from 'node:crypto'
import { guard } from 'kay'
import { appSecrets, appStore, configError, durationSeconds, keyedDigest, memoryRates } from 'kay/library'
import { wording } from 'kay/words'
import { log } from './log'

// The cookie holding a password sign-in: `<role>.<expires>.<signature>`, signed with a key made from that role's password and the app's secret.
export const SESSION_COOKIE = 'kay_editor_session'
// Its name over https: a browser takes the `__Host-` prefix only from the site itself, secure, on the whole site and with no domain, so a subdomain cannot replace it. The plain names are still read, for a sign-in made before.
export const HOST_SESSION_COOKIE = `__Host-${SESSION_COOKIE}`
// The name before 1.70, still read so no editor is signed out by the rename; it is never set again.
export const LEGACY_SESSION_COOKIE = 'kcms_session'

// The sign-in cookie a request holds, under its name or the one before 1.70.
// Both names, as a browser holding the two must have each copy ended.
export function sessionCookiesOf(cookies: { get: (name: string) => string | null }): string[] {
  return [cookies.get(HOST_SESSION_COOKIE), cookies.get(SESSION_COOKIE), cookies.get(LEGACY_SESSION_COOKIE)].filter(value => value != null)
}

export function sessionCookieOf(cookies: { get: (name: string) => string | null }): string | undefined {
  return sessionCookiesOf(cookies)[0]
}

const DEFAULT_ROLE = 'editor'
const DEFAULT_MAX_AGE = '14d'
const ROLE = /^[\w-]+$/
const KEY_SALT = 'kayjs-cms/password/v1:'
// A password shorter than this is refused in production, where it is all that stands between the web and the admin.
const MIN_PASSWORD_LENGTH = 12
let warnedOfNoSecret = false
const REVOKED = 'cms:revoked\n'
const FAILURES = 'cms:sign-in-failures'
// Wrong passwords from anyone, every quarter of an hour, past which no sign-in is tried until the window closes: the per-visitor limit does not stop a guess spread over many addresses.
const FAILURE_CEILING = 100
const FAILURE_WINDOW = '15m'

export interface PasswordOptions {
  // How long a sign-in lasts, `'14d'` by default.
  maxAge?: Duration | undefined
  // Mixed into the key the cookie is signed with, so the same password on another site signs in nowhere else; the app's own secret (`KAY_SECRET`) when left out.
  secret?: string | undefined
  // Where signed-out cookies and wrong passwords are counted so every process sees them: the app's `store.rates`, else this process's memory.
  store?: RateStore | undefined
}

// Who a password guard let a request in as, for the screens to name and the roles to read.
export const signedInBy = new WeakMap<Request, { name: string, roles: readonly string[] }>()

function digest(text: string): Buffer {
  return createHash('sha256').update(text).digest()
}

function same(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

// The passwords of a `passwordGuard()`, and the sign-in cookie it signs with them. Changing a password ends every sign-in made with it.
export class Passwords {
  private readonly digests = new Map<string, Buffer>()
  private readonly keys = new Map<string, Buffer>()
  private readonly given = new Map<string, string>()
  // The signatures of cookies signed out in this process, each kept until the cookie would have expired anyway; the store holds the same for the other processes and a restart.
  private readonly revoked = new Map<string, number>()
  private readonly seconds: number
  private readonly memory = memoryRates()
  private lastIssued = 0

  constructor(passwords: Record<string, string>, maxAge: Duration, private readonly secret?: string, private readonly chosenStore?: RateStore) {
    this.seconds = durationSeconds(maxAge, '`passwordGuard({ maxAge })`')

    if (chosenStore !== undefined && chosenStore.peek === undefined)
      this.store()

    const entries = Object.entries(passwords)
    const production = process.env.NODE_ENV === 'production'

    if (entries.length === 0)
      throw configError('`passwordGuard()` takes a password, or an object of passwords by role')

    for (const [role, password] of entries) {
      if (!ROLE.test(role))
        throw configError(`\`passwordGuard()\` names the role ${JSON.stringify(role)}; a role is letters, digits, \`_\` and \`-\``)

      // An unset environment variable reads as an empty string, which must not open the admin.
      if (typeof password !== 'string' || password.trim() === '')
        throw configError(`\`passwordGuard()\` has no password for ${JSON.stringify(role)}; check the environment variable it reads`)

      if (production && password.length < MIN_PASSWORD_LENGTH)
        throw configError(`\`passwordGuard()\` has a password of ${password.length} characters for ${JSON.stringify(role)}: in production it is at least ${MIN_PASSWORD_LENGTH}`)

      if (production) {
        const twin = [...this.given].find(([, other]) => other === password)

        if (twin)
          throw configError(`\`passwordGuard()\` gives ${JSON.stringify(twin[0])} and ${JSON.stringify(role)} the same password, which could only open the first; give each role its own`)
      }

      this.given.set(role, password)
      this.digests.set(role, digest(password))
    }
  }

  // The store that signed-out cookies and the ceiling are kept in; one without `peek` could keep neither, so it is refused.
  private store(): RateStore & Required<Pick<RateStore, 'peek'>> {
    const store = this.chosenStore ?? appStore()?.rates ?? this.memory

    if (store.peek === undefined)
      throw configError('`passwordGuard()` needs a rate store with a `peek(key)` method, to tell a signed-out cookie and count wrong passwords; add it to `store.rates`, or use `sqliteRates()`')

    return store as RateStore & Required<Pick<RateStore, 'peek'>>
  }

  // Slow on purpose: a cookie seen once must not let the password be guessed offline at hashing speed. Made on first use, as the app's secret may be set up after the guard.
  private keyOf(role: string): Buffer | undefined {
    const password = this.given.get(role)

    if (password === undefined)
      return undefined

    let key = this.keys.get(role)

    if (!key) {
      const secret = this.secret ?? appSecrets()?.[0] ?? ''

      if (secret === '' && process.env.NODE_ENV === 'production' && !warnedOfNoSecret) {
        warnedOfNoSecret = true
        log.warn('passwordGuard() has no secret: set KAY_SECRET so a sign-in cookie cannot be checked against a guessed password offline')
      }

      this.keys.set(role, key = scryptSync(password, KEY_SALT + secret, 32))
    }

    return key
  }

  // The roles the guard holds a password for.
  roles(): string[] {
    return [...this.digests.keys()]
  }

  // The role this password opens, or undefined. Every password is compared, so the time taken tells nothing of which one was close.
  match(given: string): string | undefined {
    const hashed = digest(given)
    let found: string | undefined

    for (const [role, expected] of this.digests) {
      if (same(hashed, expected))
        found ??= role
    }

    return found
  }

  // Whether wrong passwords from all visitors have passed the ceiling, so no sign-in is tried until the window closes; a store that cannot answer counts as passed.
  async lockedOut(): Promise<boolean> {
    try {
      const window = await this.store().peek(FAILURES)

      return (window?.count ?? 0) >= FAILURE_CEILING
    }
    catch (error) {
      log.error(`the store counting wrong passwords did not answer, so no sign-in is tried: ${error instanceof Error ? error.message : String(error)}`)

      return true
    }
  }

  // Counts a wrong password against the ceiling, logging the first one past it.
  async failed(): Promise<void> {
    try {
      const window = await this.store().hit(FAILURES, FAILURE_WINDOW)

      if (window.count === FAILURE_CEILING)
        log.warn(`${FAILURE_CEILING} wrong passwords in ${FAILURE_WINDOW}: the cms sign-in refuses every try until the window closes`)
    }
    catch (error) {
      log.error(`a wrong password could not be counted: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // The sign-in cookie for a role this password opened.
  issue(role: string, secure: boolean): Bun.Cookie {
    // Each sign-in gets a date of its own, so signing one out never ends another made in the same millisecond.
    this.lastIssued = Math.max(Date.now(), this.lastIssued + 1)

    const payload = `${role}.${this.lastIssued + this.seconds * 1000}`

    return new Bun.Cookie(secure ? HOST_SESSION_COOKIE : SESSION_COOKIE, `${payload}.${this.sign(role, payload)}`, { path: '/', maxAge: this.seconds, httpOnly: true, sameSite: 'lax', secure })
  }

  // The role a sign-in cookie holds, when this server signed it and it has not expired; any other value, a forged role or a changed date included, is none.
  read(value: string | null | undefined): string | undefined {
    const parts = value?.split('.')

    if (parts?.length !== 3)
      return undefined

    const [role = '', expires = '', signature = ''] = parts
    const payload = `${role}.${expires}`

    if (!this.given.has(role) || !same(Buffer.from(signature), Buffer.from(this.sign(role, payload))))
      return undefined

    if (this.revoked.has(signature))
      return undefined

    return Number(expires) > Date.now() ? role : undefined
  }

  // Like `read`, and also refusing a cookie another process signed out, which the store knows.
  async current(value: string | null | undefined): Promise<string | undefined> {
    const role = this.read(value)

    if (role === undefined)
      return undefined

    const signature = value?.split('.')[2] ?? ''

    try {
      const window = await this.store().peek(REVOKED + keyedDigest('cms-session', signature))

      return window === undefined ? role : undefined
    }
    catch (error) {
      log.error(`the store holding signed-out cookies did not answer, so no cookie is accepted: ${error instanceof Error ? error.message : String(error)}`)

      return undefined
    }
  }

  // Ends the sign-in a cookie holds in this process only, so a copy of it stops working here; a value that is not a live sign-in of this server changes nothing.
  revokeHere(value: string | null | undefined): number | undefined {
    if (this.read(value) === undefined)
      return undefined

    const [, expires = '', signature = ''] = value?.split('.') ?? []
    const now = Date.now()

    for (const [kept, until] of this.revoked) {
      if (until <= now)
        this.revoked.delete(kept)
    }

    this.revoked.set(signature, Number(expires))

    return Number(expires) - now
  }

  // Ends the sign-in a cookie holds in every process sharing the store, so a copy of it stops working wherever it is sent.
  async revoke(value: string | null | undefined): Promise<void> {
    const left = this.revokeHere(value)

    if (left === undefined)
      return

    const signature = value?.split('.')[2] ?? ''

    try {
      await this.store().hit(REVOKED + keyedDigest('cms-session', signature), `${Math.max(1, left)}ms`)
    }
    catch (error) {
      log.error(`the store did not keep a signed-out cookie, so other processes still accept it until it expires: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private sign(role: string, payload: string): string {
    return createHmac('sha256', this.keyOf(role) ?? Buffer.alloc(0)).update(payload).digest('base64url')
  }
}

const passwordsOf = new WeakMap<Guard, Passwords>()
// The passwords of the `passwordGuard()` that ran on a request, which the cms promotes only when its own guard made the call, so another `passwordGuard()` of the app changes nothing.
const ranFor = new WeakMap<Request, Passwords>()
let installed: Passwords | undefined

// The passwords of the guard `cms({ guard })` was given, when it is a `passwordGuard()`, which the sign-in screen checks a password against. A guard loaded lazily, or wrapped by the app, is known once it has run.
export function activePasswords(): Passwords | undefined {
  return installed
}

// Runs the app's guard, then notes the passwords of the `passwordGuard()` it ran, wrapped or not.
function adopting(inner: Guard): Guard {
  return async (ctx) => {
    try {
      await inner(ctx)
    }
    finally {
      installed = ranFor.get(ctx.request) ?? installed
    }
  }
}

// Notes which passwords the app's guard holds, if it is a password guard, and hands the guard back.
export function trackPasswords(given: Guard | LazyGuard | undefined): Guard | LazyGuard | undefined {
  installed = typeof given === 'function' ? passwordsOf.get(given) : undefined

  if (given === undefined)
    return given

  if (typeof given === 'function')
    return adopting(given)

  return { load: async () => {
    const loaded = await given.load()

    installed = passwordsOf.get(loaded)

    return adopting(loaded)
  } }
}

// A guard for a site with no users: one password, or one per role, and a sign-in screen at the admin's `/sign-in`. `cms({ guard: passwordGuard(env.EDITOR_PASSWORD) })`; a lone password signs in as `editor`.
export function passwordGuard(passwords: string | Record<string, string>, { maxAge = DEFAULT_MAX_AGE, secret, store }: PasswordOptions = {}): Guard {
  const known = new Passwords(typeof passwords === 'string' ? { [DEFAULT_ROLE]: passwords } : passwords, maxAge, secret, store)

  const checked = guard(async (ctx) => {
    // A guard the app wrapped is no key of `passwordsOf`, but it runs this one, which says so for the cms guard that called it.
    ranFor.set(ctx.request, known)

    const role = await known.current(sessionCookieOf(ctx.cookies))

    if (role === undefined)
      return ctx.deny(401, wording('cms.guard.signedOut', 'Sign in to continue'))

    signedInBy.set(ctx.request, { name: role, roles: [role] })
  })

  passwordsOf.set(checked, known)

  return checked
}
