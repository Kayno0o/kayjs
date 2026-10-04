import { Buffer } from 'node:buffer'
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto'

const MIN_SECRET_LENGTH = 32
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

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

  if (secrets.length === 0 || secrets.some(value => value.length < MIN_SECRET_LENGTH))
    throw new Error(`kayjs-auth: a secret is at least ${MIN_SECRET_LENGTH} characters; generate one with \`bun -e "console.log(crypto.randomUUID() + crypto.randomUUID())"\``)

  const derive = (purpose: string) => secrets.map(value => Buffer.from(hkdfSync('sha256', value, '', `kayjs-auth ${purpose}`, KEY_BYTES)))
  const encryption = derive('encryption')
  const fingerprint = derive('fingerprint')[0]!

  return {
    encrypt(text, context) {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv('aes-256-gcm', encryption[0]!, iv)

      cipher.setAAD(Buffer.from(context))
      const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])

      return Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString('base64url')
    },
    decrypt(value, context) {
      const bytes = Buffer.from(value, 'base64url')

      if (bytes.length <= IV_BYTES + TAG_BYTES)
        return undefined

      for (const key of encryption) {
        try {
          const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, IV_BYTES))

          decipher.setAAD(Buffer.from(context))
          decipher.setAuthTag(bytes.subarray(-TAG_BYTES))

          return Buffer.concat([decipher.update(bytes.subarray(IV_BYTES, -TAG_BYTES)), decipher.final()]).toString('utf8')
        }
        // Written with another secret of the list.
        catch {}
      }

      return undefined
    },
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
