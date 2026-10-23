import { appSecrets, configError, sameText } from 'kay/library'

export type TokenPurpose = 'confirm' | 'unsubscribe'

export interface TokenClaims {
  list: string
  // The subscriber's random id, never their address.
  id: string
  locale?: string | undefined
}

// How long the link of a confirmation mail works.
export const CONFIRM_MAX_AGE_MS = 3 * 24 * 3_600_000
const MAX_TOKEN = 600

function secrets(): string[] {
  const found = appSecrets()

  if (found === undefined)
    throw configError('a mailing list signs its confirmation and unsubscribe links with the app secret: set KAY_SECRET to at least 32 random characters')

  return found
}

// One key per purpose, so a link signed for one is no good for the other.
function signature(secret: string, purpose: TokenPurpose, payload: string): string {
  const key = new Bun.CryptoHasher('sha256', secret).update(`kmail-list\0${purpose}`).digest()

  return new Bun.CryptoHasher('sha256', key).update(payload).digest('base64url')
}

// `<payload>.<signature>`: the purpose, the list, the subscriber's id and, for a confirmation, when it expires. An unsubscribe link never expires, as the mail holding it may be read years on.
export function signToken(purpose: TokenPurpose, claims: TokenClaims, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ p: purpose, l: claims.list, i: claims.id, ...claims.locale === undefined ? {} : { c: claims.locale }, ...purpose === 'confirm' ? { e: now + CONFIRM_MAX_AGE_MS } : {} })).toString('base64url')

  return `${payload}.${signature(secrets()[0]!, purpose, payload)}`
}

export type TokenCheck = { ok: true, claims: TokenClaims } | { ok: false, reason: 'invalid' | 'expired' }

// Whether `token` was signed for `purpose` with one of the app's secrets and has not expired; every other text, a forged, truncated or oversized one, is `invalid`.
export function checkToken(purpose: TokenPurpose, token: unknown, now = Date.now()): TokenCheck {
  if (typeof token !== 'string' || token.length > MAX_TOKEN)
    return { ok: false, reason: 'invalid' }

  const dot = token.indexOf('.')

  if (dot < 1 || dot !== token.lastIndexOf('.'))
    return { ok: false, reason: 'invalid' }

  const payload = token.slice(0, dot)
  const given = token.slice(dot + 1)

  if (!secrets().some(secret => sameText(given, signature(secret, purpose, payload))))
    return { ok: false, reason: 'invalid' }

  let claims: { p?: unknown, l?: unknown, i?: unknown, c?: unknown, e?: unknown }

  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as typeof claims
  }
  catch {
    return { ok: false, reason: 'invalid' }
  }

  if (claims.p !== purpose || typeof claims.l !== 'string' || typeof claims.i !== 'string')
    return { ok: false, reason: 'invalid' }

  if (purpose === 'confirm' && (typeof claims.e !== 'number' || claims.e < now))
    return { ok: false, reason: 'expired' }

  return { ok: true, claims: { list: claims.l, id: claims.i, ...typeof claims.c === 'string' ? { locale: claims.c } : {} } }
}
