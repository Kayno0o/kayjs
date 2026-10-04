import { Buffer } from 'node:buffer'
import { hmac, MINUTE_MS, nanoid } from '@kaynooo/utils'

/** Default `state` lifetime; long enough for a login round-trip, short enough to bound replay. */
const DEFAULT_MAX_AGE_MS = 10 * MINUTE_MS

/** Which check `verifyState` failed: a tamper/CSRF signal a caller answers with a 4xx, not a 500. */
export type OAuthStateFailure = 'malformed' | 'signature' | 'expired' | 'nonce'

/** Thrown by `verifyState` for a state that fails to verify; `reason` names the failed check. */
export class OAuthStateError extends Error {
  constructor(readonly reason: OAuthStateFailure, message: string) {
    super(message)
    this.name = 'OAuthStateError'
  }
}

interface StateEnvelope<T> {
  d: T
  n: string
  t: number
}

/** Signs a payload into a tamper-evident OAuth `state` string; pass a `nonce` to bind it to a session cookie (else a random one is returned). */
export async function signState<T>(secret: string, payload: T, opts: { nonce?: string } = {}): Promise<{ state: string, nonce: string }> {
  const nonce = opts.nonce ?? nanoid()
  const envelope: StateEnvelope<T> = { d: payload, n: nonce, t: Date.now() }
  const encoded = base64UrlEncode(JSON.stringify(envelope))

  return { state: `${encoded}.${await hmac(secret, encoded)}`, nonce }
}

/** Verifies a signed `state` and returns its payload; throws `OAuthStateError` on tamper, expiry (default 10 min, `maxAgeMs: Infinity` disables), or `expectedNonce` mismatch. */
export async function verifyState<T>(secret: string, state: string, opts: { maxAgeMs?: number, expectedNonce?: string } = {}): Promise<T> {
  const dot = state.lastIndexOf('.')

  if (dot < 0)
    throw new OAuthStateError('malformed', 'Invalid OAuth state: malformed')

  const encoded = state.slice(0, dot)
  const signature = state.slice(dot + 1)

  if (!timingSafeEqual(signature, await hmac(secret, encoded)))
    throw new OAuthStateError('signature', 'Invalid OAuth state: signature mismatch')

  const envelope = JSON.parse(base64UrlDecode(encoded)) as StateEnvelope<T>
  const maxAge = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS

  if (Date.now() - envelope.t > maxAge)
    throw new OAuthStateError('expired', 'Invalid OAuth state: expired')

  if (opts.expectedNonce !== undefined && !timingSafeEqual(envelope.n, opts.expectedNonce))
    throw new OAuthStateError('nonce', 'Invalid OAuth state: nonce mismatch')

  return envelope.d
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url')
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8')
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length)
    return false

  let mismatch = 0

  for (let i = 0; i < a.length; i++)
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)

  return mismatch === 0
}
