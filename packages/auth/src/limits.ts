import type { Duration } from 'kay'
import type { Core } from './core'
import type { AuthRates } from './rates'
import { durationSeconds } from 'kay/library'

// `max` attempts every `window`, a string such as '15m', as in kay's own `rateLimit`.
export interface Limit {
  max: number
  window: Duration
}

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
} satisfies Record<string, Limit>

// `oauthRegisterAll` has no default: one address cannot use up a budget every other client shares, so it is a ceiling an app chooses to add on all addresses together.
export type Limits = Record<keyof typeof DEFAULT_LIMITS, Limit> & { oauthRegisterAll?: Limit }

// A limit as the app writes it, which is the shape of every limit.
export type LimitOption = Limit

// The limits `rateLimit` overrides, the rest keeping their defaults.
export type LimitsOption = Partial<Record<keyof Limits, LimitOption>>

// The defaults over what the app set in `rateLimit`; a bad window throws naming its limit.
export function resolveLimits(given: LimitsOption | undefined): Limits {
  const limits: Limits = { ...DEFAULT_LIMITS }

  for (const [name, limit] of Object.entries(given ?? {}) as [keyof Limits, LimitOption | undefined][]) {
    if (!limit)
      continue

    durationSeconds(limit.window, `rateLimit.${name}.window`)
    limits[name] = { max: limit.max, window: limit.window }
  }

  return limits
}

// Counts one attempt and answers whether it was over the limit.
export async function spend(rates: AuthRates, key: string, limit: Limit): Promise<boolean> {
  return (await rates.hit(key, limit.window)).count > limit.max
}

// The attempts counted under `key` in its open window, none once it ended.
export async function counted(rates: AuthRates, key: string): Promise<number> {
  return (await rates.peek(key))?.count ?? 0
}

// The key counting attempts against what a visitor typed, such as an address: kept as a keyed digest, so the table holds no email.
export function typedKey(core: Core, scope: string, typed: string): string {
  return `${scope}:${core.keys.fingerprint(typed)}`
}
