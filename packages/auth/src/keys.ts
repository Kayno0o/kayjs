import { Buffer } from 'node:buffer'
import { createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto'
import { GENERATE_SECRET, MIN_SECRET_LENGTH, openWith, sealWith, weakSecrets } from 'kay/library'

const KEY_BYTES = 32

export interface Keys {
  // AES-256-GCM, bound to `context` (such as the row it is stored in) so a value moved to another row no longer opens.
  encrypt: (text: string, context: string) => string
  // The text, or undefined when no secret in the list opens it.
  decrypt: (value: string, context: string) => string | undefined
  // A keyed digest, for values that must be compared but never read back, such as where a sign-in came from.
  fingerprint: (text: string) => string
}

// Each use gets its own key derived from the secret, so what one use gives away says nothing of another. A list rotates secrets: the first writes, every one reads.
export function deriveKeys(secret: string | string[]): Keys {
  const secrets = [secret].flat()

  if (weakSecrets(secrets))
    throw new Error(`kayjs-auth: a secret is at least ${MIN_SECRET_LENGTH} characters; generate one with ${GENERATE_SECRET}`)

  const derive = (purpose: string) => secrets.map(value => Buffer.from(hkdfSync('sha256', value, '', `kayjs-auth ${purpose}`, KEY_BYTES)))
  const encryption = derive('encryption')
  const fingerprint = derive('fingerprint')[0]!

  return {
    encrypt: (text, context) => sealWith(encryption[0]!, text, context),
    decrypt: (value, context) => openWith(encryption, value, context)?.text,
    fingerprint: text => createHmac('sha256', fingerprint).update(text).digest('base64url'),
  }
}

// How a random token is stored: a plain digest is enough for a value with this much entropy, and needs no secret to look it up.
export function digest(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}

// 32 random bytes, as URL-safe text.
export function randomToken(): string {
  return randomBytes(32).toString('base64url')
}
