// Zero-dependency Bun-native crypto helpers for @kayjs/auth.
// Uses crypto.getRandomValues, Bun.CryptoHasher (SHA-256 / HMAC-SHA256), and Bun.password (Argon2id).

import { safeEqual } from '@kayjs/kay/server'

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return toBase64Url(bytes)
}

export function sha256Hex(value: string): string {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(value)
  return hasher.digest('hex')
}

export function pkceChallenge(verifier: string): string {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(verifier)
  return hasher.digest().toString('base64url')
}


export function signPayload(secret: string, payload: unknown): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const mac = new Bun.CryptoHasher('sha256', secret).update(encoded).digest().toString('base64url')
  return `${encoded}.${mac}`
}

export function verifyPayload<T>(secret: string, token: string): T | undefined {
  const dot = token.indexOf('.')
  if (dot <= 0)
    return undefined
  const encoded = token.slice(0, dot)
  const providedMac = token.slice(dot + 1)
  const expectedMac = new Bun.CryptoHasher('sha256', secret).update(encoded).digest().toString('base64url')
  if (!safeEqual(providedMac, expectedMac))
    return undefined
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as T
  }
  catch {
    return undefined
  }
}

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: 'argon2id', memoryCost: 19456, timeCost: 2 })
}

// Lazily computed dummy Argon2id hash so unknown-email sign-in spends the same CPU time as a real check.
let dummyHashPromise: Promise<string> | undefined
function getDummyHash(): Promise<string> {
  return (dummyHashPromise ??= hashPassword('kay-auth-dummy-timing-shield'))
}

export async function verifyPassword(password: string, storedHash: string | undefined): Promise<boolean> {
  if (!storedHash) {
    await Bun.password.verify(password, await getDummyHash())
    return false
  }
  try {
    return await Bun.password.verify(password, storedHash)
  }
  catch {
    return false
  }
}
