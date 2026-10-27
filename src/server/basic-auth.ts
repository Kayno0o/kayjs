import type { Guard } from '../runtime/core'
import { KayError } from '../compiler/errors'
import { kayLog } from '../runtime/log'
import { nodeCrypto } from './builtins'

export interface BasicAuthOptions {
  // The user name; a request is refused while it is unset or empty, as the secret behind it may come from an environment variable that is missing.
  user: string | undefined
  // The password; refused the same way while unset or empty.
  password: string | undefined
  // Named in the browser's sign-in dialog, `Restricted` by default; printable ASCII.
  realm?: string | undefined
}

const SCHEME = /^basic +(\S+) *$/i
const BASE64 = /^[A-Z0-9+/]+={0,2}$/i
const UNPRINTABLE = /[^\x20-\x7E]/

const decoder = new TextDecoder('utf-8', { fatal: true })

// The credentials a header carries, split at the first colon as RFC 7617 has it, or undefined for anything that is no well-formed `Basic` header in UTF-8.
function credentialsOf(header: string | null): { user: string, password: string } | undefined {
  const encoded = header === null ? undefined : SCHEME.exec(header)?.[1]

  if (encoded === undefined || !BASE64.test(encoded))
    return undefined

  let text: string

  try {
    text = decoder.decode(Buffer.from(encoded, 'base64'))
  }
  catch {
    return undefined
  }

  const colon = text.indexOf(':')

  return colon === -1 ? undefined : { user: text.slice(0, colon), password: text.slice(colon + 1) }
}

// Digests of equal length, so the compare tells nothing of where the texts differ or how long the expected one is.
function sameDigest(given: string, expected: Buffer): boolean {
  const { createHash, timingSafeEqual } = nodeCrypto()

  return timingSafeEqual(createHash('sha256').update(given).digest(), expected)
}

// A guard for HTTP Basic, for a device that only speaks it: `export default basicAuth({ user: process.env.TRACKER_USER, password: process.env.TRACKER_PASSWORD, realm: 'voyager' })` in a `_guard.ts` of `src/api/` or `src/routes/`.
// It answers 401 with `WWW-Authenticate` to a request without the right credentials, and to every request while either is unset, so a missing environment variable never opens the route.
export function basicAuth(options: BasicAuthOptions): Guard {
  const { user, password, realm = 'Restricted' } = options

  if (UNPRINTABLE.test(realm))
    throw new KayError('config-invalid', 'kay: the realm of basicAuth is printable ASCII only, so it can be a header value')

  if (user?.includes(':'))
    throw new KayError('config-invalid', 'kay: the user of basicAuth holds a colon, which a client cannot send: the first colon of the credentials ends the user')

  const challenge = `Basic realm="${realm.replace(/["\\]/g, '\\$&')}", charset="UTF-8"`
  const configured = user !== undefined && user !== '' && password !== undefined && password !== ''
  let expected: { user: Buffer, password: Buffer } | undefined
  let warned = false

  return ({ request, headers, deny }) => {
    const refuse = (): never => {
      headers.set('www-authenticate', challenge)

      return deny(401)
    }

    if (!configured) {
      if (!warned) {
        warned = true
        kayLog('warn', 'basicAuth has no user or no password, so it refuses every request')
      }

      return refuse()
    }

    const { createHash } = nodeCrypto()

    expected ??= { user: createHash('sha256').update(user).digest(), password: createHash('sha256').update(password).digest() }

    const given = credentialsOf(request.headers.get('authorization'))
    // Both are always compared, so a wrong user and a wrong password take as long.
    const userMatches = sameDigest(given?.user ?? '', expected.user)
    const passwordMatches = sameDigest(given?.password ?? '', expected.password)

    if (given === undefined || !userMatches || !passwordMatches)
      return refuse()
  }
}
