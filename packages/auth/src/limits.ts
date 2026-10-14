import type { Core } from './core'
import type { AuthStore } from './store'

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export interface Limit {
  max: number
  // Seconds.
  window: number
}

// Loose per client address, which an office or a carrier may share, and tight per account, which only one person guesses at.
export const DEFAULT_LIMITS = {
  signIn: { max: 40, window: 15 * MINUTE },
  signInAccount: { max: 6, window: 15 * MINUTE },
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
  // An export walks every table the app's onExport reads, so asking for one again and again is not free.
  export: { max: 6, window: HOUR },
  // Guessing a token is hopeless; this keeps trying from being free.
  link: { max: 40, window: HOUR },
} satisfies Record<string, Limit>

export type Limits = Record<keyof typeof DEFAULT_LIMITS, Limit>

// Whether `key` is out of attempts, without counting one.
export async function exhausted(store: AuthStore, key: string, limit: Limit): Promise<boolean> {
  return await store.attempts.count(key) >= limit.max
}

// Counts one attempt and answers whether it was over the limit.
export async function spend(store: AuthStore, key: string, limit: Limit): Promise<boolean> {
  return await store.attempts.hit(key, limit.window) > limit.max
}

// The key counting attempts against what a visitor typed, such as an address: kept as a keyed digest, so the table holds no email.
export function typedKey(core: Core, scope: string, typed: string): string {
  return `${scope}:${core.keys.fingerprint(typed)}`
}
