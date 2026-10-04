import type { AuthStore } from './store'

const MINUTE = 60
const HOUR = 60 * MINUTE

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
