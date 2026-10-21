import type { Guard } from 'kay'
import type { LazyGuard } from 'kay/library'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { guard } from 'kay'
import { durationSeconds } from 'kay/library'
import { wording } from 'kay/words'

// The cookie holding a password sign-in: `<role>.<expires>.<signature>`, signed with a key made from that role's password.
export const SESSION_COOKIE = 'kcms_session'

const DEFAULT_ROLE = 'editor'
const DEFAULT_MAX_AGE = '14d'
const ROLE = /^[\w-]+$/
const KEY_SALT = 'kayjs-cms/password/v1:'

export interface PasswordOptions {
  // How long a sign-in lasts, `'14d'` by default.
  maxAge?: string | number | undefined
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
  private readonly seconds: number

  constructor(passwords: Record<string, string>, maxAge: string | number) {
    this.seconds = durationSeconds(maxAge, '`passwordGuard({ maxAge })`', 'kayjs-cms')

    const entries = Object.entries(passwords)

    if (entries.length === 0)
      throw new Error('kayjs-cms: `passwordGuard()` takes a password, or an object of passwords by role')

    for (const [role, password] of entries) {
      if (!ROLE.test(role))
        throw new Error(`kayjs-cms: \`passwordGuard()\` names the role ${JSON.stringify(role)}; a role is letters, digits, \`_\` and \`-\``)

      // An unset environment variable reads as an empty string, which must not open the admin.
      if (typeof password !== 'string' || password.trim() === '')
        throw new Error(`kayjs-cms: \`passwordGuard()\` has no password for ${JSON.stringify(role)}; check the environment variable it reads`)

      this.digests.set(role, digest(password))
      this.keys.set(role, digest(KEY_SALT + password))
    }
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

  // The sign-in cookie for a role this password opened.
  issue(role: string, secure: boolean): Bun.Cookie {
    const payload = `${role}.${Date.now() + this.seconds * 1000}`

    return new Bun.Cookie(SESSION_COOKIE, `${payload}.${this.sign(role, payload)}`, { path: '/', maxAge: this.seconds, httpOnly: true, sameSite: 'lax', secure })
  }

  // The role a sign-in cookie holds, when this server signed it and it has not expired; any other value, a forged role or a changed date included, is none.
  read(value: string | null | undefined): string | undefined {
    const parts = value?.split('.')

    if (parts?.length !== 3)
      return undefined

    const [role = '', expires = '', signature = ''] = parts
    const payload = `${role}.${expires}`

    if (!this.keys.has(role) || !same(Buffer.from(signature), Buffer.from(this.sign(role, payload))))
      return undefined

    return Number(expires) > Date.now() ? role : undefined
  }

  private sign(role: string, payload: string): string {
    return createHmac('sha256', this.keys.get(role) ?? Buffer.alloc(0)).update(payload).digest('base64url')
  }
}

const passwordsOf = new WeakMap<Guard, Passwords>()
let installed: Passwords | undefined

// The passwords of the guard `cms({ guard })` was given, when it is a `passwordGuard()`, which the sign-in screen checks a password against. A guard loaded lazily is known once it has loaded.
export function activePasswords(): Passwords | undefined {
  return installed
}

// Notes which passwords the app's guard holds, if it is a password guard, and hands the guard back.
export function trackPasswords(given: Guard | LazyGuard | undefined): Guard | LazyGuard | undefined {
  installed = typeof given === 'function' ? passwordsOf.get(given) : undefined

  if (given === undefined || typeof given === 'function')
    return given

  return { load: async () => {
    const loaded = await given.load()

    installed = passwordsOf.get(loaded)

    return loaded
  } }
}

// A guard for a site with no users: one password, or one per role, and a sign-in screen at the admin's `/sign-in`. `cms({ guard: passwordGuard(env.EDITOR_PASSWORD) })`; a lone password signs in as `editor`.
export function passwordGuard(passwords: string | Record<string, string>, { maxAge = DEFAULT_MAX_AGE }: PasswordOptions = {}): Guard {
  const known = new Passwords(typeof passwords === 'string' ? { [DEFAULT_ROLE]: passwords } : passwords, maxAge)

  const checked = guard((ctx) => {
    const role = known.read(ctx.cookies.get(SESSION_COOKIE))

    if (role === undefined)
      return ctx.deny(401, wording('cms.guard.signedOut', 'Sign in to continue'))

    signedInBy.set(ctx.request, { name: role, roles: [role] })
  })

  passwordsOf.set(checked, known)

  return checked
}
