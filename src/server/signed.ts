import type { Duration } from '../runtime/duration'
import { durationSeconds } from '../runtime/duration'
import { signedText, signText } from './stamp'

export interface SignOptions {
  // How long the signature stays valid: `'1h'` when left out.
  maxAge?: Duration | undefined
}

const DEFAULT_MAX_AGE = '1h'
// Keeps what the app signs from passing for what kay signs with the same secret, such as a private file link.
const SIGNING_USE = 'kay-signed'
// Only digits, so the first dot always ends the expiry whatever the signature holds.
const EXPIRY = /^\d{1,15}$/

function signedUse(use: string): string {
  return `${SIGNING_USE}\0${use}`
}

function signedValue(value: string, until: string): string {
  return `${value}\0${until}`
}

// Signs and checks values of the app's own, a link it sends by mail or push for one: `const token = signed.sign('shot', id)` then `signed.verify('shot', id, token)`.
// Keyed on the app secret ([the app secret](environment.md#the-app-secret)), so every replica agrees and a rotation list keeps older signatures valid.
export const signed = {
  // `<expiry>.<signature>`, URL-safe, binding `value` to `use` and to its expiry: the same value signed for another `use` does not verify.
  sign(use: string, value: string, options: SignOptions = {}): string {
    const until = String(Math.ceil(Date.now() / 1000 + durationSeconds(options.maxAge ?? DEFAULT_MAX_AGE, 'signed.sign()\'s maxAge')))

    return `${until}.${signText(signedUse(use), signedValue(value, until))}`
  },

  // Whether `token` is what `sign` gave for this `use` and `value` and has not expired; anything else, a missing or malformed token included, is false and throws nothing.
  verify(use: string, value: string, token: unknown): boolean {
    if (typeof token !== 'string')
      return false

    const dot = token.indexOf('.')
    const until = token.slice(0, dot)

    return dot > 0 && EXPIRY.test(until) && Number(until) > Date.now() / 1000 && signedText(signedUse(use), signedValue(value, until), token.slice(dot + 1))
  },
}
