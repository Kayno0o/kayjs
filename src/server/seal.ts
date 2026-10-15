import { nodeCrypto } from './builtins'

const IV_BYTES = 12
const TAG_BYTES = 16

export const MIN_SECRET_LENGTH = 32
// What a message refusing a secret tells to run for a new one.
export const GENERATE_SECRET = '`bun -e "console.log(crypto.randomUUID() + crypto.randomUUID())"`'

// Whether a list of secrets, the first writing and every one reading, is empty or holds one too short to resist guessing.
export function weakSecrets(secrets: string[]): boolean {
  return secrets.length === 0 || secrets.some(secret => secret.length < MIN_SECRET_LENGTH)
}

// AES-256-GCM: what it seals can be neither read nor altered without `key`, nor passed off under another `context`, such as another cookie's name or another row.
export function sealWith(key: Uint8Array, text: string, context?: string): string {
  const { createCipheriv, randomBytes } = nodeCrypto()
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)

  if (context !== undefined)
    cipher.setAAD(Buffer.from(context))

  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])

  return Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString('base64url')
}

// The text `sealWith` sealed under one of `keys` and the same `context`, with the index of the key that opened it, or undefined for anything else.
export function openWith(keys: Uint8Array[], value: string, context?: string): { text: string, key: number } | undefined {
  const bytes = Buffer.from(value, 'base64url')

  if (bytes.length <= IV_BYTES + TAG_BYTES)
    return undefined

  const { createDecipheriv } = nodeCrypto()

  for (const [index, key] of keys.entries()) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, IV_BYTES))

      if (context !== undefined)
        decipher.setAAD(Buffer.from(context))

      decipher.setAuthTag(bytes.subarray(-TAG_BYTES))

      return { text: Buffer.concat([decipher.update(bytes.subarray(IV_BYTES, -TAG_BYTES)), decipher.final()]).toString('utf8'), key: index }
    }
    // Sealed with another key, or by something else.
    catch {}
  }

  return undefined
}

// Compares in a time that tells nothing of where two texts differ, as a signature or a code checked against a guess must.
export function sameText(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)

  return a.length === b.length && nodeCrypto().timingSafeEqual(a, b)
}
