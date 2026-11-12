import type { RateLimit, RateWindow } from 'kay'
import type { Core } from './core'
import type { AuthLimiters } from './rates'
import { configError, durationSeconds, limitRefused } from 'kay/library'

// `max` attempts every `window`, a string such as '15m', as in kay's own `rateLimit`, counted in `store` when given. kayjs-auth counts under keys of its own, so it takes no `key`.
// A `rateLimit()` object is not taken: its counter is under the client's address, where kayjs-auth counts under keys of its own. `onLimit` is told of each attempt refused.
export type AuthRateLimit = Omit<RateLimit, 'key'> & { hit?: never, enforce?: never }

// The limits of one bucket once resolved: the first, which the lockouts read `max` of, and the others counted beside it.
export type LimitSet = [AuthRateLimit, ...AuthRateLimit[]]

// Loose per client address, which an office or a carrier may share, and tight per account, which only one person guesses at.
// Wrong passwords only count: `signInAccount` is tight per client and account, so it never keeps the holder out, and `signInAccountAll` is the looser ceiling on the account from every client together.
export const DEFAULT_LIMITS = {
  signIn: { max: 40, window: '15m' },
  signInAccount: { max: 6, window: '15m' },
  signInAccountAll: { max: 60, window: '15m' },
  register: { max: 6, window: '1h' },
  // Each of these mails a way into an account, so none may flood an inbox someone else owns.
  resend: { max: 12, window: '1h' },
  resendAccount: { max: 3, window: '1h' },
  forgot: { max: 12, window: '1h' },
  forgotAccount: { max: 3, window: '1h' },
  magicLink: { max: 12, window: '1h' },
  magicLinkAccount: { max: 3, window: '1h' },
  emailChange: { max: 12, window: '1h' },
  emailChangeAccount: { max: 5, window: '1h' },
  // A six-digit code is guessed in minutes without these: they are what makes the second factor strong.
  twoFactor: { max: 30, window: '15m' },
  twoFactorAccount: { max: 8, window: '15m' },
  // Re-proving is a password guess like any other.
  reprove: { max: 6, window: '15m' },
  // Guesses at an emailed code, on top of the few misses each code takes.
  emailCode: { max: 30, window: '15m' },
  emailCodeAccount: { max: 10, window: '15m' },
  // Each invitation mails an inbox someone else owns, with the organization's name in it: neither one manager nor many may flood one.
  invite: { max: 30, window: '1h' },
  inviteAddress: { max: 5, window: '1d' },
  // Each organization is a row and a slug nobody else can take, so one account may not mint them without end.
  organization: { max: 10, window: '1d' },
  // An export walks every table the app's exportData reads, so asking for one again and again is not free.
  export: { max: 6, window: '1h' },
  // Registering a client writes a row for anyone who asks, and reading a client's metadata document makes a request for them.
  oauthRegister: { max: 20, window: '1h' },
  oauthDocument: { max: 30, window: '15m' },
  // Loose, as a client refreshes its token for every user behind one address; a wrong code or refresh token is hopeless to guess.
  oauthToken: { max: 300, window: '15m' },
  // Guessing a token is hopeless; this keeps trying from being free.
  link: { max: 40, window: '1h' },
} satisfies Record<string, AuthRateLimit>

// `oauthRegisterAll` has no default: one address cannot use up a budget every other client shares, so it is a ceiling an app chooses to add on all addresses together.
export type Limits = Record<keyof typeof DEFAULT_LIMITS, AuthRateLimit> & { oauthRegisterAll?: AuthRateLimit }

// A limit as the app writes it, alone or in a list that is each counted apart.
export type LimitOption = AuthRateLimit | AuthRateLimit[]

// The limits `rateLimit` overrides, the rest keeping their defaults.
export type LimitsOption = Partial<Record<keyof Limits, LimitOption>>

export type ResolvedLimits = Record<keyof typeof DEFAULT_LIMITS, LimitSet> & { oauthRegisterAll?: LimitSet }

