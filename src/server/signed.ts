import type { Duration } from '../runtime/duration'
import { durationSeconds } from '../runtime/duration'
import { signedText, signText, useScriptSecret } from './stamp'

export interface SignOptions {
  // How long the signature stays valid: `'1h'` when left out.
  maxAge?: Duration | undefined
}

const DEFAULT_MAX_AGE = '1h'
// Keeps what the app signs from passing for what kay signs with the same secret, such as a private file link.
const SIGNING_USE = 'kay-signed'
// Only digits, so the first dot always ends the expiry whatever the signature holds.
const EXPIRY = /^\d{1,15}$/

// Lengths first, so no `use` and `value` pair reads as another whatever characters they hold.
function signedValue(use: string, value: string, until: string): string {
  return JSON.stringify([use, value, until])
}

function checked(use: unknown, value: unknown): void {
  if (typeof use !== 'string' || typeof value !== 'string')
    throw new TypeError('kay: signed takes a string `use` and a string `value`')
}

// Under a year, so the expiry stays a plain integer.
const MAX_SECONDS = 31_536_000

// Signs and checks values of the app's own, a link it sends by mail or push for one: `const token = signed.sign('shot', id)` then `signed.verify('shot', id, token)`.
// Keyed on the app secret ([the app secret](environment.md#the-app-secret)), which a script or a job reads too, so every replica agrees and a rotation list keeps older signatures valid.
export const signed = {
  // `<expiry>.<signature>`, URL-safe, binding `value` to `use` and to its expiry: the same value signed for another `use` does not verify.
  sign(use: string, value: string, options: SignOptions = {}): string {
    checked(use, value)

    const seconds = durationSeconds(options.maxAge ?? DEFAULT_MAX_AGE, 'signed.sign()\'s maxAge')

    if (seconds > MAX_SECONDS)
      throw new RangeError('kay: signed.sign()\'s maxAge is at most 1 year (\'52w\')')

    useScriptSecret()

    const until = String(Math.ceil(Date.now() / 1000 + seconds))

    return `${until}.${signText(SIGNING_USE, signedValue(use, value, until))}`
  },

  // Whether `token` is what `sign` gave for this `use` and `value` and has not expired; anything else, a missing or malformed token included, is false and throws nothing.
  verify(use: string, value: string, token: unknown): boolean {
    checked(use, value)

    if (typeof token !== 'string')
      return false

    useScriptSecret()

    const dot = token.indexOf('.')
    const until = token.slice(0, dot)

    return dot > 0 && EXPIRY.test(until) && Number(until) > Date.now() / 1000 && signedText(SIGNING_USE, signedValue(use, value, until), token.slice(dot + 1))
  },
}
