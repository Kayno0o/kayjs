// RFC 6238 time-based one-time passwords. SHA-1, 6 digits and 30-second steps are what every authenticator reads from an `otpauth://` URI; several ignore any other algorithm and would show codes that never verify.

import { sameText } from './core'

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const TOTP_DIGITS = 6
const TOTP_PERIOD_SECONDS = 30
// 160 bits, as RFC 4226 recommends.
const SECRET_BYTES = 20
// Steps either side of now that still verify: forgives a clock a few seconds out, at the cost of three live codes, which the attempt limits cap.
const TOTP_WINDOW = 1
const SPACES_AND_PADDING = /[\s=]/g
const NOT_DIGITS = /\D/g

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''

  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8

    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }

  // Unpadded: authenticators accept it, and an `=` is one more character to escape in a URI.
  return bits > 0 ? out + BASE32_ALPHABET[(value << (5 - bits)) & 31] : out
}

// Case and spacing are ignored; anything outside the alphabet decodes to nothing.
export function base32Decode(secret: string): Uint8Array<ArrayBuffer> {
  let bits = 0
  let value = 0
  const out: number[] = []

  for (const char of secret.toUpperCase().replace(SPACES_AND_PADDING, '')) {
    const index = BASE32_ALPHABET.indexOf(char)

    if (index < 0)
      return new Uint8Array()

    value = (value << 5) | index
    bits += 5

    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xFF)
      bits -= 8
    }
  }

  return new Uint8Array(out)
}

// Base32, so it can be typed in as well as scanned.
export function generateTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)))
}

export function totpStep(now = Date.now()): number {
  return Math.floor(now / 1000 / TOTP_PERIOD_SECONDS)
}

export async function totpCode(secret: string, step: number): Promise<string> {
  const cryptoKey = await importKey(secret)

  return cryptoKey ? codeAt(cryptoKey, step) : ''
}

async function importKey(secret: string): Promise<CryptoKey | undefined> {
  const key = base32Decode(secret)

  return key.length === 0 ? undefined : crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
}

async function codeAt(cryptoKey: CryptoKey, step: number): Promise<string> {
  const counter = new Uint8Array(8)

  new DataView(counter.buffer).setBigUint64(0, BigInt(step))

  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, counter))
  // RFC 4226 dynamic truncation: the last byte's low nibble picks which four bytes become the code.
  const offset = signature[signature.length - 1]! & 0x0F
  const binary = ((signature[offset]! & 0x7F) << 24) | (signature[offset + 1]! << 16) | (signature[offset + 2]! << 8) | signature[offset + 3]!

  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0')
}

// The step `code` is valid for, or undefined: the caller records the step so the code on screen cannot be used a second time.
export async function verifyTotp(secret: string, code: string, now = Date.now()): Promise<number | undefined> {
  const digits = code.replace(NOT_DIGITS, '')

  if (digits.length !== TOTP_DIGITS)
    return undefined

  const cryptoKey = await importKey(secret)

  if (!cryptoKey)
    return undefined

  const current = totpStep(now)

  for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset++) {
    if (sameText(await codeAt(cryptoKey, current + offset), digits))
      return current + offset
  }

  return undefined
}

// What an authenticator scans. The label carries the issuer too, for apps that predate the `issuer` parameter.
export function otpauthUri({ secret, account, issuer }: { secret: string, account: string, issuer: string }): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_PERIOD_SECONDS) })

  return `otpauth://totp/${label}?${params}`
}