// The defaults over what the app set in `rateLimit`; a bad limit throws naming it.
export function resolveLimits(given: LimitsOption | undefined): ResolvedLimits {
  const limits = Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([name, limit]) => [name, [limit]])) as unknown as ResolvedLimits

  for (const [name, option] of Object.entries(given ?? {}) as [keyof Limits, LimitOption | undefined][]) {
    if (!option)
      continue

    const list = [option].flat()

    if (list.length === 0)
      throw configError('auth', 'rateLimit', `rateLimit.${name} is an empty list; give it a limit or leave it out`)

    for (const [index, limit] of list.entries()) {
      const place = list.length === 1 ? `rateLimit.${name}` : `rateLimit.${name}[${index}]`

      durationSeconds(limit.window, `${place}.window`)

      if (limit.store !== undefined && typeof limit.store?.hit !== 'function')
        throw configError('auth', 'rateLimit', `${place}.store has no hit(key, window) method; give it a RateStore`)

      if (limit.onLimit !== undefined && typeof limit.onLimit !== 'function')
        throw configError('auth', 'rateLimit', `${place}.onLimit is not a function; give it a function of the refusal`)

      if (typeof (limit as { hit?: unknown }).hit === 'function')
        throw configError('auth', 'rateLimit', `${place} is a rateLimit() object, which counts under the client's address; kayjs-auth counts under keys of its own, so give it { max, window, store?, onLimit? }`)
    }

    limits[name] = list.map(({ max, window, store, onLimit }) => ({ max, window, store, onLimit })) as LimitSet
  }

  return limits
}

// Counts one attempt against each limit of the bucket and answers whether any was over.
export async function spend(rates: AuthLimiters, key: string, limits: LimitSet): Promise<boolean> {
  let over = false

  for (const [index, limit] of limits.entries()) {
    const wait = await rates(limit).enforce(apart(key, index))

    if (wait !== undefined) {
      over = true
      limitRefused('kayjs-auth', limit, { key, wait })
    }
  }

  return over
}

// The attempts counted under `key` in the first limit's open window, none once it ended.
export async function counted(rates: AuthLimiters, key: string, limits: LimitSet): Promise<number> {
  return (await rates(limits[0]).peek(key))?.count ?? 0
}

// Counts one attempt without refusing it, in each limit of the bucket: the first's window, which the caller compares to `max`, and whether any of the others is over.
export async function tally(rates: AuthLimiters, key: string, limits: LimitSet): Promise<RateWindow & { beside: boolean }> {
  const first = await rates(limits[0]).hit(key)
  let beside = false

  for (const [index, limit] of limits.entries()) {
    if (index === 0)
      continue

    const window = await rates(limit).hit(apart(key, index))

    if (window.count > limit.max) {
      beside = true
      limitRefused('kayjs-auth', limit, { key, wait: secondsTo(window.resetAt) })
    }
  }

  return { ...first, beside }
}

// Forgets the count under `key` in each limit of the bucket.
export async function forget(rates: AuthLimiters, key: string, limits: LimitSet): Promise<void> {
  for (const [index, limit] of limits.entries())
    await rates(limit).reset(apart(key, index))
}

// The first limit counts under the key itself, the others under their place in the list, in front of it as no key of the library starts with `#`.
function apart(key: string, index: number): string {
  return index === 0 ? key : `#${index}:${key}`
}

// Whether the count under `key` has reached `max` in any limit of the bucket.
export async function reached(rates: AuthLimiters, key: string, limits: LimitSet): Promise<boolean> {
  for (const [index, limit] of limits.entries()) {
    const window = await rates(limit).peek(apart(key, index))

    if (window && window.count >= limit.max) {
      limitRefused('kayjs-auth', limit, { key, wait: secondsTo(window.resetAt) })

      return true
    }
  }

  return false
}

function secondsTo(resetAt: number): number {
  return Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))
}

// A limit that only names a window in milliseconds, for a count nothing is refused by.
export function windowOf(ms: number): AuthRateLimit {
  return { max: Number.MAX_SAFE_INTEGER, window: `${ms}ms` }
}

// The key counting attempts against what a visitor typed, such as an address: kept as a keyed digest, so the table holds no email.
export function typedKey(core: Core, scope: string, typed: string): string {
  return `${scope}:${core.keys.fingerprint(typed)}`
}
