import type { Duration } from 'kay'
import type { Core } from './core'
import type { AuthStore } from './store'
import { durationSeconds } from 'kay/library'

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export interface Limit {
  max: number
  // Seconds.
  window: number
}

// Loose per client address, which an office or a carrier may share, and tight per account, which only one person guesses at.
// Wrong passwords only count: `signInAccount` is tight per client and account, so it never keeps the holder out, and `signInAccountAll` is the looser ceiling on the account from every client together.
export const DEFAULT_LIMITS = {
  signIn: { max: 40, window: 15 * MINUTE },
  signInAccount: { max: 6, window: 15 * MINUTE },
  signInAccountAll: { max: 60, window: 15 * MINUTE },
  register: { max: 6, window: HOUR },
  // Each of these mails a way into an account, so none may flood an inbox someone else owns.
  resend: { max: 12, window: HOUR },
  resendAccount: { max: 3, window: HOUR },
  forgot: { max: 12, window: HOUR },
  forgotAccount: { max: 3, window: HOUR },
  magicLink: { max: 12, window: HOUR },
  magicLinkAccount: { max: 3, window: HOUR },
  emailChange: { max: 12, window: HOUR },
  emailChangeAccount: { max: 5, window: HOUR },
  // A six-digit code is guessed in minutes without these: they are what makes the second factor strong.
  twoFactor: { max: 30, window: 15 * MINUTE },
  twoFactorAccount: { max: 8, window: 15 * MINUTE },
  // Re-proving is a password guess like any other.
  reprove: { max: 6, window: 15 * MINUTE },
  // Guesses at an emailed code, on top of the few misses each code takes.
  emailCode: { max: 30, window: 15 * MINUTE },
  emailCodeAccount: { max: 10, window: 15 * MINUTE },
  // Each invitation mails an inbox someone else owns, with the organization's name in it: neither one manager nor many may flood one.
  invite: { max: 30, window: HOUR },
  inviteAddress: { max: 5, window: DAY },
  // Each organization is a row and a slug nobody else can take, so one account may not mint them without end.
  organization: { max: 10, window: DAY },
  // An export walks every table the app's onExport reads, so asking for one again and again is not free.
  export: { max: 6, window: HOUR },
  // Registering a client writes a row for anyone who asks, and reading a client's metadata document makes a request for them.
  oauthRegister: { max: 20, window: HOUR },
  oauthDocument: { max: 30, window: 15 * MINUTE },
  // Loose, as a client refreshes its token for every user behind one address; a wrong code or refresh token is hopeless to guess.
  oauthToken: { max: 300, window: 15 * MINUTE },
  // Guessing a token is hopeless; this keeps trying from being free.
  link: { max: 40, window: HOUR },
} satisfies Record<string, Limit>

// `oauthRegisterAll` has no default: one address cannot use up a budget every other client shares, so it is a ceiling an app chooses to add on all addresses together.
export type Limits = Record<keyof typeof DEFAULT_LIMITS, Limit> & { oauthRegisterAll?: Limit }

// A limit as the app writes it: the window seconds or a string such as '15m'.
export interface LimitOption {
  max: number
  window: Duration
}

// The limits `rateLimit` overrides, the rest keeping their defaults.
export type LimitsOption = Partial<Record<keyof Limits, LimitOption>>

// The defaults over what the app set in `rateLimit` and its old name `limits`, every window in seconds; a bad window throws naming its limit.
export function resolveLimits(old: LimitsOption | undefined, given: LimitsOption | undefined): Limits {
  const limits: Limits = { ...DEFAULT_LIMITS }

  applyLimits(limits, old, 'limits')
  applyLimits(limits, given, 'rateLimit')

  return limits
}

function applyLimits(limits: Limits, option: LimitsOption | undefined, from: string): void {
  for (const [name, limit] of Object.entries(option ?? {}) as [keyof Limits, LimitOption | undefined][]) {
    if (limit)
      limits[name] = { max: limit.max, window: durationSeconds(limit.window, `${from}.${name}.window`) }
  }
}

// Counts one attempt and answers whether it was over the limit.
export async function spend(store: AuthStore, key: string, limit: Limit): Promise<boolean> {
  return await store.attempts.hit(key, `${limit.window}s`) > limit.max
}

// The key counting attempts against what a visitor typed, such as an address: kept as a keyed digest, so the table holds no email.
export function typedKey(core: Core, scope: string, typed: string): string {
  return `${scope}:${core.keys.fingerprint(typed)}`
}
